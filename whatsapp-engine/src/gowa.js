// Talks to gowa (go-whatsapp-web-multidevice) and, if its binary is in ./gowa, starts it.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

class Gowa {
  constructor(cfg) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    this.deviceId = cfg.deviceId || 'almaed';
  }

  setPort(port) { const u = new URL(this.base); u.port = String(port); this.base = u.toString().replace(/\/+$/, ''); }

  headers() {
    return { Authorization: this.auth, 'Content-Type': 'application/json', 'X-Device-Id': this.deviceId };
  }

  async call(method, route, body) {
    const res = await fetch(this.base + route, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!data || typeof data !== 'object' || !('code' in data)) {
      const err = new Error(`Another program (not gowa) is answering on ${this.base}`);
      err.notGowa = true;
      throw err;
    }
    if (!res.ok || (data.code !== 'SUCCESS' && data.code !== 200)) {
      const err = new Error(data.message || `gowa ${route} failed (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data.results || {};
  }

  /** gowa v8+ needs a device slot before anything works. Reuse an existing one, else create ours. */
  async ensureDevice() {
    const list = await this.call('GET', '/devices');
    const ids = (Array.isArray(list) ? list : []).map((d) => d.id || d.device_id).filter(Boolean);
    if (ids.includes(this.deviceId)) return this.deviceId;
    if (ids.length === 1) { this.deviceId = ids[0]; return this.deviceId; }
    await this.call('POST', '/devices', { device_id: this.deviceId });
    return this.deviceId;
  }

  /** Starts a QR login. Returns { qrPng: Buffer, seconds } */
  async loginQr() {
    await this.ensureDevice();
    const r = await this.call('GET', '/app/login');
    const link = String(r.qr_link || '');
    if (!link) throw new Error('gowa did not return a QR code. Is this number already linked?');
    const url = new URL(link, this.base);
    const img = await fetch(this.base + url.pathname, { headers: this.headers(), signal: AbortSignal.timeout(20000) });
    if (!img.ok) throw new Error(`Could not load the QR image (HTTP ${img.status})`);
    return { qrPng: Buffer.from(await img.arrayBuffer()), seconds: Number(r.qr_duration) || 30 };
  }

  /** Alternative to QR: an 8-character code you type into WhatsApp on the phone. */
  async loginCode(phone) {
    await this.ensureDevice();
    const r = await this.call('GET', '/app/login-with-code?phone=' + encodeURIComponent(phone));
    return r.pair_code || '';
  }

  /** { reachable, loggedIn, jid, error } */
  async status() {
    try {
      try { await this.ensureDevice(); } catch (e) { if (e.notGowa || /fetch failed|ECONNREFUSED|timeout|aborted/i.test(String(e.cause || e.message))) throw e; }
      const r = await this.call('GET', '/app/status');
      return { reachable: true, loggedIn: !!(r.is_logged_in && r.is_connected), jid: r.jid || '', error: '' };
    } catch (e) {
      const unreachable = e.notGowa || /fetch failed|ECONNREFUSED|timeout|aborted/i.test(String(e.cause || e.message));
      return { reachable: !unreachable, loggedIn: false, jid: '', error: e.notGowa ? e.message : unreachable ? 'gowa is not running' : e.message };
    }
  }

  async sendText(phone, message) {
    const r = await this.call('POST', '/send/message', { phone, message });
    return r.message_id || '';
  }

  async typing(phone, on) {
    try { await this.call('POST', '/send/chat-presence', { phone, action: on ? 'start' : 'stop' }); } catch (_) { /* optional */ }
  }
}

/** Finds the gowa program the user unzipped into the gowa folder. */
function findBinary(folder) {
  if (!fs.existsSync(folder)) return null;
  const files = fs.readdirSync(folder);
  const want = process.platform === 'win32' ? /^(whatsapp|gowa|windows-[\w]+)\.exe$/i
    : process.platform === 'darwin' ? /^(whatsapp|gowa|darwin-[\w]+)$/i
      : /^(whatsapp|gowa|linux-[\w]+)$/i;
  const hits = files.filter((f) => want.test(f));
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';
  const hit = hits.find((f) => f.includes(arch)) || hits[0];
  return hit ? path.join(folder, hit) : null;
}

const net = require('net');

/** True if something is already listening on 127.0.0.1:port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    sock.setTimeout(1500);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

const stripAnsi = (t) => String(t).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/**
 * Starts gowa from the gowa folder, watches it, and explains in plain words what went wrong.
 * state: idle | missing | starting | running | external | exited | blocked
 */
class GowaProcess {
  constructor(cfg, root, dashboardPort, log) {
    this.cfg = cfg; this.root = root; this.dashboardPort = dashboardPort; this.log = log;
    this.folder = path.join(root, cfg.binaryFolder || 'gowa');
    this.logFile = path.join(root, 'logs', 'gowa.log');
    this.state = 'idle'; this.reason = ''; this.child = null; this.bin = null; this.startedAt = 0;
    this.port = Number(new URL(cfg.url).port || 3737);
  }

  tail(lines = 8) {
    try {
      const st = fs.statSync(this.logFile);
      const fd = fs.openSync(this.logFile, 'r');
      const len = Math.min(st.size, 8000);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      return stripAnsi(buf.toString('utf8')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-lines).join('\n');
    } catch (_) { return ''; }
  }

  /** Returns the port gowa ends up on (it moves if the usual port is taken by another app). */
  async start(isOurGowa) {
    this.bin = findBinary(this.folder);
    if (!this.bin) {
      this.state = 'missing';
      this.reason = process.platform === 'win32'
        ? 'The gowa program (windows-amd64.exe) is missing from the "gowa" folder. Windows Security most likely removed it as a false alarm.'
        : `No gowa program found in the "${this.cfg.binaryFolder || 'gowa'}" folder.`;
      this.log(this.reason, 'error');
      return this.port;
    }
    if (await portInUse(this.port)) {
      if (await isOurGowa(this.port)) { this.state = 'external'; return this.port; }   // left running from last time
      const from = this.port;
      for (let p = this.port + 1; p < this.port + 40; p++) if (!(await portInUse(p))) { this.port = p; break; }
      this.log(`Port ${from} is used by another app, so gowa will use port ${this.port}.`, 'muted');
    }
    if (process.platform !== 'win32') {
      try { fs.chmodSync(this.bin, 0o755); } catch (_) { /* ignore */ }
      if (process.platform === 'darwin') spawnSync('xattr', ['-d', 'com.apple.quarantine', this.bin], { stdio: 'ignore' });
    }
    const args = ['rest',
      '--host', '127.0.0.1',            // only this laptop can reach gowa (no firewall prompt, not exposed on Wi-Fi)
      '--port', String(this.port),
      '--os', 'AlmaED',
      '--basic-auth', `${this.cfg.username}:${this.cfg.password}`,
      '--webhook', `http://127.0.0.1:${this.dashboardPort}/webhook`,
      '--webhook-secret', this.cfg.webhookSecret,
      '--webhook-events', 'message,message.reaction'];
    if (this.cfg.whatsappProxy) args.push('--whatsapp-proxy', this.cfg.whatsappProxy);
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const out = fs.openSync(this.logFile, 'a');
    fs.writeSync(out, `\n===== starting gowa ${new Date().toISOString()} (${path.basename(this.bin)}, port ${this.port}) =====\n`);
    this.state = 'starting'; this.reason = ''; this.startedAt = Date.now();
    let child;
    try {
      child = spawn(this.bin, args, { cwd: this.folder, stdio: ['ignore', out, out], windowsHide: true });
    } catch (e) {
      this.blocked(e);
      return this.port;
    }
    this.child = child;
    child.on('error', (e) => this.blocked(e));
    child.on('exit', (code) => {
      if (this.child !== child) return;          // an old process we stopped on purpose
      this.child = null;
      if (this.state === 'stopping') return;
      this.state = 'exited';
      const t = this.tail(6);
      const last = t.split('\n').filter((l) => !l.startsWith('=====')).pop() || '';
      this.reason = `gowa stopped (exit code ${code}).` + (last ? ` Last message: ${last}` : '');
      this.log(this.reason + ' Click "Restart gowa" on the dashboard.', 'error');
    });
    return this.port;
  }

  blocked(e) {
    this.child = null;
    this.state = 'blocked';
    this.reason = `Windows/macOS would not start gowa (${e.code || e.message}). This usually means your antivirus or security settings blocked it.`;
    this.log(this.reason, 'error');
  }

  markRunning() { if (this.state === 'starting') { this.state = 'running'; this.reason = ''; } }

  stop() {
    if (this.child) { this.state = 'stopping'; try { this.child.kill(); } catch (_) { /* ignore */ } this.child = null; }
  }

  async restart(isOurGowa) {
    this.stop();
    await new Promise((r) => setTimeout(r, 1500));
    this.state = 'idle';
    return this.start(isOurGowa);
  }

  info() {
    return { state: this.state, reason: this.reason, tail: ['exited', 'blocked'].includes(this.state) ? this.tail(8) : '', port: this.port, startedAt: this.startedAt };
  }
}

module.exports = { Gowa, GowaProcess, findBinary };
