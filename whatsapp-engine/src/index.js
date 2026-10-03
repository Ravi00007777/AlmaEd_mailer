// AlmaED WhatsApp outreach engine: paced sending via gowa, reply handling, local dashboard.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const R = require('./rules');
const { importWorkbook } = require('./importer');
const { Gowa, GowaProcess } = require('./gowa');

const ROOT = process.env.ENGINE_ROOT || path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const MESSAGES_FILE = path.join(ROOT, 'messages.json');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');

// ---------------------------------------------------------------- config & state
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const cfg = readJson(CONFIG_FILE, null);
if (!cfg) { console.error('config.json is missing or not valid JSON.'); process.exit(1); }
let changedCfg = false;
if (!cfg.gowa.password) { cfg.gowa.password = crypto.randomBytes(9).toString('base64url'); changedCfg = true; }
if (!cfg.gowa.webhookSecret) { cfg.gowa.webhookSecret = crypto.randomBytes(18).toString('hex'); changedCfg = true; }
// Older versions used localhost:3000, which clashes with web dev servers and can resolve to IPv6 on Windows.
if (!cfg.gowa.url || /\/\/localhost:3000\/?$/.test(cfg.gowa.url)) { cfg.gowa.url = 'http://127.0.0.1:3737'; changedCfg = true; }
if (cfg.gowa.whatsappProxy === undefined) { cfg.gowa.whatsappProxy = ''; changedCfg = true; }
if (changedCfg) writeJson(CONFIG_FILE, cfg);
const TICK_MS = Number(process.env.ENGINE_TICK_MS || 5000);

function messages() { return readJson(MESSAGES_FILE, {}); }

const state = readJson(STATE_FILE, null) || {
  contacts: [], activity: [], running: false, daysActive: [], importedAt: null, importFile: null,
  nextSendAt: 0, consecutiveErrors: 0, lastError: '', ourMessageIds: [],
};
let byPhone = new Map();
let byMsgId = new Map();
function reindex() {
  byPhone = new Map(state.contacts.map((c) => [c.phone, c]));
  byMsgId = new Map();
  state.contacts.forEach((c) => { if (c.messageId) byMsgId.set(c.messageId, c); });
}
reindex();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(STATE_FILE, state), 300);
}
function saveNow() { clearTimeout(saveTimer); writeJson(STATE_FILE, state); }

function log(text, kind = 'info') {
  state.activity.unshift({ at: Date.now(), text, kind });
  state.activity.length = Math.min(state.activity.length, 200);
  console.log(`[${new Date().toLocaleTimeString()}] ${text}`);
  save();
}
function rememberOurId(id) {
  if (!id) return;
  state.ourMessageIds.push(id);
  if (state.ourMessageIds.length > 5000) state.ourMessageIds.splice(0, 1000);
}

// ---------------------------------------------------------------- time helpers
function zoned(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todaysLimit(now = Date.now()) {
  const day = zoned(now).day;
  let idx = state.daysActive.indexOf(day);
  if (idx < 0) idx = state.daysActive.length;
  const warm = cfg.warmupDailyLimits || [];
  return Math.min(cfg.dailyLimit, idx < warm.length ? warm[idx] : cfg.dailyLimit);
}
function sentToday(now = Date.now()) {
  const day = zoned(now).day;
  return state.contacts.filter((c) => c.sentAt && zoned(c.sentAt).day === day).length;
}
function inHours(now = Date.now()) {
  const h = zoned(now).hour;
  return h >= cfg.sendFromHour && h < cfg.sendUntilHour;
}

// ---------------------------------------------------------------- gowa
const gowa = new Gowa(cfg.gowa);
let gowaProc = null;
async function isOurGowa(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/devices`, { headers: gowa.headers(), signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    return r.ok && d.code === 'SUCCESS';
  } catch (_) { return false; }
}
let gowaStatus = { reachable: false, loggedIn: false, jid: '', error: 'checking…', checkedAt: 0 };
async function refreshGowa(force) {
  if (!force && Date.now() - gowaStatus.checkedAt < 15000) return gowaStatus;
  const wasIn = gowaStatus.loggedIn;
  gowaStatus = { ...(await gowa.status()), checkedAt: Date.now() };
  if (gowaStatus.reachable && gowaProc) gowaProc.markRunning();
  if (wasIn && !gowaStatus.loggedIn) {
    log('WhatsApp disconnected. Open the WhatsApp login page and check the phone. If the number was banned, stop here.', 'error');
  }
  if (!wasIn && gowaStatus.loggedIn) log(`WhatsApp connected (${gowaStatus.jid.split('@')[0]}).`, 'good');
  return gowaStatus;
}

const recentOut = new Map();   // phone -> [{text, at}] so our own sends echoed by the webhook are ignored
async function sendHuman(phone, text) {
  const list = (recentOut.get(phone) || []).filter((x) => Date.now() - x.at < 5 * 60 * 1000);
  list.push({ text, at: Date.now() });
  recentOut.set(phone, list);
  if (cfg.typingIndicator) {
    await gowa.typing(phone, true);
    await sleep(Math.min(9000, 1500 + text.length * 12) * (process.env.ENGINE_FAST ? 0.001 : 1));
    await gowa.typing(phone, false);
  }
  const id = await gowa.sendText(phone, text);
  rememberOurId(id);
  return id;
}

// ---------------------------------------------------------------- sending
let busy = false;
let qr = null;   // latest login QR { png, until }

async function sendOpener(c) {
  const text = R.renderMessage(messages().opener, c);
  try {
    const id = await sendHuman(c.phone, text);
    c.status = 'sent'; c.sentAt = Date.now(); c.messageId = id;
    c.thread = [{ from: 'us', text, at: c.sentAt }];
    if (id) byMsgId.set(id, c);
    const day = zoned(c.sentAt).day;
    if (!state.daysActive.includes(day)) state.daysActive.push(day);
    state.consecutiveErrors = 0; state.lastError = '';
    state.nextSendAt = Date.now() + rand(cfg.minGapSeconds, cfg.maxGapSeconds) * 1000;
    log(`Sent opener to ${c.name || c.phone} (${c.region}).`, 'sent');
  } catch (e) {
    if (/not on whatsapp|not registered|invalid jid/i.test(e.message)) {
      c.status = 'not_on_whatsapp';
      state.nextSendAt = Date.now() + 15000 * (process.env.ENGINE_FAST ? 0.001 : 1);
      log(`${c.name || c.phone} is not on WhatsApp, skipped.`, 'muted');
    } else {
      state.consecutiveErrors++;
      state.lastError = e.message;
      state.nextSendAt = Date.now() + 5 * 60 * 1000 * (process.env.ENGINE_FAST ? 0.001 : 1);
      log(`Could not send to ${c.name || c.phone}: ${e.message}. Will retry in 5 minutes.`, 'error');
      if (state.consecutiveErrors >= 3) {
        state.running = false;
        log('Paused after 3 errors in a row. Check that WhatsApp is connected, then press Start.', 'error');
      }
    }
  }
  save();
}

async function sendDetails(c) {
  const text = R.renderMessage(messages().details, c);
  try {
    await sendHuman(c.phone, text);
    c.status = 'details_sent'; c.detailsAt = Date.now(); c.pendingDetailsAt = null; c.needsYou = false;
    (c.thread = c.thread || []).push({ from: 'us', text, at: c.detailsAt });
    log(`Sent details + demo link to ${c.name || c.phone}.`, 'good');
  } catch (e) {
    c.pendingDetailsAt = Date.now() + 10 * 60 * 1000;
    log(`Could not send details to ${c.name || c.phone}: ${e.message}. Will retry in 10 minutes.`, 'error');
  }
  save();
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // 1. replies waiting for the details message go out any time, even when paused
    const due = state.contacts.find((c) => c.pendingDetailsAt && c.pendingDetailsAt <= Date.now());
    if (due) {
      if ((await refreshGowa()).loggedIn) await sendDetails(due);
      return;
    }
    // 2. new openers, paced
    if (!state.running) return;
    const now = Date.now();
    if (!inHours(now) || now < state.nextSendAt) return;
    if (sentToday(now) >= todaysLimit(now)) return;
    if (!(await refreshGowa()).loggedIn) { state.lastError = 'WhatsApp is not connected.'; return; }
    const next = state.contacts.find((c) => c.status === 'pending');
    if (!next) {
      state.running = false;
      log('Everyone on the list has been messaged. Sending stopped.', 'good');
      return;
    }
    await sendOpener(next);
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- replies (gowa webhook)
const jidUser = (jid) => String(jid || '').split('@')[0].split(':')[0];

function handleWebhook(raw, signature) {
  if (cfg.gowa.webhookSecret) {
    const expected = 'sha256=' + crypto.createHmac('sha256', cfg.gowa.webhookSecret).update(raw).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(signature || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 401;
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return 400; }
  const p = body.payload || {};
  const chat = String(p.chat_id || '');
  if (!/@s\.whatsapp\.net$|@lid$/.test(chat)) return 200;              // ignore groups, status, channels

  let c = byPhone.get(jidUser(chat)) || byPhone.get(jidUser(p.from));
  if (!c && p.replied_to_id) c = byMsgId.get(p.replied_to_id);
  if (!c) return 200;                                                   // not part of this campaign

  if (body.event === 'message.reaction') {
    if (p.is_from_me) return 200;
    (c.thread = c.thread || []).push({ from: 'them', text: `reacted ${p.reaction || ''}`, at: Date.now() });
    if (c.status === 'sent') c.status = 'replied';
    c.needsYou = true;
    log(`${c.name || c.phone} reacted ${p.reaction || ''} to your message.`, 'reply');
    save();
    return 200;
  }
  if (body.event !== 'message') return 200;

  const text = String(p.body || p.text || (p.image && p.image.caption) || (p.video && p.video.caption) || '').trim() || '[media]';
  if (p.is_from_me) {
    if (state.ourMessageIds.includes(p.id)) return 200;                 // sent by this engine
    if ((recentOut.get(c.phone) || []).some((x) => x.text.trim() === text && Date.now() - x.at < 5 * 60 * 1000)) return 200;
    (c.thread = c.thread || []).push({ from: 'us', text, at: Date.now() });
    if (c.needsYou) { c.needsYou = false; log(`You replied to ${c.name || c.phone} from your phone.`, 'muted'); }
    save();
    return 200;
  }

  (c.thread = c.thread || []).push({ from: 'them', text, at: Date.now() });
  c.replies = c.replies || [];
  c.replies.push({ at: Date.now(), text });
  c.lastReplyAt = Date.now();

  if (c.status === 'sent') {
    const kind = R.classifyReply(text);
    if (kind === 'positive') {
      c.status = 'interested';
      c.pendingDetailsAt = Date.now() + rand(cfg.detailsDelaySeconds[0], cfg.detailsDelaySeconds[1]) * 1000;
      log(`${c.name || c.phone} replied "${text.slice(0, 60)}" → sending details shortly.`, 'reply');
    } else if (kind === 'negative') {
      c.status = 'not_interested';
      log(`${c.name || c.phone} replied "${text.slice(0, 60)}" → marked not interested.`, 'muted');
      const bye = (messages().notInterestedReply || '').trim();
      if (bye && !/\bstop\b|unsubscribe|block|spam/i.test(text)) {
        sendHuman(c.phone, R.renderMessage(bye, c)).catch(() => {});
      }
    } else {
      c.status = 'replied';
      c.needsYou = true;
      log(`${c.name || c.phone} replied "${text.slice(0, 60)}" → needs your reply.`, 'reply');
    }
  } else {
    c.needsYou = true;
    log(`New message from ${c.name || c.phone}: "${text.slice(0, 60)}"`, 'reply');
  }
  save();
  return 200;
}

// ---------------------------------------------------------------- import
function findWorkbook() {
  if (cfg.contactsFile && fs.existsSync(path.join(ROOT, cfg.contactsFile))) return path.join(ROOT, cfg.contactsFile);
  const xs = fs.readdirSync(ROOT).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
    .map((f) => ({ f, t: fs.statSync(path.join(ROOT, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  return xs.length ? path.join(ROOT, xs[0].f) : null;
}

async function runImport() {
  const file = findWorkbook();
  if (!file) throw new Error('No .xlsx file found. Download your alumni Sheet (File → Download → Microsoft Excel) into the engine folder.');
  const { contacts, stats } = await importWorkbook(file, { skipIfAlreadyEmailed: !!cfg.skipIfAlreadyEmailed });
  let added = 0;
  for (const c of contacts) if (!byPhone.has(c.phone)) { state.contacts.push(c); added++; }
  reindex();
  state.importedAt = Date.now(); state.importFile = path.basename(file);
  const skipped = Object.entries(stats.skipped).map(([k, v]) => `${v} ${k}`).join(', ');
  log(`Imported ${path.basename(file)}: ${added} new contacts from ${stats.tabs} tabs (${stats.duplicates} duplicate numbers merged${skipped ? '; skipped: ' + skipped : ''}).`, 'good');
  saveNow();
  return { added, stats };
}

// ---------------------------------------------------------------- dashboard API
function counts() {
  const k = { pending: 0, sent: 0, replied: 0, interested: 0, details_sent: 0, not_interested: 0, not_on_whatsapp: 0, skipped: 0 };
  state.contacts.forEach((c) => { k[c.status] = (k[c.status] || 0) + 1; });
  return k;
}
function publicState() {
  const now = Date.now();
  const k = counts();
  const limit = todaysLimit(now), today = sentToday(now);
  let waiting = '';
  if (!state.running) waiting = 'Paused';
  else if (!inHours(now)) waiting = `Outside sending hours (${cfg.sendFromHour}:00–${cfg.sendUntilHour}:00)`;
  else if (today >= limit) waiting = "Today's limit reached; continues tomorrow";
  else if (!gowaStatus.loggedIn) waiting = 'Waiting for WhatsApp to connect';
  else if (now < state.nextSendAt) waiting = `Next message in ${Math.ceil((state.nextSendAt - now) / 1000)}s`;
  else waiting = 'Sending…';
  const needsYou = state.contacts.filter((c) => c.needsYou)
    .sort((a, b) => (b.lastReplyAt || 0) - (a.lastReplyAt || 0))
    .map((c) => ({ phone: c.phone, name: c.name, region: c.region, status: c.status, thread: (c.thread || []).slice(-6) }));
  return {
    running: state.running, waiting, today, limit, dailyLimit: cfg.dailyLimit,
    hours: [cfg.sendFromHour, cfg.sendUntilHour], counts: k, total: state.contacts.length,
    gowa: { reachable: gowaStatus.reachable, loggedIn: gowaStatus.loggedIn, number: jidUser(gowaStatus.jid), error: gowaStatus.error, url: gowa.base, username: cfg.gowa.username, password: cfg.gowa.password,
      proc: gowaProc ? gowaProc.info() : { state: cfg.gowa.autoStart === false ? 'manual' : 'idle', reason: '', tail: '' }, platform: process.platform },
    needsYou, activity: state.activity.slice(0, 60), lastError: state.lastError,
    importFile: state.importFile, importedAt: state.importedAt, testNumber: cfg.testNumber || '',
    daysLeft: Math.ceil(k.pending / Math.max(1, cfg.dailyLimit)),
  };
}

function csvEscape(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportCsv() {
  const fmt = (t) => (t ? new Date(t).toLocaleString('en-IN', { timeZone: cfg.timezone }) : '');
  const head = ['Phone', 'Name', 'First name', 'Region', 'Email', 'Status', 'Skip reason', 'Opener sent', 'Last reply', 'Reply time', 'Details sent'];
  const rows = state.contacts.map((c) => {
    const last = (c.replies || []).slice(-1)[0] || {};
    return [c.phone, c.name, c.first, c.region, c.email, c.status, c.skipReason, fmt(c.sentAt), last.text || '', fmt(last.at), fmt(c.detailsAt)];
  });
  return [head, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

async function action(type, body) {
  const c = body.phone ? byPhone.get(body.phone) : null;
  switch (type) {
    case 'start':
      if (!state.contacts.length) throw new Error('No contacts yet. Put the downloaded .xlsx in the engine folder and press Import.');
      state.running = true; state.consecutiveErrors = 0; state.lastError = '';
      log('Sending started.', 'good'); break;
    case 'pause': state.running = false; log('Sending paused.', 'muted'); break;
    case 'login': {
      let r;
      try { r = await gowa.loginQr(); } catch (e) {
        throw new Error(/reconnect|dial|websocket|handshake/i.test(e.message) ? "Couldn't reach WhatsApp's servers. If you're on campus Wi-Fi/LAN, connect the laptop to a mobile hotspot and try again." : e.message);
      }
      qr = { png: r.qrPng, until: Date.now() + r.seconds * 1000 };
      return { ok: true, seconds: r.seconds };
    }
    case 'paircode': {
      const num = R.normalisePhone(body.phone);
      if (!num) throw new Error('Enter the outreach phone number (10 digits).');
      const code = await gowa.loginCode(num);
      return { ok: true, code };
    }
    case 'import': return runImport();
    case 'restartgowa': {
      if (!gowaProc) gowaProc = new GowaProcess(cfg.gowa, ROOT, cfg.dashboardPort || 4000, (t, k) => log(t, k));
      log('Restarting gowa…', 'muted');
      const p = await gowaProc.restart(isOurGowa);
      gowa.setPort(p);
      for (let i = 0; i < 45 && gowaProc.state === 'starting'; i++) { await sleep(1000); await refreshGowa(true); if (gowaStatus.reachable) break; }
      return { ok: true, state: gowaProc.state };
    }
    case 'test': {
      const num = R.normalisePhone(cfg.testNumber);
      if (!num) throw new Error('Add your own number as "testNumber" in config.json first, then restart.');
      const sample = state.contacts.find((x) => x.status === 'pending' && x.first) || { first: 'Kesav', name: 'Kesav Krishna K' };
      await sendHuman(num, R.renderMessage(messages().opener, sample));
      await sleep(1500);
      await sendHuman(num, R.renderMessage(messages().details, sample));
      log(`Test: sent the opener and details (as if to ${sample.first}) to your number ${num}.`, 'good');
      break;
    }
    case 'details': if (!c) throw new Error('Unknown contact'); c.pendingDetailsAt = Date.now(); c.needsYou = false; c.status = 'interested'; break;
    case 'notinterested': if (!c) throw new Error('Unknown contact'); c.status = 'not_interested'; c.needsYou = false; c.pendingDetailsAt = null; break;
    case 'done': if (!c) throw new Error('Unknown contact'); c.needsYou = false; break;
    case 'reply': {
      if (!c) throw new Error('Unknown contact');
      const text = String(body.text || '').trim();
      if (!text) throw new Error('Type a message first.');
      await sendHuman(c.phone, text);
      (c.thread = c.thread || []).push({ from: 'us', text, at: Date.now() });
      c.needsYou = false;
      log(`You replied to ${c.name || c.phone} from the dashboard.`, 'muted');
      break;
    }
    default: throw new Error('Unknown action');
  }
  save();
  return { ok: true };
}

// ---------------------------------------------------------------- http server
const DASHBOARD = path.join(ROOT, 'public', 'dashboard.html');
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size > 5e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/webhook') {
      const raw = await readBody(req);
      return send(res, handleWebhook(raw, req.headers['x-hub-signature-256']), {});
    }
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(DASHBOARD, 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') { await refreshGowa(); return send(res, 200, publicState()); }
    if (req.method === 'GET' && url.pathname === '/api/qr.png') {
      if (!qr || Date.now() > qr.until) return send(res, 404, { error: 'QR expired' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(qr.png);
    }
    if (req.method === 'GET' && url.pathname === '/api/export.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="almaed-whatsapp-status.csv"' });
      return res.end('﻿' + exportCsv());
    }
    const m = url.pathname.match(/^\/api\/action\/(\w+)$/);
    if (req.method === 'POST' && m) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      try { return send(res, 200, await action(m[1], body)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

// ---------------------------------------------------------------- start
async function main() {
  const port = cfg.dashboardPort || 4000;
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is busy. Is the engine already running in another window?`) : e));
    server.listen(port, '127.0.0.1', resolve);
  });
  const dash = `http://localhost:${port}`;
  console.log(`\nAlmaED WhatsApp engine is running. Dashboard: ${dash}\n(Keep this window open. Press Ctrl+C to stop.)\n`);

  if (!state.contacts.length && findWorkbook()) {
    try { await runImport(); } catch (e) { log(e.message, 'error'); }
  }

  const st = await refreshGowa(true);
  if (!st.reachable && cfg.gowa.autoStart !== false) {
    gowaProc = new GowaProcess(cfg.gowa, ROOT, port, (t, k) => log(t, k));
    const p = await gowaProc.start(isOurGowa);
    gowa.setPort(p);
    if (gowaProc.state === 'starting') log('Starting gowa (the WhatsApp connector). The first start can take up to a minute.', 'muted');
  }
  // the first start on Windows can be slow while Windows Security scans the program
  for (let i = 0; i < 60 && !gowaStatus.reachable && (!gowaProc || gowaProc.state === 'starting'); i++) { await sleep(1000); await refreshGowa(true); }
  if (gowaStatus.reachable && !gowaStatus.loggedIn) log('gowa is ready. Click "Show QR code" to link your WhatsApp.', 'good');
  setInterval(tick, TICK_MS);
  setInterval(() => refreshGowa(true).catch(() => {}), 30000);

  if (cfg.openBrowser !== false && !process.env.ENGINE_NO_BROWSER) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', dash]] : process.platform === 'darwin' ? ['open', [dash]] : ['xdg-open', [dash]];
    try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch (_) { /* ignore */ }
  }
}

function shutdown() {
  saveNow();
  if (gowaProc) gowaProc.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) main().catch((e) => { console.error('\n' + e.message); process.exit(1); });

module.exports = { handleWebhook, tick, action, runImport, publicState, state, cfg, main, server };
