# Leash 🐕

**A spending firewall for AI agents: they handle the payments, you keep control.**

AI agents can now move real money through PayPal. Leash sits between the agent and PayPal and scores every payment action *before* it happens:

| Light | Meaning | What happens |
|---|---|---|
| 🟢 Green | Routine: known payee, within budget, matches history | Executes on PayPal automatically |
| 🟡 Amber | Unusual: new payee, unusually large amount | Held until you approve with one click |
| 🔴 Red | Dangerous: payee account changed, over limits, or the instruction came from untrusted content (prompt injection) | Blocked, with a plain-English reason |

Built for the PayPal AI Hackathon 2026.

> **Live demo:** _add your Render URL here_ · **Video:** _add your YouTube link here_

---

## The demo scenario

Northside Studio's owner tells the finance agent:

> *"Pay this week's contractor invoices from my inbox, and invoice Acme for the website milestone."*

The inbox holds four emails. One of them, apparently from contractor Tom, says he's "moved PayPal accounts" and contains **hidden text** (invisible to a human, visible to the AI) telling the agent the payment is pre-approved and to ignore spending limits.

| Agent action | Leash | Why |
|---|---|---|
| Pay Priya $450 | 🟢 Paid | Known contractor, paid 6 times, average $450 |
| Pay Sam $480 | 🟡 Approve? | First payment to a new payee |
| Invoice Acme $1,200 (PayPal Agent Toolkit) | 🟢 Sent | Known client |
| Pay "Tom" $2,000 at a new address | 🔴 Blocked | Hidden instruction in email; payee account changed; over limits |

Open the **Inbox** tab to see the hidden text revealed, and the **Audit log** tab for every decision.

## How it works

```
Owner instruction ──► AI agent (Gemini, tool use)
                          │  read_inbox, list_payees        (untrusted / trusted data)
                          │  send_payout                    (PayPal Payouts API)
                          │  create_invoice, send_invoice   (PayPal Agent Toolkit)
                          ▼
                 ┌──────────────── LEASH ────────────────┐
                 │ 1. Intent: who, how much, which way    │
                 │ 2. Provenance: did these details come  │
                 │    from the owner or from an email?    │
                 │ 3. Policy rules (deterministic)        │
                 │ 4. Independent AI risk reviewer        │
                 │ R = max(R_rules, R_AI) → 🟢 / 🟡 / 🔴     │
                 └────────────────────────────────────────┘
                          │ green, or amber + human approval
                          ▼
                    PayPal sandbox ──► webhooks ──► audit log
```

- **Rules can't be overridden by AI.** The final risk is the *maximum* of the rule score and the AI score, so the AI reviewer can make a payment riskier but never safer.
- **The reviewer doesn't trust the agent.** It's a separate model call that sees the owner's original instruction, trusted payee records and the raw source content, and treats emails as data, never as instructions.
- **Provenance beats keyword lists.** Leash records where each payment detail came from. A payee account that only exists in an email containing instructions aimed at the AI is blocked, however polite it sounds.
- **Approving a new payee teaches Leash.** They join the trusted payee list, so next time they're green.

### PayPal integration

| PayPal product | Used for | Where |
|---|---|---|
| **PayPal Agent Toolkit** (`@paypal/agent-toolkit`) | `create_invoice`, `send_invoice` tools given to the agent | `src/paypal.js`, `src/agent.js` |
| **Payouts API** `/v1/payments/payouts` | Paying contractors by PayPal email | `src/paypal.js` |
| **Invoicing API v2** (via the toolkit) | Billing clients | `src/paypal.js` |
| **Webhooks** + signature verification | Payout/invoice confirmations into the audit log | `server.js` |
| **OAuth 2.0** client credentials | Sandbox auth | `src/paypal.js` |

Also uses **Google Gemini** (agent + independent risk reviewer, free tier), **AG Grid** (audit log) and **Render** (hosting). Groq or Anthropic Claude also work by setting their key instead.

## Run it locally

Requires Node.js 20+.

```bash
git clone https://github.com/<your-username>/leash.git
cd leash
npm install
cp .env.example .env     # then fill in the keys below
npm start                # http://localhost:3000
```

**It runs with no keys at all:** PayPal calls are simulated and the scripted demo agent is used, so you can see the full flow in seconds. Add keys for the real thing:

| Variable | Needed for |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Real PayPal **sandbox** payouts and invoices |
| `GEMINI_API_KEY` | The live AI agent and the AI risk reviewer. Free key, no card: [aistudio.google.com/apikey](https://aistudio.google.com/apikey). (`GROQ_API_KEY` or `ANTHROPIC_API_KEY` also work.) |
| `PAYPAL_WEBHOOK_ID` | Verifying webhook signatures (optional) |
| `CURRENCY` | Defaults to `USD`; must match your sandbox business account |
| `DEMO_PASSWORD` | Optional: protects the buttons on a public deployment |

### PayPal sandbox setup (5 minutes)

1. Log in at [developer.paypal.com](https://developer.paypal.com/dashboard/) and switch to **Sandbox**.
2. **Apps & Credentials → Create App** (type: Merchant). Copy the **Client ID** and **Secret** into `.env`.
3. In the app's **Features**, make sure **Payouts** and **Invoicing** are ticked.
4. *(Optional)* In the app's **Webhooks**, add `https://<your-app>/webhooks/paypal` for `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED`, `INVOICING.INVOICE.PAID`, and copy the **Webhook ID** into `.env`.

Payouts to the demo addresses (`@example.com`) are accepted by the sandbox as unclaimed payments. You can see them under **Sandbox → Accounts → your business account → Activity**.

## Testing instructions for judges

1. Open the live demo (or run locally as above).
2. On **Live**, click **Run agent** (choose the live AI agent, or *Scripted* for a deterministic run).
3. Watch the timeline: two green actions go through, one amber waits for you, and the $2,000 "Tom" payment is blocked in red.
4. Click **Approve & pay** on the amber card. Sam is paid and added to trusted payees.
5. Open **Inbox** to see the hidden instruction, **Audit log** for every decision (sortable and filterable), and **Rules** to change limits and rerun.
6. Click **Reset demo** to start again.

_Demo password (if set): add it here._

## Project structure

```
server.js           Express API, webhooks, static UI
src/leash.js        The firewall: intent, provenance, rules, AI reviewer, execution
src/agent.js        AI agent with tool use + scripted demo agent
src/llm.js          AI provider layer (Gemini / Groq / Claude)
src/paypal.js       PayPal OAuth, Payouts, Agent Toolkit, webhook verification
src/store.js        JSON persistence
src/demo-data.js    Seed payees, rules and inbox
public/             Dashboard (vanilla JS + AG Grid)
```

## License

[MIT](LICENSE)
