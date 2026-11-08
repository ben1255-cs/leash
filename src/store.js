import fs from 'node:fs';
import path from 'node:path';
import { seedPayees, seedRules } from './demo-data.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const FILE = path.join(DATA_DIR, 'leash.json');

const fresh = () => ({
  rules: seedRules(),
  payees: seedPayees(),
  decisions: [], // every payment action the agent attempted, with Leash's verdict
  activity: [], // agent timeline (tool calls, messages)
  events: [], // PayPal webhook events
  runs: [],
});

let state = load();

function load() {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return fresh();
  }
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('Could not persist state:', err.message);
    }
  }, 100);
}

export const db = () => state;

export function reset() {
  state = fresh();
  save();
}

export function addActivity(runId, type, text, extra = {}) {
  const item = { id: crypto.randomUUID(), runId, at: new Date().toISOString(), type, text, ...extra };
  state.activity.push(item);
  save();
  return item;
}

export function findPayeeByEmail(email) {
  if (!email) return null;
  return state.payees.find((p) => p.email.toLowerCase() === email.toLowerCase()) || null;
}

export function findPayeeByName(name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return state.payees.find((p) => p.name.toLowerCase() === n) || null;
}

export function spentToday() {
  const today = new Date().toISOString().slice(0, 10);
  return state.decisions
    .filter(
      (d) =>
        d.intent.direction === 'out' &&
        d.at.startsWith(today) &&
        ['executed', 'pending'].includes(d.status),
    )
    .reduce((sum, d) => sum + (d.intent.amount || 0), 0);
}
