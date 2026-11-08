// PayPal sandbox integration.
//  - Invoicing goes through the official PayPal Agent Toolkit (@paypal/agent-toolkit).
//  - Payouts use the PayPal Payouts REST API directly (the toolkit has no payouts tool yet).
// If no sandbox credentials are configured, calls are simulated so the app still runs.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PayPalAgentToolkit } = require('@paypal/agent-toolkit/openai');

const BASE = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

export const paypalLive = Boolean(CLIENT_ID && CLIENT_SECRET);

export const toolkit = new PayPalAgentToolkit({
  clientId: CLIENT_ID || 'simulated',
  clientSecret: CLIENT_SECRET || 'simulated',
  configuration: {
    actions: { invoices: { create: true, send: true, list: true, get: true } },
    context: { sandbox: true },
  },
});

// Official toolkit tool definitions (OpenAI format) for the invoice actions we expose to the agent.
export const toolkitTools = toolkit
  .getTools()
  .filter((t) => ['create_invoice', 'send_invoice'].includes(t.function.name));

let token = null;
let tokenExpires = 0;
async function accessToken() {
  if (token && Date.now() < tokenExpires) return token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  token = json.access_token;
  tokenExpires = Date.now() + (json.expires_in - 60) * 1000;
  return token;
}

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`PayPal ${method} ${pathname} failed (${res.status}): ${text}`);
  return json;
}

const fakeId = (prefix) => `${prefix}-SIM-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

/** Send money to a PayPal account by email (Payouts API). */
export async function sendPayout({ batchId, email, amount, currency, note }) {
  if (!paypalLive) {
    return { simulated: true, payoutBatchId: fakeId('PAYOUT'), status: 'SUCCESS' };
  }
  const json = await api('POST', '/v1/payments/payouts', {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: 'You have a payment',
      email_message: note || 'Payment sent via Leash',
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: amount.toFixed(2), currency },
        receiver: email,
        note: note || '',
        sender_item_id: batchId,
      },
    ],
  });
  return {
    simulated: false,
    payoutBatchId: json.batch_header?.payout_batch_id,
    status: json.batch_header?.batch_status,
  };
}

export async function getPayoutStatus(payoutBatchId) {
  if (!paypalLive) return { status: 'SUCCESS', simulated: true };
  const json = await api('GET', `/v1/payments/payouts/${payoutBatchId}`);
  return { status: json.batch_header?.batch_status, items: json.items };
}

/** Run an official PayPal Agent Toolkit tool (create_invoice, send_invoice, ...). */
export async function runToolkitTool(name, args) {
  if (!paypalLive) {
    if (name === 'create_invoice') return { simulated: true, invoiceId: fakeId('INV2'), raw: 'simulated' };
    return { simulated: true, raw: 'simulated', status: 'SENT' };
  }
  const res = await toolkit.handleToolCall({
    id: crypto.randomUUID(),
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const raw = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
  if (/error|"name":\s*"[A-Z_]+ERROR/i.test(raw) && !/INV2-/.test(raw)) {
    throw new Error(`PayPal toolkit ${name} failed: ${raw.slice(0, 400)}`);
  }
  const invoiceId = raw.match(/INV2-[A-Z0-9-]+/)?.[0];
  return { simulated: false, invoiceId, raw };
}

/** Verify a webhook really came from PayPal (only when PAYPAL_WEBHOOK_ID is set). */
export async function verifyWebhook(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!paypalLive || !webhookId) return { verified: false, reason: 'verification not configured' };
  const json = await api('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event,
  });
  return { verified: json.verification_status === 'SUCCESS' };
}
