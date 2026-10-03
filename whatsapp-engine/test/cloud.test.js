// Self-check for api/index.js against an in-memory fake of Supabase's REST API (gowa is not started).
// Run: node test/cloud.test.js
'use strict';
const assert = require('assert');
Object.assign(process.env, { SUPABASE_URL: 'http://fake', SUPABASE_SERVICE_ROLE_KEY: 'k', DASHBOARD_EMAIL: 'me@x.com', DASHBOARD_PASSWORD: 'pw', CRON_SECRET: 'cs', VERCEL: '1' });

const db = { engine: { state: { cloud: { lastConnectAt: Date.now() } }, locked_until: 0 }, actions: [] };
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  if (!String(u).startsWith('http://fake')) return realFetch(u, o);
  const url = new URL(u), route = url.pathname.replace('/rest/v1/', ''), body = o.body && JSON.parse(o.body);
  const ok = (v) => ({ ok: true, status: 200, text: async () => (v === undefined ? '' : JSON.stringify(v)) });
  if (route === 'rpc/acquire_engine') {
    if (db.engine.locked_until > Date.now()) return ok(null);
    db.engine.locked_until = Date.now() + body.secs * 1000;
    return ok(JSON.parse(JSON.stringify(db.engine.state)));
  }
  if (route === 'engine' && o.method === 'PATCH') {
    db.engine.state = body.state;
    if ('locked_until' in body) db.engine.locked_until = 0;
    return ok();
  }
  if (route === 'engine') return ok([{ state: db.engine.state }]);
  if (route === 'actions' && o.method === 'POST') { const a = { id: db.actions.length + 1, ...body, result: null, done_at: null }; db.actions.push(a); return ok([a]); }
  if (route === 'actions' && o.method === 'PATCH') { Object.assign(db.actions[Number(url.searchParams.get('id').slice(3)) - 1], body); return ok(); }
  if (route === 'actions') {
    const id = url.searchParams.get('id');
    return ok(id ? [db.actions[Number(id.slice(3)) - 1]] : db.actions.filter((a) => !a.done_at));
  }
  throw new Error('fake supabase: unhandled ' + route);
};

const handler = require('../api');
function call(method, path, { auth, cookie, body } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    const res = { statusCode: 0, setHeader: (k, v) => { headers[k] = v; }, end: (b) => resolve({ code: res.statusCode, headers, body: String(b) }) };
    handler({ method, url: path, headers: { ...(auth && { authorization: auth }), ...(cookie && { cookie }) }, body }, res);
  });
}

(async () => {
  assert.equal((await call('GET', '/api/tick')).code, 401, 'tick needs the cron secret');
  assert.equal((await call('GET', '/api/state')).code, 401, 'dashboard needs a login');
  assert.equal((await call('GET', '/')).headers.Location, '/login', 'page redirects to login');
  assert.match((await call('GET', '/login')).body, /<form method="post"/);
  const bad = await call('POST', '/login', { body: { user: 'me@x.com', password: 'no' } });
  assert.equal(bad.headers.Location, '/login?error=1', 'wrong password refused');
  assert.equal(bad.headers['Set-Cookie'], undefined);
  const good = await call('POST', '/login', { body: { user: ' ME@x.com ', password: 'pw' } });
  assert.equal(good.headers.Location, '/', good.body);
  const session = good.headers['Set-Cookie'].split(';')[0];
  assert.equal((await call('GET', '/api/state', { cookie: session.slice(0, -1) + (session.endsWith('0') ? '1' : '0') })).code, 401, 'tampered cookie refused');

  const st = JSON.parse((await call('GET', '/api/state', { cookie: session })).body);
  assert.equal(st.cloud, true);
  assert.equal(st.running, false);

  const start = await call('POST', '/api/action/start', { cookie: session, body: {} });
  assert.equal(start.code, 400, 'start with no contacts is refused');
  assert.match(start.body, /No contacts yet/);

  db.engine.state.contacts = [{ phone: '919999999999', status: 'pending', first: 'A' }];
  const ok = await call('POST', '/api/action/start', { cookie: session, body: {} });
  assert.equal(ok.code, 200, ok.body);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(db.engine.state.running, true, 'session saved the new state');
  assert.equal(db.engine.locked_until, 0, 'session released the lock');

  db.engine.locked_until = Date.now() + 60e3;      // another instance is mid-session
  assert.equal((await call('GET', '/api/tick', { auth: 'Bearer cs' })).code, 202);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(db.engine.state.running, true, 'locked session did not overwrite state');

  console.log('cloud self-check passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
