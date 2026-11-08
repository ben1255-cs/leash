// Leash dashboard. Polls /api/state and renders the live view, inbox, audit log and rules.
const $ = (s) => document.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;
let grid = null;
let lastGridKey = '';

function money(n, c) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: c || state?.rules?.currency || 'USD' }).format(n || 0);
}
function getPassword() {
  try { return localStorage.getItem('leash-pw') || ''; } catch { return ''; }
}
async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state?.config?.passwordRequired) {
    let pw = getPassword();
    if (!pw) {
      pw = prompt('Demo password (see the README):') || '';
      try { localStorage.setItem('leash-pw', pw); } catch {}
    }
    headers['x-demo-password'] = pw;
  }
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { try { localStorage.removeItem('leash-pw'); } catch {} }
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${t.dataset.tab}`));
    if (t.dataset.tab === 'audit') renderGrid(true);
  }),
);

// ---------- Render ----------
function renderStatus() {
  const { paypal, ai } = state.config;
  $('#status').innerHTML =
    `<span class="pill ${paypal === 'sandbox' ? 'on' : 'off'}">PayPal: ${paypal === 'sandbox' ? 'Sandbox connected' : 'Simulated'}</span>` +
    `<span class="pill ${ai === 'claude' ? 'on' : 'off'}">AI: ${ai === 'claude' ? 'Claude' : 'Offline'}</span>`;
  const mode = $('#mode');
  mode.querySelector('[value=claude]').disabled = ai !== 'claude';
  if (ai !== 'claude') mode.value = 'scripted';
}

function renderStats() {
  const ds = state.decisions.filter((d) => d.intent.direction === 'out');
  const sum = (f) => ds.filter(f).reduce((s, d) => s + d.intent.amount, 0);
  $('#stats').innerHTML = `
    <div class="stat g"><span>Paid automatically</span><b>${money(sum((d) => d.status === 'executed' && !d.approvedAt))}</b></div>
    <div class="stat a"><span>Waiting for you</span><b>${money(sum((d) => d.status === 'pending'))}</b></div>
    <div class="stat r"><span>Blocked</span><b>${money(sum((d) => d.status === 'blocked'))}</b></div>
    <div class="stat"><span>Approved by you</span><b>${money(sum((d) => d.status === 'executed' && d.approvedAt))}</b></div>`;
}

function renderTimeline() {
  const run = state.runs[state.runs.length - 1];
  const items = run ? state.activity.filter((a) => a.runId === run.id) : [];
  const label = { user: 'You', agent: 'Agent', tool: 'Tool', leash: 'Leash', human: 'You', paypal: 'PayPal', error: 'Error' };
  $('#timeline').innerHTML = items.length
    ? items
        .map((a) => {
          if (a.type === 'leash') {
            const d = state.decisions.find((x) => x.id === a.decisionId);
            return `<li class="leash"><span class="who">Leash</span><span class="dot ${a.light}" style="margin-top:3px"></span><span>${esc(a.text)} → <b>${esc(d?.status || a.light)}</b></span></li>`;
          }
          return `<li class="${a.type}"><span class="who">${label[a.type] || a.type}</span><span>${esc(a.text)}</span></li>`;
        })
        .join('')
    : '<li class="muted">Run the agent to see it work. Every payment it tries goes through Leash first.</li>';
  const running = state.runs.some((r) => r.status === 'running');
  $('#run').disabled = running;
  $('#run').textContent = running ? 'Agent running…' : 'Run agent';
  const tl = $('#timeline');
  tl.scrollTop = tl.scrollHeight;
}

function card(d) {
  const checks = [...d.checks]
    .sort((a, b) => b.risk - a.risk)
    .map((c) => `<span class="chk ${c.risk >= 0.7 ? 'hi' : c.risk >= 0.3 ? 'mid' : ''}" title="${esc(c.detail)}">${esc(c.label)}</span>`)
    .join('');
  const ref = d.paypal?.payoutBatchId || d.paypal?.invoiceId;
  const statusText = { executed: 'Paid', pending: 'Approve?', blocked: 'Blocked', rejected: 'Rejected', failed: 'PayPal error', executing: 'Sending…' };
  const title = d.intent.kind === 'invoice' || d.intent.kind === 'send_invoice' ? 'Sent' : 'Paid';
  return `
  <div class="card ${d.light} ${d.status}">
    <div class="card-h">
      <span class="dot ${d.light}"></span>
      <div class="card-title">${esc(d.intent.summary)}<small>${esc(d.intent.payee || '')}</small></div>
      <span class="badge ${d.status}">${d.status === 'executed' ? title : statusText[d.status] || d.status}</span>
    </div>
    <p class="reason">${esc(d.reason)}</p>
    <div class="checks">${checks}</div>
    <div class="meta">
      <span>Risk <b>${d.risk.toFixed(2)}</b></span>
      <span>Rules ${d.rRules.toFixed(2)}</span>
      <span>AI ${d.rAi == null ? 'n/a' : d.rAi.toFixed(2)}</span>
      ${ref ? `<span>PayPal <code>${esc(ref)}</code>${d.paypal.simulated ? ' (simulated)' : ''}</span>` : ''}
      ${d.paypal?.lastEvent ? `<span>Webhook: ${esc(d.paypal.lastEvent)}</span>` : ''}
      ${d.error ? `<span style="color:#ff8a8a">${esc(d.error.slice(0, 160))}</span>` : ''}
    </div>
    ${d.status === 'pending' ? `<div class="actions"><button class="btn approve" data-approve="${d.id}">Approve &amp; pay</button><button class="btn reject" data-reject="${d.id}">Reject</button></div>` : ''}
  </div>`;
}

function renderDecisions() {
  const pending = state.decisions.filter((d) => d.status === 'pending');
  const others = state.decisions.filter((d) => d.status !== 'pending').slice().reverse();
  $('#pending-count').textContent = pending.length;
  $('#pending-count').classList.toggle('zero', !pending.length);
  $('#pending').innerHTML = pending.length ? pending.map(card).join('') : '<div class="empty">Nothing waiting. Amber payments appear here for one-tap approval.</div>';
  $('#feed').innerHTML = others.length ? others.map(card).join('') : '<div class="empty">No payments yet.</div>';
}

let inboxCache = null;
async function renderInbox() {
  inboxCache ||= await fetch('/api/inbox').then((r) => r.json());
  $('#emails').innerHTML = inboxCache
    .map(
      (e) => `
    <div class="email ${e.hidden ? 'hostile' : ''}">
      <div class="email-h"><b>${esc(e.subject)}</b><span class="muted small">${esc(e.received)}</span></div>
      <div class="muted small">${esc(e.from)}</div>
      <pre>${esc(e.body)}</pre>
      ${e.hidden ? `<div class="hidden-text"><b>Hidden text: invisible to you, visible to the AI</b>${esc(e.hidden)}</div>` : ''}
    </div>`,
    )
    .join('');
}

function renderRules() {
  const f = $('#rules-form');
  if (!f.dataset.loaded) {
    for (const [k, v] of Object.entries(state.rules)) {
      const el = f.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = v;
      else el.value = v;
    }
    f.dataset.loaded = '1';
  }
  $('#payees').innerHTML = state.payees
    .map(
      (p) => `<div class="payee"><div>${esc(p.name)}<small>${esc(p.email)}</small></div><div class="muted" style="text-align:right">${esc(p.role)}<small>${p.history.length} past payments</small></div></div>`,
    )
    .join('');
}

function renderGrid(force) {
  if (!window.agGrid || !$('#view-audit').classList.contains('active')) return;
  const rows = state.decisions
    .slice()
    .reverse()
    .map((d) => ({
      time: new Date(d.at).toLocaleTimeString(),
      light: d.light,
      action: d.intent.kind,
      payee: d.intent.payeeName || d.intent.payee,
      email: d.intent.payee,
      amount: d.intent.amount,
      risk: d.risk,
      rules: d.rRules,
      ai: d.rAi,
      status: d.status,
      reason: d.reason,
      ref: d.paypal?.payoutBatchId || d.paypal?.invoiceId || '',
    }));
  const key = JSON.stringify(rows);
  if (grid && key === lastGridKey && !force) return;
  lastGridKey = key;
  if (!grid) {
    const theme = agGrid.themeQuartz.withParams({
      backgroundColor: '#0b1430', foregroundColor: '#eef2ff', headerBackgroundColor: '#101c40',
      borderColor: 'rgba(255,255,255,0.1)', accentColor: '#4f8bff', fontFamily: 'Inter, sans-serif',
      oddRowBackgroundColor: '#0d1736', browserColorScheme: 'dark',
    });
    grid = agGrid.createGrid($('#grid'), {
      theme,
      rowData: rows,
      defaultColDef: { sortable: true, filter: true, resizable: true },
      columnDefs: [
        { field: 'time', width: 100 },
        {
          field: 'light', width: 95,
          cellRenderer: (p) => `<span style="display:inline-flex;align-items:center;gap:8px"><span class="dot ${p.value}"></span>${p.value}</span>`,
        },
        { field: 'action', width: 110 },
        { field: 'payee', width: 130, tooltipField: 'email' },
        { field: 'amount', width: 110, valueFormatter: (p) => money(p.value) },
        { field: 'risk', width: 80 },
        { field: 'rules', headerName: 'R rules', width: 90 },
        { field: 'ai', headerName: 'R AI', width: 80, valueFormatter: (p) => (p.value == null ? 'n/a' : p.value) },
        { field: 'status', width: 105 },
        { field: 'reason', flex: 1, minWidth: 340, tooltipField: 'reason' },
        { field: 'email', width: 230 },
        { field: 'ref', headerName: 'PayPal ref', width: 200 },
      ],
    });
    $('#grid-filter').addEventListener('input', (e) => grid.setGridOption('quickFilterText', e.target.value));
  } else {
    grid.setGridOption('rowData', rows);
  }
  $('#events').innerHTML = state.events.length
    ? state.events.slice().reverse().map((e) => `${esc(new Date(e.at).toLocaleTimeString())} · <b>${esc(e.type)}</b> ${esc(e.summary || '')} ${e.verified ? '✓ verified' : ''}`).join('<br>')
    : 'No webhook events yet. Point a PayPal sandbox webhook at /webhooks/paypal to see payout and invoice confirmations here.';
}

async function refreshState() {
  try {
    state = await fetch('/api/state').then((r) => r.json());
    if (!$('#instruction').value) $('#instruction').value = state.config.defaultInstruction;
    renderStatus();
    renderStats();
    renderTimeline();
    renderDecisions();
    renderRules();
    renderGrid();
  } catch (err) {
    console.error(err);
  }
}

// ---------- Actions ----------
$('#run').addEventListener('click', async () => {
  try {
    await api('POST', '/api/agent/run', { instruction: $('#instruction').value, mode: $('#mode').value });
    refreshState();
  } catch (err) { alert(err.message); }
});
$('#reset').addEventListener('click', async () => {
  if (!confirm('Clear all decisions and start the demo again?')) return;
  try { await api('POST', '/api/reset'); $('#rules-form').dataset.loaded = ''; refreshState(); } catch (err) { alert(err.message); }
});
document.addEventListener('click', async (e) => {
  const id = e.target.dataset.approve || e.target.dataset.reject;
  if (!id) return;
  e.target.disabled = true;
  try {
    await api('POST', `/api/decisions/${id}/${e.target.dataset.approve ? 'approve' : 'reject'}`);
    refreshState();
  } catch (err) { alert(err.message); e.target.disabled = false; }
});
$('#rules-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(['perPaymentCap', 'dailyBudget', 'unusualAmountMultiplier', 'greenBelow', 'redAtOrAbove'].map((k) => [k, f.elements[k].value]));
  body.approveNewPayees = f.elements.approveNewPayees.checked;
  try { await api('PUT', '/api/rules', body); $('#rules-msg').textContent = 'Saved.'; } catch (err) { $('#rules-msg').textContent = err.message; }
});

renderInbox();
refreshState();
setInterval(refreshState, 1000);
