// Vercel entry (experimental): dashboard + API, plus a short "session" that boots gowa, does whatever is due, then shuts it down.
// Engine state and the dashboard's action queue live in Supabase; gowa keeps the WhatsApp login in Supabase Postgres.
// ponytail: WhatsApp is only connected during sessions (pg_cron kicks one every 2 min), so replies arrive in batches
// and frequent reconnects raise ban risk. Move gowa to an always-on host if this proves flaky.
'use strict';
const fs = require('fs');
process.env.ENGINE_STATE_FILE = '/tmp/almaed-state.json';   // the engine's own file save; Supabase is the real store
fs.rmSync(process.env.ENGINE_STATE_FILE, { force: true });
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { waitUntil } = require('@vercel/functions');
const E = require('../src/index');
const DEFAULTS = JSON.stringify(E.state);

const env = process.env;
if (env.TEST_NUMBER) E.cfg.testNumber = env.TEST_NUMBER;
const SESSION_MS = 230e3;              // a session's work window; lock and maxDuration (300 s) leave room to shut down
const LOCK_S = 290;
const MIN_CONNECTED_MS = 25e3;         // time to receive messages WhatsApp queued while we were offline
const POLL_REPLIES_MS = 15 * 60e3;     // connect at least this often to pick up replies
const GOWA_ACTIONS = new Set(['login', 'paircode', 'test', 'reply', 'restartgowa']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Supabase (PostgREST over fetch)
async function db(method, route, body, prefer = 'return=minimal') {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${route}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${route.split('?')[0]}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const saveState = (extra = {}) => db('PATCH', 'engine?id=eq.1', { state: E.state, updated_at: new Date().toISOString(), ...extra });
const pendingActions = () => db('GET', `actions?done_at=is.null&created_at=gte.${new Date(Date.now() - 10 * 60e3).toISOString()}&order=id&select=id,type,body`, undefined, '');

function loadState(s) {
  for (const k of Object.keys(E.state)) delete E.state[k];
  Object.assign(E.state, JSON.parse(DEFAULTS), s);
  E.state.cloud = E.state.cloud || {};
  E.reindex();
  E.setGowaStatus({ reachable: true, loggedIn: false, jid: '', error: '', ...E.state.cloud.gowa, checkedAt: Date.now() });
}

// ---------------------------------------------------------------- gowa, booted per session
const GOWA_DIR = '/tmp/gowa';
async function bootGowa() {
  const bin = path.join(GOWA_DIR, 'gowa');
  if (!fs.existsSync(bin)) {           // /var/task is read-only, so copy the binary somewhere it can be made executable
    fs.mkdirSync(GOWA_DIR, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'gowa', 'linux-amd64'), bin);
    fs.chmodSync(bin, 0o755);
  }
  // gowa's webhook comes back into this same instance, so only the session holding the lock ever changes state
  const hook = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => { res.statusCode = E.handleWebhook(Buffer.concat(chunks), req.headers['x-hub-signature-256']); res.end(); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const g = E.cfg.gowa;
  const child = spawn(bin, ['rest',
    '--host', '127.0.0.1', '--port', new URL(g.url).port || '3737', '--os', 'AlmaED',
    '--basic-auth', `${g.username}:${g.password}`,
    '--webhook', `http://127.0.0.1:${hook.address().port}/webhook`,
    '--webhook-secret', g.webhookSecret, '--webhook-events', 'message,message.reaction',
    '--db-uri', env.GOWA_DB_URI], { cwd: GOWA_DIR, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (e) => console.error('gowa:', e.message));
  const exited = new Promise((r) => child.once('exit', r));

  // wait for gowa, and for the stored login to reconnect (status() directly, so boot noise isn't logged as a disconnect)
  const wasIn = !!(E.state.cloud.gowa && E.state.cloud.gowa.loggedIn);
  let st = { reachable: false };
  for (let i = 0; i < 40 && child.exitCode === null; i++) {
    await sleep(1000);
    st = await E.gowa.status();
    if (st.reachable && (st.loggedIn || !wasIn || i > 25)) break;
  }
  if (st.loggedIn) E.setGowaStatus({ ...st, checkedAt: Date.now() });
  else await E.refreshGowa(true);      // logs a real disconnect if we were linked before
  E.state.cloud.lastConnectAt = Date.now();
  return {
    async stop() {
      E.state.cloud.gowa = E.getGowaStatus();
      child.kill('SIGTERM');           // let whatsmeow flush its keys to Postgres
      await Promise.race([exited, sleep(5000)]);
      hook.close();
    },
  };
}

// ---------------------------------------------------------------- session
let inSession = false;
let loginUntil = 0;

function openerDueBy(t) {
  const s = E.state;
  return s.running && E.inHours() && E.sentToday() < E.todaysLimit() && s.nextSendAt < t && s.contacts.some((c) => c.status === 'pending');
}
const detailsPending = () => E.state.contacts.some((c) => c.pendingDetailsAt);
const linked = () => E.getGowaStatus().loggedIn;
function wantGowa(actions, started) {
  return actions.some((a) => GOWA_ACTIONS.has(a.type))
    || (linked() && (detailsPending() || openerDueBy(started + SESSION_MS)))
    || Date.now() - (E.state.cloud.lastConnectAt || 0) > POLL_REPLIES_MS;
}
function keepGoing(started, gowa) {
  if (!gowa) return false;
  const now = Date.now();
  if (now < loginUntil) return true;
  if (!linked()) return false;
  return now - started < MIN_CONNECTED_MS || detailsPending() || openerDueBy(started + SESSION_MS);
}

async function runAction(a) {
  let result;
  try {
    if (a.type === 'import') {
      if (!a.body.file) throw new Error('Choose the downloaded .xlsx file.');
      const file = path.join('/tmp', path.basename(String(a.body.name || 'contacts.xlsx')).replace(/[^\w. -]/g, '_'));
      fs.writeFileSync(file, Buffer.from(String(a.body.file), 'base64'));
      result = await E.runImport(file);
      fs.rmSync(file, { force: true });
    } else if (a.type === 'restartgowa') {
      result = { ok: true, state: 'running' };
    } else {
      result = await E.action(a.type, a.body);
      if (a.type === 'login' || a.type === 'paircode') loginUntil = Date.now() + 120e3;
      if (a.type === 'login' && E.qr()) result.png = E.qr().png.toString('base64');   // /api/qr.png may run on another instance
    }
  } catch (e) { result = { error: e.message }; }
  const done = { result, done_at: new Date().toISOString() };
  if (a.type === 'import') done.body = {};   // don't keep the uploaded alumni file in the queue
  await db('PATCH', `actions?id=eq.${a.id}`, done);
}

async function session() {
  if (inSession) return 'busy';
  inSession = true;
  let gowa = null, locked = false;
  try {
    const s = await db('POST', 'rpc/acquire_engine', { secs: LOCK_S }, '');
    if (s === null) return 'busy';     // another instance holds the lock
    locked = true;
    loadState(s);
    const started = Date.now();
    let savedAt = Date.now();
    do {
      const actions = await pendingActions();
      if (!gowa && wantGowa(actions, started)) {
        try { gowa = await bootGowa(); } catch (e) { E.state.lastError = `gowa could not start: ${e.message}`; console.error(e); }
      }
      for (const a of actions) await runAction(a);
      // a send moves nextSendAt (opener) or clears pendingDetailsAt (details); save at once so a hard kill can't resend
      const sendMark = () => `${E.state.nextSendAt}|${E.state.contacts.filter((c) => c.pendingDetailsAt).length}`;
      const before = sendMark();
      if (gowa) await E.tick();
      if (sendMark() !== before || Date.now() - savedAt > 10e3) { await saveState(); savedAt = Date.now(); }
      if (keepGoing(started, gowa)) await sleep(3000); else break;
    } while (Date.now() - started < SESSION_MS);
    return 'done';
  } finally {
    try { if (gowa) await gowa.stop(); } catch (e) { console.error(e); }
    if (locked) await saveState({ locked_until: null }).catch(console.error);
    inSession = false;
  }
}

// ---------------------------------------------------------------- HTTP
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function send(res, code, body, type = 'application/json') {
  res.statusCode = code;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function kick() { if (!inSession) waitUntil(session().catch(console.error)); }

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/tick') {
      if (!env.CRON_SECRET || !safeEq(req.headers.authorization || '', `Bearer ${env.CRON_SECRET}`)) return send(res, 401, { error: 'unauthorized' });
      kick();
      return send(res, 202, { ok: true });
    }

    // everything else is the dashboard: contacts' numbers and a live WhatsApp sender, so it needs the password
    const pass = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':').slice(1).join(':');
    if (!env.DASHBOARD_PASSWORD || !safeEq(pass, env.DASHBOARD_PASSWORD)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="AlmaED"');
      return send(res, 401, { error: 'password required' });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/api/state' || url.pathname === '/api/export.csv')) {
      if (!inSession) {
        const [row] = await db('GET', 'engine?id=eq.1&select=state', undefined, '');
        if (!inSession) loadState(row.state);     // a session in this instance has fresher state than the DB
      }
      if (url.pathname === '/api/export.csv') {
        res.setHeader('Content-Disposition', 'attachment; filename="almaed-whatsapp-status.csv"');
        return send(res, 200, '﻿' + E.exportCsv(), 'text/csv; charset=utf-8');
      }
      const s = E.publicState();
      s.cloud = true;
      s.gowa.proc = { state: 'running', reason: '', tail: '' };
      return send(res, 200, s);
    }
    if (req.method === 'GET' && url.pathname === '/api/qr.png') {
      const [a] = await db('GET', 'actions?type=eq.login&done_at=not.is.null&order=id.desc&limit=1&select=result,done_at', undefined, '');
      const png = a && a.result && a.result.png;
      if (!png || Date.now() - Date.parse(a.done_at) > 60e3) return send(res, 404, { error: 'QR expired' });
      return send(res, 200, Buffer.from(png, 'base64'), 'image/png');
    }
    const m = url.pathname.match(/^\/api\/action\/(\w+)$/);
    if (req.method === 'POST' && m) {
      const [a] = await db('POST', 'actions', { type: m[1], body: req.body || {} }, 'return=representation');
      kick();
      // a session (here or on another instance) picks the action up; wait for its result
      for (let i = 1; i <= 45; i++) {
        await sleep(1000);
        const [r] = await db('GET', `actions?id=eq.${a.id}&select=result`, undefined, '');
        if (r && r.result) return send(res, r.result.error ? 400 : 200, r.result);
        if (i % 10 === 0) kick();      // the session that was running may have ended just before our action landed
      }
      return send(res, 202, { ok: true, queued: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
};
