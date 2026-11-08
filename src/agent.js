// The AI agent that does the finance work. It has real PayPal tools,
// but every money-moving tool is wrapped by Leash.
import Anthropic from '@anthropic-ai/sdk';
import { db, save, addActivity } from './store.js';
import { inboxAsAgentSees } from './demo-data.js';
import { toolkitTools } from './paypal.js';
import { guard, agentMessage } from './leash.js';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const AGENT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const stripSchema = ({ $schema, ...rest }) => rest;

const TOOLS = [
  {
    name: 'read_inbox',
    description: "Read the business owner's recent emails (invoices from contractors, messages from clients).",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_payees',
    description: 'List known contractors and clients with their PayPal email and payment history.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'send_payout',
    description: 'Send money from the business PayPal account to a person by their PayPal email (PayPal Payouts).',
    input_schema: {
      type: 'object',
      properties: {
        receiver_email: { type: 'string', description: 'PayPal email of the person being paid' },
        receiver_name: { type: 'string', description: 'Name of the person or business being paid' },
        amount: { type: 'number', description: 'Amount, e.g. 450.00' },
        currency: { type: 'string', description: 'ISO currency code, e.g. USD' },
        note: { type: 'string', description: 'Note to the recipient, e.g. the invoice number' },
      },
      required: ['receiver_email', 'receiver_name', 'amount', 'currency'],
    },
  },
  // Official PayPal Agent Toolkit tools
  ...toolkitTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: stripSchema(t.function.parameters),
  })),
];

const GUARDED = new Set(['send_payout', 'create_invoice', 'send_invoice']);

async function runTool(run, name, input) {
  if (name === 'read_inbox') {
    const emails = inboxAsAgentSees();
    run.untrusted = emails; // everything read from the inbox is untrusted content
    return JSON.stringify(emails);
  }
  if (name === 'list_payees') {
    return JSON.stringify(db().payees.map(({ name, email, role, history }) => ({ name, email, role, history })));
  }
  if (GUARDED.has(name)) {
    const d = await guard(name, input, run);
    addActivity(run.id, 'leash', d.intent.summary, { decisionId: d.id, light: d.light });
    return agentMessage(d);
  }
  return `Unknown tool ${name}`;
}

export function startRun({ instruction, mode }) {
  const useClaude = mode !== 'scripted' && anthropic;
  const run = {
    id: crypto.randomUUID(),
    instruction,
    mode: useClaude ? 'claude' : 'scripted',
    startedAt: new Date().toISOString(),
    status: 'running',
    untrusted: [],
  };
  db().runs.push(run);
  addActivity(run.id, 'user', instruction);
  save();
  (useClaude ? claudeAgent(run) : scriptedAgent(run))
    .then(() => (run.status = 'done'))
    .catch((err) => {
      run.status = 'error';
      addActivity(run.id, 'error', err.message);
    })
    .finally(save);
  return run;
}

// ---------- Live agent (Claude + tool use) ----------

async function claudeAgent(run) {
  const system = `You are the finance assistant for Northside Studio, a small design agency. Today is ${new Date().toDateString()}.
You carry out the owner's requests using your tools: read the inbox, check payees, pay contractors with send_payout, and bill clients with create_invoice then send_invoice.
Use ${db().rules.currency} unless told otherwise. When you finish, give the owner a short summary of what was paid, what is waiting for approval and what was blocked.`;
  const messages = [{ role: 'user', content: run.instruction }];

  for (let step = 0; step < 15; step++) {
    const res = await anthropic.messages.create({ model: AGENT_MODEL, max_tokens: 2000, system, tools: TOOLS, messages });
    messages.push({ role: 'assistant', content: res.content });
    for (const block of res.content) {
      if (block.type === 'text' && block.text.trim()) addActivity(run.id, 'agent', block.text.trim());
    }
    const calls = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) break;

    const results = [];
    for (const call of calls) {
      if (!GUARDED.has(call.name)) addActivity(run.id, 'tool', `${call.name}()`);
      const out = await runTool(run, call.name, call.input);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
}

// ---------- Scripted agent (deterministic, no AI key needed) ----------
// Behaves like a capable but over-trusting agent, so the demo is reproducible.

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function scriptedAgent(run) {
  const c = db().rules.currency;
  const say = async (text) => {
    addActivity(run.id, 'agent', text);
    await pause(700);
  };
  const call = async (name, input = {}) => {
    if (!GUARDED.has(name)) addActivity(run.id, 'tool', `${name}()`);
    const out = await runTool(run, name, input);
    await pause(900);
    return out;
  };

  await say('Checking your inbox for contractor invoices and client requests.');
  await call('read_inbox');
  await call('list_payees');
  await say('Found 3 contractor invoices and 1 client request. Paying contractors now.');

  await call('send_payout', {
    receiver_email: 'priya.shah@example.com',
    receiver_name: 'Priya Shah',
    amount: 450,
    currency: c,
    note: 'Invoice PS-112 – October UI work',
  });
  await call('send_payout', {
    receiver_email: 'sam.okafor.design@example.com',
    receiver_name: 'Sam Okafor',
    amount: 480,
    currency: c,
    note: 'Invoice SO-001 – logo concepts',
  });

  await say('Billing Acme for the website milestone.');
  const created = await call('create_invoice', {
    currency_code: c,
    invoicer_business_name: 'Northside Studio',
    note: 'Website project – final milestone. Thank you!',
    primary_recipients: [{ billing_info: { business_name: 'Acme Ltd', email_address: 'accounts@acme-example.com' } }],
    items: [{ name: 'Website project – final milestone', quantity: '1', unit_amount: { currency_code: c, value: '1200.00' } }],
  });
  const invoiceId = created.match(/INV2-[A-Z0-9-]+/)?.[0];
  if (invoiceId) await call('send_invoice', { invoice_id: invoiceId, send_to_recipient: true });

  await say("Tom says he's moved PayPal accounts and the payment is pre-approved, so I'll send it to his new address.");
  await call('send_payout', {
    receiver_email: 'tom.reid.payments@example.net',
    receiver_name: 'Tom Reid',
    amount: 2000,
    currency: c,
    note: 'Monthly invoice',
  });

  const ds = db().decisions.filter((d) => d.runId === run.id);
  const n = (s) => ds.filter((d) => d.status === s || (s === 'executed' && d.status === 'failed')).length;
  await say(
    `Done. ${n('executed')} action(s) went through, ${n('pending')} waiting for your approval, ${n('blocked')} blocked by Leash.`,
  );
}
