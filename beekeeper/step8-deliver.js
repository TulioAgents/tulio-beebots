// The Beekeeper Zap, step 8: "Sign and deliver to the lab door".
// App: Code by Zapier. Event: Run Javascript.
// Input data (exact names):
//   rules, idea, coins, reason, note, quip = the fields from step 6 (Opus 5.5)
//   bee, anger                             = Jev's answers from step 3 (bee is bee1, bee2 or bee3)
//   key, base_url, reply_to, scorecard     = from step 2
//
// It signs the new rules with this round's key and posts them to your engine at <base_url>/lab/overlay.
// The key works once, for 15 minutes. The engine only accepts rules text and a coin list.
const crypto = require('crypto');
const key = String(inputData.key || '');
const base = String(inputData.base_url || '').replace(/\/+$/, '');
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const bee = String(inputData.bee || '').trim().toLowerCase();
const coins = String(inputData.coins || '').split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
const level = String(inputData.anger || '').match(/[1-5]/);
const payload = {
  bee,
  rules: clean(inputData.rules, 500),
  coins,
  reason: clean(inputData.reason, 300),
  metrics: { source: 'zapier-beekeeper', anger: level ? Number(level[0]) : 3, idea: clean(inputData.idea, 80), quip: clean(inputData.quip, 160) }
};
const body = JSON.stringify(payload);
const ts = String(Date.now());
let doorStatus = 'skipped: this round came with no key';
let doorReply = '';
if (key && /^https?:\/\//.test(base)) {
  const sig = crypto.createHmac('sha256', key).update(ts + '.POST./lab/overlay.' + body).digest('hex');
  const r = await fetch(base + '/lab/overlay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lab-ts': ts, 'x-lab-sig': sig },
    body
  });
  doorStatus = String(r.status);
  doorReply = (await r.text()).slice(0, 1000);
}
let replyStatus = 'no reply_to in the trigger';
if (inputData.reply_to && /^https:\/\//.test(inputData.reply_to)) {
  const r2 = await fetch(inputData.reply_to, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'beekeeper', bee, idea: payload.metrics.idea, rules: payload.rules, coins, reason: payload.reason, quip: payload.metrics.quip, note: String(inputData.note || ''), door_status: doorStatus })
  });
  replyStatus = String(r2.status);
}
output = [{ ts, body, door_status: doorStatus, door_reply: doorReply, reply_status: replyStatus, note: String(inputData.note || '') }];
