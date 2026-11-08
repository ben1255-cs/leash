import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { db, save, reset, addActivity } from './src/store.js';
import { paypalLive, verifyWebhook } from './src/paypal.js';
import { aiLive, approve, reject, refresh } from './src/leash.js';
import { startRun } from './src/agent.js';
import { inbox, DEFAULT_INSTRUCTION } from './src/demo-data.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));
app.use('/vendor/ag-grid', express.static(path.resolve('node_modules/ag-grid-community/dist')));

// Optional shared password so a public demo can't be abused (set DEMO_PASSWORD).
const PASSWORD = process.env.DEMO_PASSWORD;
app.use('/api', (req, res, next) => {
  if (!PASSWORD || req.method === 'GET') return next();
  if (req.get('x-demo-password') === PASSWORD) return next();
  res.status(401).json({ error: 'Demo password required' });
});

const wrap = (fn) => (req, res) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((err) => res.status(400).json({ error: err.message }));

app.get('/api/state', (req, res) => {
  const s = db();
  res.json({
    config: {
      paypal: paypalLive ? 'sandbox' : 'simulated',
      ai: aiLive ? 'claude' : 'offline',
      passwordRequired: Boolean(PASSWORD),
      defaultInstruction: DEFAULT_INSTRUCTION,
    },
    rules: s.rules,
    payees: s.payees,
    decisions: s.decisions,
    activity: s.activity.slice(-200),
    events: s.events.slice(-50),
    runs: s.runs.map(({ untrusted, ...r }) => r),
  });
});

app.get('/api/inbox', (req, res) => res.json(inbox()));

app.post('/api/agent/run', wrap((req, res) => {
  const instruction = (req.body.instruction || DEFAULT_INSTRUCTION).slice(0, 1000);
  if (db().runs.some((r) => r.status === 'running')) throw new Error('An agent run is already in progress');
  res.json(startRun({ instruction, mode: req.body.mode }));
}));

app.post('/api/decisions/:id/approve', wrap(async (req, res) => res.json(await approve(req.params.id))));
app.post('/api/decisions/:id/reject', wrap((req, res) => res.json(reject(req.params.id))));
app.post('/api/decisions/:id/refresh', wrap(async (req, res) => res.json(await refresh(req.params.id))));

app.put('/api/rules', wrap((req, res) => {
  const r = { ...db().rules };
  for (const k of ['perPaymentCap', 'dailyBudget', 'unusualAmountMultiplier', 'greenBelow', 'redAtOrAbove']) {
    if (req.body[k] !== undefined) r[k] = Number(req.body[k]);
  }
  if (req.body.approveNewPayees !== undefined) r.approveNewPayees = Boolean(req.body.approveNewPayees);
  if (!(r.greenBelow < r.redAtOrAbove)) throw new Error('Green threshold must be below red threshold');
  if (Object.values(r).some((v) => typeof v === 'number' && !Number.isFinite(v))) throw new Error('Rules must be numbers');
  Object.assign(db().rules, r);
  save();
  res.json(r);
}));

app.post('/api/reset', wrap((req, res) => {
  reset();
  res.json({ ok: true });
}));

// PayPal webhooks: payout + invoice outcomes flow back into the audit log.
app.post('/webhooks/paypal', wrap(async (req, res) => {
  const event = req.body;
  const v = await verifyWebhook(req.headers, event).catch((e) => ({ verified: false, reason: e.message }));
  const resource = event.resource || {};
  const batchId = resource.batch_header?.payout_batch_id || resource.payout_batch_id;
  const invoiceId = resource.invoice?.id || resource.id;
  const d = db().decisions.find(
    (x) => (batchId && x.paypal?.payoutBatchId === batchId) || (invoiceId && x.paypal?.invoiceId === invoiceId),
  );
  db().events.push({
    id: event.id,
    at: new Date().toISOString(),
    type: event.event_type,
    summary: event.summary,
    verified: v.verified,
    decisionId: d?.id || null,
  });
  if (d) {
    d.paypal.lastEvent = event.event_type;
    addActivity(d.runId, 'paypal', `PayPal confirmed: ${event.event_type} for "${d.intent.summary}"`);
  }
  save();
  res.json({ received: true });
}));

app.get('/healthz', (req, res) => res.send('ok'));

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`Leash running on http://localhost:${port}  (PayPal: ${paypalLive ? 'sandbox' : 'simulated'}, AI: ${aiLive ? 'Claude' : 'offline'})`),
);
