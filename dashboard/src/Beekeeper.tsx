// The Beekeeper card: an outside coach (a Zap on Zapier: Jev picks the bee, Claude Opus 5.5 writes the rules) that
// looks at all three bees every round and may rewrite one bee's rules. The engine records every round (src/keeper.ts)
// and serves the last few in /snapshot.keeper; live changes also arrive on the feed as "keeper" events.
// Off: a short pitch and the "Connect the Beekeeper" form. On: the rounds, plus the owner's controls.
// Every write carries the owner password picked on Setup, exactly as joining the Hive does.
import { useState, type FormEvent } from "react";
import { BEE_META, PROFILE, type BeeName, type KeeperEntry, type KeeperState } from "./types";

/** The shared Zap: anyone can copy it and point it at their own hive. */
export const KEEPER_ZAP_URL = "https://mrc.fm/beekeeper";
const REPO = "https://github.com/imikerussell/beebots";

/** Claude mark: path from Simple Icons (slug "claude", CC0 path data). Brand colour #D97757. */
function ClaudeMark() {
  return (
    <svg className="keeper-mark" viewBox="0 0 24 24" role="img" aria-label="Claude">
      <path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/** Zapier mark: path from Simple Icons (slug "zapier", CC0 path data). Brand colour #FF4F00. */
function ZapierMark() {
  return (
    <svg className="keeper-mark" viewBox="0 0 24 24" role="img" aria-label="Zapier">
      <path fill="#FF4F00" d="M4.157 0A4.151 4.151 0 0 0 0 4.161v15.678A4.151 4.151 0 0 0 4.157 24h15.682A4.152 4.152 0 0 0 24 19.839V4.161A4.152 4.152 0 0 0 19.839 0H4.157Zm10.61 8.761h.03a.577.577 0 0 1 .23.038.585.585 0 0 1 .201.124.63.63 0 0 1 .162.431.612.612 0 0 1-.162.435.58.58 0 0 1-.201.128.58.58 0 0 1-.23.042.529.529 0 0 1-.235-.042.585.585 0 0 1-.332-.328.559.559 0 0 1-.038-.235.613.613 0 0 1 .17-.431.59.59 0 0 1 .405-.162Zm2.853 1.572c.03.004.061.004.095.004.325-.011.646.064.937.219.238.144.431.355.552.609.128.279.189.582.185.888v.193a2 2 0 0 1 0 .219h-2.498c.003.227.075.45.204.642a.78.78 0 0 0 .646.265.714.714 0 0 0 .484-.136.642.642 0 0 0 .23-.318l.915.257a1.398 1.398 0 0 1-.28.537c-.14.159-.321.284-.521.355a2.234 2.234 0 0 1-.836.136 1.923 1.923 0 0 1-1.001-.245 1.618 1.618 0 0 1-.665-.703 2.221 2.221 0 0 1-.227-1.036 1.95 1.95 0 0 1 .48-1.398 1.9 1.9 0 0 1 1.3-.488Zm-9.607.023c.162.004.325.026.48.079.207.065.4.174.563.314.26.302.393.692.366 1.088v2.276H8.53l-.109-.711h-.065c-.064.163-.155.31-.272.439a1.122 1.122 0 0 1-.374.264 1.023 1.023 0 0 1-.453.083 1.334 1.334 0 0 1-.866-.264.965.965 0 0 1-.329-.801.993.993 0 0 1 .076-.431 1.02 1.02 0 0 1 .242-.363 1.478 1.478 0 0 1 1.043-.303h.952v-.181a.696.696 0 0 0-.136-.454.553.553 0 0 0-.438-.154.695.695 0 0 0-.378.086.48.48 0 0 0-.193.254l-.99-.144a1.26 1.26 0 0 1 .257-.563c.14-.174.321-.302.533-.378.261-.091.54-.136.82-.129.053-.003.106-.007.163-.007Zm4.384.007c.174 0 .347.038.506.114.182.083.34.211.458.374.257.423.377.911.351 1.406a2.53 2.53 0 0 1-.355 1.448 1.148 1.148 0 0 1-1.009.517c-.204 0-.401-.045-.582-.136a1.052 1.052 0 0 1-.48-.457 1.298 1.298 0 0 1-.114-.234h-.045l.004 1.784h-1.059v-4.713h.904l.117.805h.057c.068-.208.177-.401.328-.56a1.129 1.129 0 0 1 .843-.344h.076v-.004Zm7.559.084h.903l.113.805h.053a1.37 1.37 0 0 1 .235-.484.813.813 0 0 1 .313-.242.82.82 0 0 1 .39-.076h.234v1.051h-.401a.662.662 0 0 0-.313.008.623.623 0 0 0-.272.155.663.663 0 0 0-.174.26.683.683 0 0 0-.027.314v1.875h-1.054v-3.666Zm-17.515.003h3.262v.896L3.73 13.104l.034.113h1.973l.042.9H2.4v-.9l1.931-1.754-.045-.117H2.441v-.896Zm11.815 0h1.055v3.659h-1.055V10.45Zm3.443.684.019.016a.69.69 0 0 0-.351.045.756.756 0 0 0-.287.204c-.11.155-.174.336-.189.522h1.545c-.034-.526-.257-.787-.74-.787h.003Zm-5.718.163c-.026 0-.057 0-.083.004a.78.78 0 0 0-.31.053.746.746 0 0 0-.257.189 1.016 1.016 0 0 0-.204.695v.064c-.015.257.057.507.204.711a.634.634 0 0 0 .253.196.638.638 0 0 0 .314.061.644.644 0 0 0 .578-.265c.14-.223.204-.48.189-.74a1.216 1.216 0 0 0-.181-.711.677.677 0 0 0-.503-.257Zm-4.509 1.266a.464.464 0 0 0-.268.102.373.373 0 0 0-.114.276c0 .053.008.106.027.155a.375.375 0 0 0 .087.132.576.576 0 0 0 .397.11v.004a.863.863 0 0 0 .563-.182.573.573 0 0 0 .211-.457v-.14h-.903Z" />
    </svg>
  );
}

export function ago(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function until(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.ceil((ts - now) / 60_000));
  if (m < 1) return "any moment";
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)} h ${m % 60} min`;
}

const VERB: Record<KeeperEntry["action"], string> = {
  calling: "On his rounds",
  rewrote: "Rewrote",
  quiet: "Left them alone",
  skipped: "Hands off",
  refused: "Bounced",
  failed: "No answer",
  rolled_back: "Rolled back",
};

/** The bee a round was about, or the Beekeeper himself for a round that touched nobody. */
function Who({ bee, big }: { bee: BeeName | null; big?: boolean }) {
  const meta = bee ? BEE_META[bee] : null;
  return (
    <img
      className={`keeper-who ${big ? "big" : ""} ${meta ? "" : "nobody"}`}
      src={meta ? meta.img : "/beekeeper.jpg"}
      alt={meta ? meta.title : "nobody"}
      title={meta ? meta.title : "No bee was rewritten"}
      style={meta ? { ["--bee" as string]: meta.color } : undefined}
    />
  );
}

function meta(e: KeeperEntry): string {
  const who = e.bee ? BEE_META[e.bee].short : null;
  const head = e.action === "rewrote" || e.action === "rolled_back" || e.action === "refused" ? `${VERB[e.action]}${who ? ` ${who}` : ""}` : VERB[e.action];
  return e.idea ? `${head} · ${e.idea}` : head;
}

/**
 * The entries whose rewrite is the one its bee trades on right now, so "Undo" belongs next to them. A replay of the
 * list, oldest first: a rewrite goes on top of its bee's pile, a rollback takes the top one off.
 */
export function undoable(entries: KeeperEntry[]): Set<number> {
  const piles: Partial<Record<BeeName, number[]>> = {};
  for (const e of [...entries].sort((a, b) => a.id - b.id)) {
    if (!e.bee) continue;
    const pile = (piles[e.bee] ??= []);
    if (e.action === "rewrote") pile.push(e.id);
    else if (e.action === "rolled_back") pile.pop();
  }
  const live = new Set<number>();
  for (const pile of Object.values(piles)) {
    const top = pile?.[pile.length - 1];
    if (top !== undefined) live.add(top);
  }
  return live;
}

type OwnerAction = { kind: "round" } | { kind: "disconnect" } | { kind: "undo"; bee: BeeName };
const ACTION: Record<OwnerAction["kind"], { path: string; go: string; busy: string }> = {
  round: { path: "/keeper/round", go: "Call him now", busy: "Calling…" },
  disconnect: { path: "/keeper/disconnect", go: "Disconnect", busy: "Disconnecting…" },
  undo: { path: "/keeper/rollback", go: "Undo", busy: "Undoing…" },
};

/** One owner write. The password travels URI-encoded in a header, the same way the Hive's join and leave send it. */
async function ownerPost(path: string, password: string, body: unknown): Promise<KeeperState> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-owner-password": encodeURIComponent(password) }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { keeper?: KeeperState; error?: string };
  if (!r.ok || !j.keeper) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j.keeper;
}

export function Beekeeper({ keeper }: { keeper: KeeperState | undefined }) {
  // What the engine answered to this page's own last write, shown until the next /snapshot poll catches up.
  const [mine, setMine] = useState<{ at: number; state: KeeperState } | null>(null);
  const [hookUrl, setHookUrl] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<OwnerAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ahead = mine && Date.now() - mine.at < 6000 && (!keeper || mine.state.on !== keeper.on || (mine.state.entries[0]?.id ?? 0) > (keeper.entries[0]?.id ?? 0));
  const k = ahead ? mine.state : keeper;
  // An engine from before the Beekeeper has no such block: no card.
  if (!k) return null;

  const entries = k.entries;
  const [latest, ...rest] = entries;
  const fresh = latest && latest.action === "rewrote" && Date.now() - latest.at < 15_000;
  const canUndo = undoable(entries);
  const passwordOk = password.length >= 8;

  const run = async (path: string, body: unknown) => {
    setBusy(true);
    setError("");
    try {
      setMine({ at: Date.now(), state: await ownerPost(path, password, body) });
      setPending(null);
      setHookUrl("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = (e: FormEvent) => {
    e.preventDefault();
    // This page's own address is where the Zap will find the engine: the owner never has to type it.
    if (passwordOk && hookUrl.trim() && !busy) void run("/keeper/connect", { hookUrl: hookUrl.trim(), publicUrl: location.origin });
  };
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    if (pending && passwordOk && !busy) void run(ACTION[pending.kind].path, pending.kind === "undo" ? { bee: pending.bee } : {});
  };
  const ask = (a: OwnerAction) => {
    setError("");
    setPending(a);
  };
  const undoButton = (e: KeeperEntry) =>
    e.bee && canUndo.has(e.id) ? (
      <button type="button" className="keeper-undo" title={`Put ${BEE_META[e.bee].short} back on the rules from before this rewrite (owner password)`} onClick={() => ask({ kind: "undo", bee: e.bee! })}>
        Undo
      </button>
    ) : null;

  return (
    <section className={`rail-card keeper ${fresh ? "keeper-fresh" : ""}`}>
      <div className="keeper-head">
        <img className="keeper-face" src="/beekeeper.jpg" alt="" />
        <div className="keeper-title">
          <span className="eyebrow keeper-eyebrow">The Beekeeper</span>
          <span className="keeper-sub dim">
            {k.on ? `checks all three bees every ${k.everyHours} h · ${k.rewrites} ${k.rewrites === 1 ? "rewrite" : "rewrites"} so far` : "rewrites a bee's rules when they stop working"}
          </span>
        </div>
        {k.on && k.nextRoundAt !== null && (
          <div className="keeper-next num">
            <span className="dim">next round</span>
            <b>{latest?.action === "calling" ? "now" : until(k.nextRoundAt)}</b>
          </div>
        )}
      </div>

      {!k.on && (
        <form className="keeper-connect" onSubmit={connect}>
          <p className="keeper-pitch">
            An outside coach for your bees. Every few hours he looks at all three. If one keeps losing because its rules are wrong, he writes it new ones. He runs as a Zap on
            Zapier, and he can only change a bee's rules and coins.{" "}
            <a href={`${PROFILE.links?.code ?? REPO}/blob/main/docs/BEEKEEPER.md`} target="_blank" rel="noopener">
              How to set him up ↗
            </a>
          </p>
          <label className="keeper-label" htmlFor="keeper-hook">
            Connect the Beekeeper
          </label>
          <input id="keeper-hook" className="keeper-input" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="Catch Hook URL from step 1 of your Zap" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
          <div className="keeper-form-row">
            <input className="keeper-input" type="password" autoComplete="current-password" placeholder="Owner password" aria-label="Owner password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="submit" className="keeper-go" disabled={busy || !passwordOk || !hookUrl.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
          {error && !pending && <p className="keeper-error bad">{error}</p>}
        </form>
      )}

      {latest ? (
        <div className={`keeper-latest keeper-${latest.action}`} style={latest.bee ? { ["--bee" as string]: BEE_META[latest.bee].color } : undefined}>
          <Who bee={latest.bee} big />
          <div className="keeper-latest-body">
            <div className="keeper-quip">“{latest.quip}”</div>
            <div className="keeper-meta">
              <span className="keeper-verb">{meta(latest)}</span>
              <span className="dim num keeper-when">
                {ago(latest.at)}
                {undoButton(latest)}
              </span>
            </div>
            {latest.action === "rewrote" && latest.reason && <div className="keeper-reason dim">{latest.reason}</div>}
          </div>
        </div>
      ) : (
        k.on && <div className="keeper-empty dim">No rounds yet. He's putting his gloves on.</div>
      )}

      {rest.length > 0 && (
        <ol className="keeper-log">
          {rest.map((e) => (
            <li key={e.id} className={`keeper-row keeper-${e.action} ${canUndo.has(e.id) ? "keeper-live" : ""}`} title={`${meta(e)}${e.reason ? `: ${e.reason}` : ""}`}>
              <Who bee={e.bee} />
              <span className="keeper-row-quip">{e.quip}</span>
              <span className="dim num keeper-row-ago">
                {ago(e.at)}
                {undoButton(e)}
              </span>
            </li>
          ))}
        </ol>
      )}

      {k.on && !pending && (
        <div className="keeper-owner">
          <span className="dim">Owner:</span>
          <button type="button" className="keeper-link" onClick={() => ask({ kind: "round" })}>
            Call him now
          </button>
          <button type="button" className="keeper-link" onClick={() => ask({ kind: "disconnect" })}>
            Disconnect
          </button>
        </div>
      )}
      {pending && (
        <form className="keeper-confirm" onSubmit={confirm}>
          <span className="keeper-confirm-what">
            {pending.kind === "undo" ? `Undo the Beekeeper's latest rewrite of ${BEE_META[pending.bee].short}?` : pending.kind === "round" ? "Start a round now?" : "Disconnect the Beekeeper? Rewrites stay until you undo them."}
          </span>
          <div className="keeper-form-row">
            <input className="keeper-input" type="password" autoComplete="current-password" placeholder="Owner password" aria-label="Owner password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <button type="submit" className={`keeper-go ${pending.kind === "round" ? "" : "danger"}`} disabled={busy || !passwordOk}>
              {busy ? ACTION[pending.kind].busy : ACTION[pending.kind].go}
            </button>
            <button type="button" className="keeper-link" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
          {error && <p className="keeper-error bad">{error}</p>}
        </form>
      )}

      <a className="keeper-foot" href={KEEPER_ZAP_URL} target="_blank" rel="noopener" title="Copy the Beekeeper Zap for your own hive">
        Powered by <ClaudeMark /> <b>Opus 5.5</b> on <ZapierMark /> <b>Zapier</b> <span aria-hidden>↗</span>
      </a>
    </section>
  );
}
