import { memo } from "react";
import { money, px, signed } from "./BeeColumn";
import { PURPOSE } from "./Toasts";
import { BEE_META, BEE_NAMES, type BeeName, type FillEvent, type PublicBee } from "./types";

export interface Trade {
  key: string;
  bee: BeeName;
  coin: string;
  side: "long" | "short";
  entryPx: number | null;
  entryTs: number;
  exitPx: number | null;
  exitTs: number | null;
  /** Everything put in, adds included. null: the engine could not value the position this tick. */
  notionalUsd: number | null;
  /** Every fee this trade paid, opening and closing. null: the opening fill has left the /history window. */
  feeUsd: number | null;
  realisedUsd: number;
  /** The closing fill's purpose ("take_profit", "stop", ...); null while open. */
  reason: string | null;
  adds: number;
  open: boolean;
}

/**
 * Pairs the fill stream into trades: an "open" starts one, "add" grows it, anything else closes it
 * ("trim" is a partial, so the trade stays open). /history is capped, so a close whose open has
 * already scrolled out of the window is kept as its own row rather than dropped.
 */
export function buildTrades(fills: FillEvent[]): Trade[] {
  const live = new Map<BeeName, Trade>();
  const done: Trade[] = [];

  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    const cur = live.get(f.bee);

    if (f.purpose === "open" || (!cur && f.purpose === "add")) {
      live.set(f.bee, {
        key: `${f.bee}-${f.ts}`,
        bee: f.bee,
        coin: f.coin,
        side: f.side === "buy" ? "long" : "short",
        entryPx: f.px,
        entryTs: f.ts,
        exitPx: null,
        exitTs: null,
        notionalUsd: f.notionalUsd,
        feeUsd: f.feeUsd,
        realisedUsd: 0,
        reason: null,
        adds: 0,
        open: true,
      });
      continue;
    }

    if (!cur) {
      done.push({
        key: `${f.bee}-${f.ts}`,
        bee: f.bee,
        coin: f.coin,
        side: f.side === "buy" ? "short" : "long",
        entryPx: null,
        entryTs: f.ts,
        exitPx: f.px,
        exitTs: f.ts,
        notionalUsd: f.notionalUsd,
        feeUsd: f.feeUsd,
        realisedUsd: f.realisedUsd,
        reason: f.purpose,
        adds: 0,
        open: false,
      });
      continue;
    }

    if (f.purpose === "add") {
      cur.notionalUsd = (cur.notionalUsd ?? 0) + f.notionalUsd;
      cur.feeUsd = (cur.feeUsd ?? 0) + f.feeUsd;
      cur.adds++;
      continue;
    }

    cur.feeUsd = (cur.feeUsd ?? 0) + f.feeUsd;
    cur.realisedUsd += f.realisedUsd;
    cur.exitPx = f.px;
    cur.exitTs = f.ts;
    cur.reason = f.purpose;
    if (f.purpose === "trim") continue;
    cur.open = false;
    done.push(cur);
    live.delete(f.bee);
  }

  done.sort((a, b) => (b.exitTs ?? b.entryTs) - (a.exitTs ?? a.entryTs));
  return [...[...live.values()].sort((a, b) => b.entryTs - a.entryTs), ...done];
}

/**
 * /history is capped, so after a few hundred decisions a still-open position's opening fill scrolls out
 * and buildTrades can no longer see it. The snapshot always carries the live position, so any bee holding
 * one that the fill stream no longer covers gets its row from there instead (fees unknown: they were in
 * the fill).
 */
export function withOpenPositions(trades: Trade[], bees: Partial<Record<BeeName, PublicBee>>, now: number): Trade[] {
  const covered = new Set(trades.filter((t) => t.open).map((t) => t.bee));
  const fromSnapshot: Trade[] = [];

  for (const name of BEE_NAMES) {
    const p = bees[name]?.position;
    if (!p || covered.has(name)) continue;
    fromSnapshot.push({
      key: `${name}-live`,
      bee: name,
      coin: p.coin,
      side: p.side,
      entryPx: p.entryPx,
      entryTs: now - p.minutesHeld * 60_000,
      exitPx: null,
      exitTs: null,
      notionalUsd: p.sizeUsd,
      feeUsd: null,
      realisedUsd: 0,
      reason: null,
      adds: 0,
      open: true,
    });
  }

  if (fromSnapshot.length === 0) return trades;
  const open = [...trades.filter((t) => t.open), ...fromSnapshot].sort((a, b) => b.entryTs - a.entryTs);
  return [...open, ...trades.filter((t) => !t.open)];
}

/** A column heading with a hover/focus explanation, for anyone meeting these words for the first time. */
function Th({ label, tip, className }: { label: string; tip: string; className?: string }) {
  return (
    <span className={`th ${className ?? ""}`} data-tip={tip} tabIndex={0} role="note" aria-label={`${label}: ${tip}`}>
      {label}
    </span>
  );
}

const held = (from: number, to: number) => {
  const m = Math.max(0, Math.round((to - from) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

const Row = memo(function Row({ t, bee, now }: { t: Trade; bee: PublicBee | undefined; now: number }) {
  const meta = BEE_META[t.bee];
  // Open trade: the live mark and unrealised P&L come from the snapshot, not the fill stream.
  const p = t.open && bee?.position?.coin === t.coin ? bee.position : null;
  // An open trade that has been trimmed has already banked some profit: count it alongside what is still unrealised.
  const gross = t.open ? (p?.uplUsd ?? 0) + t.realisedUsd : t.realisedUsd;
  const net = gross - (t.feeUsd ?? 0);

  return (
    <li className={`trade ${t.open ? "live" : ""}`} style={{ ["--bee" as string]: meta.color }}>
      <span className="trade-bee">
        <span className="trade-dot" />
        {meta.short}
      </span>
      <span className={`side ${t.side}`}>{t.side === "long" ? "▲ LONG" : "▼ SHORT"}</span>
      <span className="pos-coin trade-coin">{t.coin}</span>
      <span className="trade-size num">{t.notionalUsd === null ? "–" : money(t.notionalUsd, 0)}</span>
      <span className="trade-px num dim">
        {px(t.entryPx)} → {px(t.open ? (p?.markPx ?? null) : t.exitPx)}
      </span>
      <span className="trade-held num dim">{held(t.entryTs, t.open ? now : (t.exitTs ?? now))}</span>
      <span className="trade-why">
        {t.open ? <span className="trade-badge">OPEN</span> : (PURPOSE[t.reason ?? ""] ?? t.reason)}
        {t.open && t.reason && <span className="dim"> · {PURPOSE[t.reason] ?? t.reason}</span>}
        {t.adds > 0 && <span className="dim"> · {t.adds} add{t.adds > 1 ? "s" : ""}</span>}
      </span>
      <span className="trade-fee num dim">{t.feeUsd === null ? "– fee" : `−${money(t.feeUsd, 2)} fee`}</span>
      <span className={`trade-net num ${net >= 0 ? "good" : "bad"}`}>{signed(net)}</span>
    </li>
  );
});

export function Trades({ trades, bees, now }: { trades: Trade[]; bees: Partial<Record<BeeName, PublicBee>>; now: number }) {
  const rows = withOpenPositions(trades, bees, now);
  const closed = rows.filter((t) => !t.open);
  const realised = closed.reduce((s, t) => s + t.realisedUsd - (t.feeUsd ?? 0), 0);

  return (
    <section className="rail-card trades">
      <div className="rail-head">
        <span className="eyebrow">Positions &amp; trades</span>
        <span className="num dim">
          {rows.filter((t) => t.open).length} open · {closed.length} closed
          {closed.length > 0 && (
            <>
              {" · realised "}
              <span className={realised >= 0 ? "good" : "bad"}>{signed(realised)}</span>
            </>
          )}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="trades-empty dim">No trades yet. Rows appear here the moment a bee opens a position.</p>
      ) : (
        <>
          <div className="trade-headings">
            <Th label="Bee" tip="Which bee opened the trade." />
            <Th label="Side" tip="LONG makes money when the price goes up, SHORT when it goes down." />
            <Th label="Coin" tip="The OKX X-Perp contract being traded." />
            <Th
              label="$ in coin"
              className="trade-size"
              tip="How many dollars of the coin the bee is holding. Buying swaps cash for coins, so this does not reduce its equity - but a 1% price move changes its money by 1% of this number."
            />
            <Th label="Price in → now" tip="The price it bought at, then the live price while the trade is open, or the price it sold at once closed." />
            <Th label="Time open" tip="How long the bee has held this position." />
            <Th label="Status" tip="OPEN while the bee still holds it. Once closed, why it closed: took profit, stopped out, cut the loss, closed to switch." />
            <Th label="Fees" className="trade-fee" tip="The 0.05% taker fee, paid on the way in and again on the way out. A dash means the opening fill is older than the dashboard's history window, so the fee is not known here." />
            <Th
              label="Profit / loss"
              className="trade-net"
              tip="What the trade is worth after fees. While it is OPEN this is unrealised - it moves with every price tick and only becomes real money when the position closes."
            />
          </div>
          <ol className="trade-list">
            {rows.map((t) => (
              <Row key={t.key} t={t} bee={bees[t.bee]} now={now} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
