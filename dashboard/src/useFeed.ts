import { useEffect, useReducer, useRef } from "react";
import { playOrder } from "./sound";
import { applyProfile, type AnyEvent, type BeeName, type CapEvent, type DecisionEvent, type FillEvent, type FundingEvent, type KeeperEntry, type KeeperEvent, type Profile, type PublicBee, type Snapshot } from "./types";

const MAX_DECISIONS = 60;
const MAX_POINTS = 1500;
const CURVE_STEP_MS = 10_000;

export type Curve = Array<[number, number]>;

export interface Toast extends FillEvent {
  id: number;
}

export interface KeeperToast {
  id: number;
  entry: KeeperEntry;
}

export interface FeedState {
  snap: Snapshot | null;
  bees: Partial<Record<BeeName, PublicBee>>;
  curves: Partial<Record<BeeName, Curve>>;
  decisions: DecisionEvent[];
  toasts: Toast[];
  /** The Beekeeper just rewrote a bee: one big card, like an order card. */
  keeperToasts: KeeperToast[];
  flashes: Partial<Record<BeeName, { kind: "fill" | "funding" | "cap" | "keeper"; at: number; text: string }>>;
  connected: boolean;
  lastEventAt: number;
  decisionTimes: number[];
}

type Action =
  | { t: "snap"; snap: Snapshot }
  | { t: "curves"; curves: Partial<Record<BeeName, Curve>> }
  | { t: "history"; events: AnyEvent[] }
  | { t: "event"; ev: AnyEvent }
  | { t: "connected"; on: boolean }
  | { t: "expire"; now: number };

let toastId = 0;

function appendPoint(curve: Curve | undefined, ts: number, eq: number): Curve {
  const c = curve ? [...curve] : [];
  const last = c[c.length - 1];
  if (last && ts - last[0] < CURVE_STEP_MS && c.length > 1) c[c.length - 1] = [ts, eq];
  else c.push([ts, eq]);
  if (c.length > MAX_POINTS) return c.filter((_, i) => i % 2 === 0 || i === c.length - 1);
  return c;
}

function reduce(s: FeedState, a: Action): FeedState {
  switch (a.t) {
    case "snap": {
      const bees = { ...s.bees };
      for (const b of a.snap.bees) bees[b.bee] = b;
      return { ...s, snap: a.snap, bees };
    }
    case "curves":
      return { ...s, curves: { ...a.curves } };
    case "history": {
      const decisions = a.events.filter((e): e is DecisionEvent => e.type === "decision").reverse().slice(0, MAX_DECISIONS);
      return { ...s, decisions };
    }
    case "connected":
      return { ...s, connected: a.on };
    case "expire": {
      const toasts = s.toasts.filter((t) => a.now - t.id < 7000);
      const keeperToasts = s.keeperToasts.filter((t) => a.now - t.id < 9000);
      const decisionTimes = s.decisionTimes.filter((t) => a.now - t < 60_000);
      return toasts.length === s.toasts.length && keeperToasts.length === s.keeperToasts.length && decisionTimes.length === s.decisionTimes.length ? s : { ...s, toasts, keeperToasts, decisionTimes };
    }
    case "event": {
      const ev = a.ev;
      const now = Date.now();
      const base = { ...s, lastEventAt: now };
      switch (ev.type) {
        case "decision":
          return { ...base, decisions: [ev, ...s.decisions].slice(0, MAX_DECISIONS), decisionTimes: [...s.decisionTimes, now] };
        case "equity": {
          const bees = { ...s.bees };
          const curves = { ...s.curves };
          for (const b of ev.bees) {
            bees[b.bee] = b;
            curves[b.bee] = appendPoint(curves[b.bee], ev.ts, b.equityUsd);
          }
          return { ...base, bees, curves };
        }
        case "fill": {
          const f = ev as FillEvent;
          toastId = Math.max(toastId + 1, now);
          return {
            ...base,
            toasts: [...s.toasts, { ...f, id: toastId }].slice(-3),
            flashes: { ...s.flashes, [f.bee]: { kind: "fill", at: now, text: f.label } },
          };
        }
        case "funding": {
          const f = ev as FundingEvent;
          return { ...base, flashes: { ...s.flashes, [f.bee]: { kind: "funding", at: now, text: `funding ${f.amountUsd >= 0 ? "+" : "−"}$${Math.abs(f.amountUsd).toFixed(4)}` } } };
        }
        case "cap": {
          const c = ev as CapEvent;
          return { ...base, flashes: { ...s.flashes, [c.bee]: { kind: "cap", at: now, text: c.detail } } };
        }
        case "keeper": {
          // The card itself follows /snapshot; the event makes it land at once instead of on the next 5 s poll.
          const e = (ev as KeeperEvent).entry;
          if (!e || typeof e.id !== "number") return base;
          const k = s.snap?.keeper;
          const snap = s.snap && k ? { ...s.snap, keeper: { ...k, entries: [e, ...k.entries.filter((x) => x.id !== e.id)].sort((x, y) => y.id - x.id).slice(0, 12) } } : s.snap;
          if (e.action !== "rewrote" || !e.bee) return { ...base, snap };
          toastId = Math.max(toastId + 1, now);
          return { ...base, snap, keeperToasts: [...s.keeperToasts, { id: toastId, entry: e }].slice(-2), flashes: { ...s.flashes, [e.bee]: { kind: "keeper", at: now, text: e.idea ?? "new rules" } } };
        }
        case "recon":
          return s.snap ? { ...base, snap: { ...s.snap, recon: { ok: ev.ok as boolean, detail: ev.detail as string, ts: ev.ts } } } : base;
        default:
          return base;
      }
    }
  }
}

const initial: FeedState = { snap: null, bees: {}, curves: {}, decisions: [], toasts: [], keeperToasts: [], flashes: {}, connected: false, lastEventAt: 0, decisionTimes: [] };

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}

export function useFeed(soundOn: boolean): FeedState {
  const [state, dispatch] = useReducer(reduce, initial);
  const sound = useRef(soundOn);
  sound.current = soundOn;

  useEffect(() => {
    let alive = true;
    const loadSnap = () => getJson<Snapshot>("/snapshot").then((snap) => alive && dispatch({ t: "snap", snap })).catch(() => {});
    const loadCurves = () => getJson<Partial<Record<BeeName, Curve>>>("/equity?days=30").then((curves) => alive && dispatch({ t: "curves", curves })).catch(() => {});

    // Hit counter: one call per page load; the engine dedupes per visitor per day and stores no IPs.
    getJson<{ total: number; watching: number }>("/visit").then(() => loadSnap()).catch(() => {});
    void loadSnap();
    void loadCurves();
    getJson<AnyEvent[]>("/history?n=400").then((events) => alive && dispatch({ t: "history", events })).catch(() => {});

    const es = new EventSource("/events");
    es.onopen = () => {
      dispatch({ t: "connected", on: true });
      void loadSnap();
    };
    es.onerror = () => dispatch({ t: "connected", on: false });
    es.onmessage = (m) => {
      let ev: AnyEvent;
      try {
        ev = JSON.parse(m.data) as AnyEvent;
      } catch {
        return;
      }
      dispatch({ t: "event", ev });
      if (ev.type === "keeper") {
        const action = (ev as KeeperEvent).entry?.action;
        if (action === "rewrote" && sound.current) playOrder("open");
        // A bee's rules just changed (rewritten, or put back): fetch them again so its column shows the ones it is on.
        if (action === "rewrote" || action === "rolled_back") {
          void getJson<Profile>("/profile")
            .then((p) => alive && !p.setup && applyProfile(p))
            .catch(() => {});
        }
      }
      if (ev.type === "fill" && sound.current) {
        const f = ev as FillEvent;
        const closing = f.purpose !== "open" && f.purpose !== "add";
        playOrder(!closing ? "open" : f.realisedUsd - f.feeUsd >= 0 ? "win" : "loss");
      }
    };

    // Dev only: /?demo-toast previews an order card + sound without waiting for a real fill.
    const demoTimers: ReturnType<typeof setTimeout>[] = [];
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo-toast")) {
      const demo = (bee: FillEvent["bee"], label: string, purpose: string, realisedUsd: number, delay: number) =>
        demoTimers.push(setTimeout(() => dispatch({ t: "event", ev: { type: "fill", ts: Date.now(), bee, coin: "X", side: "buy", purpose, contracts: 60, px: 66.41, notionalUsd: 220, feeUsd: 0.11, realisedUsd, label } }), delay));
      demo("bee3", "Boozy LONG RAY $220", "open", 0, 1500);
      demo("bee1", "Bizzy CLOSE ETH $265", "take_profit", 1.42, 2600);
    }

    const snapTimer = setInterval(loadSnap, 5000);
    const curveTimer = setInterval(loadCurves, 5 * 60_000);
    const expireTimer = setInterval(() => dispatch({ t: "expire", now: Date.now() }), 500);
    return () => {
      alive = false;
      es.close();
      clearInterval(snapTimer);
      clearInterval(curveTimer);
      clearInterval(expireTimer);
      demoTimers.forEach(clearTimeout);
    };
  }, []);

  return state;
}
