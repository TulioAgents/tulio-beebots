import { signed } from "./BeeColumn";
import { BEE_META } from "./types";
import type { KeeperToast, Toast } from "./useFeed";

const PURPOSE: Record<string, string> = {
  open: "opened",
  add: "added",
  take_profit: "took profit",
  cut_loss: "cut the loss",
  bail: "bailed",
  stop: "stopped out",
  time_stop: "time stop",
  trim: "trimmed half",
  switch_close: "closed to switch",
  loss_stop: "sent home: flattened",
  retired: "retired: flattened",
};

export function Toasts({ toasts, keeper }: { toasts: Toast[]; keeper: KeeperToast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {keeper.map(({ id, entry }) => {
        const meta = BEE_META[entry.bee!];
        return (
          <div key={id} className="toast toast-keeper" style={{ ["--bee" as string]: meta.color, ["--bee-glow" as string]: meta.glow }}>
            <img src="/beekeeper.jpg" alt="" />
            <div className="toast-body">
              <div className="toast-title">The Beekeeper rewrote {meta.title}</div>
              <div className="toast-sub">“{entry.quip}”</div>
            </div>
            <img src={meta.img} alt="" />
          </div>
        );
      })}
      {toasts.map((t) => {
        const meta = BEE_META[t.bee];
        const closing = t.purpose !== "open" && t.purpose !== "add";
        const net = t.realisedUsd - t.feeUsd;
        return (
          <div key={t.id} className="toast" style={{ ["--bee" as string]: meta.color, ["--bee-glow" as string]: meta.glow }}>
            <img src={meta.img} alt="" />
            <div className="toast-body">
              <div className="toast-title">{t.label}</div>
              <div className="toast-sub num">
                {PURPOSE[t.purpose] ?? t.purpose} · {t.contracts} contracts @ {t.px} · fee ${t.feeUsd.toFixed(2)}
              </div>
            </div>
            {closing && <div className={`toast-pnl num ${net >= 0 ? "good" : "bad"}`}>{signed(net)}</div>}
          </div>
        );
      })}
    </div>
  );
}
