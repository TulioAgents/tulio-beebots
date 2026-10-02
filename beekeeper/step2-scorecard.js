// The Beekeeper Zap, step 2: "Scorecard: read all three bees".
// App: Code by Zapier. Event: Run Javascript.
// Input data: hook = the raw body from step 1 (Webhooks by Zapier, Catch Raw Hook).
//
// Your beebots engine starts every round. It sends this Zap its own address (base_url) and a 15-minute key.
// So the Zap holds no secret and no address of its own.
let hook = {};
try { hook = JSON.parse(inputData.hook || '{}'); } catch (e) { hook = {}; }
const base = String(hook.base_url || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) throw new Error('This round came with no base_url. Rounds are started by your beebots engine, not by hand.');
const card = await (await fetch(base + '/keeper/scorecard')).json();
const alert = String(hook.alert || '').trim().slice(0, 300);
output = [{
  scorecard: card.scorecard + (alert ? '\n\nWhy the Beekeeper was called early: ' + alert : ''),
  playbook: card.playbook,
  universe: card.universe,
  open_bees: card.open_bees,
  alert: alert || 'scheduled round',
  source: hook.source || 'manual',
  round: String(hook.round || ''),
  base_url: base,
  key: String(hook.key || ''),
  reply_to: hook.reply_to || '',
  total_pnl_usd: card.total_pnl_usd,
  bee1_pnl_pct: card.bee1_pnl_pct,
  bee2_pnl_pct: card.bee2_pnl_pct,
  bee3_pnl_pct: card.bee3_pnl_pct,
  top_bee_name: card.top_bee_name,
  top_bee_rules: card.top_bee_rules,
  top_bee_coins: card.top_bee_coins
}];
