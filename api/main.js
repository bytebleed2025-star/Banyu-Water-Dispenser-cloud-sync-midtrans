// Banyu online copy: ONE Vercel function that answers every /api/... path (vercel.json sends them all here).
// The machine (banyu/server.js) pushes orders, alerts and a heartbeat to /api/ingest; the online dashboard reads them back.
// Nothing here can control the machine: pouring, payments and cold settings stay on the machine's own server.
const crypto = require('crypto');
const { getDb } = require('../cloud/lib/db');
const { notify } = require('../cloud/lib/notify');
const L = require('../cloud/lib/logic');

const OFFLINE_MIN = +process.env.OFFLINE_MINUTES || 5;       // no heartbeat for this long = machine offline
const NO_WATER_MIN = +process.env.PAID_NO_WATER_MINUTES || 3; // paid but pouring never started for this long = alert
const SESSION_MS = 12 * 3600 * 1000;

// ---------- small helpers ----------
const send = (res, code, body, type = 'application/json') => {
  res.statusCode = code; res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store');
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
}
const sameSecret = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const cookieSecure = req => isHttps(req) ? '; Secure' : '';
const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
const cookies = req => { const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = c.slice(i + 1).trim(); }); return o; };

// ---------- admin login (ADMIN_PASSWORD in Vercel; several allowed, comma separated) ----------
const passwords = () => (process.env.ADMIN_PASSWORD || '').split(',').map(s => s.trim()).filter(Boolean);
const sessionSecret = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update('banyu-cloud|' + passwords().join('|') + '|' + (process.env.SYNC_SECRET || '')).digest('hex');
const sign = exp => exp + '.' + crypto.createHmac('sha256', sessionSecret()).update(String(exp)).digest('hex');
function isAdmin(req) {   // signed cookie: survives Vercel starting fresh copies of this function; changing ADMIN_PASSWORD logs everyone out
  if (!passwords().length) return false;
  const t = cookies(req).banyu_session || '', i = t.indexOf('.');
  if (i < 1 || !(+t.slice(0, i) > Date.now())) return false;
  const good = sign(+t.slice(0, i));
  return t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
}
async function login(req, res, db) {
  if (!passwords().length) return send(res, 503, { error: 'ADMIN_PASSWORD is not set in Vercel yet.' });
  const ip = clientIp(req), col = db.collection('logins'), f = (await col.findOne({ _id: ip })) || { n: 0, until: 0 };
  if (f.until > Date.now()) return send(res, 429, { error: 'Too many wrong tries. Wait a minute.' });
  const b = await readBody(req), k = typeof b.keyword === 'string' ? b.keyword.trim() : '';
  if (k && passwords().some(p => sameSecret(p, k))) {
    await col.deleteOne({ _id: ip });
    res.setHeader('Set-Cookie', `banyu_session=${sign(Date.now() + SESSION_MS)}; HttpOnly${cookieSecure(req)}; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
    return send(res, 200, { ok: true });
  }
  const n = f.n + 1, lock = n >= 5;
  await col.updateOne({ _id: ip }, { $set: { n: lock ? 0 : n, until: lock ? Date.now() + 60000 : 0 } }, { upsert: true });
  return send(res, 401, { error: 'That password is not accepted.' });
}

// ---------- alerts to Discord ----------
const who = mid => `**${mid}**`;
const ALERT_TEXT = { water_shortage: 'Water is running low', dispenser_offline: 'Dispenser not responding' };
const SOURCE_TEXT = { esp32_sensor: 'tank sensor', server: 'machine server', manual_button: 'button on the kiosk' };

async function runChecks(db, at = Date.now()) {
  const out = [];
  // 1) paid, but the pour never started: someone paid and got no water (refund candidate)
  for (const d of await db.collection('orders').find({}).toArray()) {
    const o = d.data || {};
    if (o.status !== 'paid' || o.fake || o.late_payment || d.notifiedNoWater) continue;   // late payments already got their own message
    const mins = (at - new Date(o.paid_at || o.created_at)) / 60000;
    if (mins < NO_WATER_MIN || mins > 24 * 60) continue;
    await db.collection('orders').updateOne({ _id: d._id }, { $set: { notifiedNoWater: true } });
    out.push(`💧❌ ${who(d.machineId)}: order **${o.id}** was paid ${Math.round(mins)} min ago (Rp${(o.price || 0).toLocaleString('id-ID')}, ${o.volume} ml) but no water was poured. Check the machine; refund if needed.`);
  }
  // 2) machine stopped checking in
  for (const m of await db.collection('machines').find({}).toArray()) {
    if (m.offlineNotified || !m.lastSeen || at - new Date(m.lastSeen) < OFFLINE_MIN * 60000) continue;
    await db.collection('machines').updateOne({ _id: m._id }, { $set: { offlineNotified: true } });
    out.push(`🔌 ${who(m._id)} has not checked in since ${L.jakartaTime(m.lastSeen)} WIB. The machine's computer may be off, or its internet is down.`);
  }
  for (const t of out) await notify(t);
  return out;
}

async function ingest(req, res, db) {
  const secret = process.env.SYNC_SECRET;
  if (!secret) return send(res, 503, { error: 'SYNC_SECRET is not set in Vercel' });
  if (!bearer(req) || !sameSecret(bearer(req), secret)) return send(res, 401, { error: 'wrong sync secret' });
  const b = await readBody(req), mid = String(b.machineId || '').slice(0, 64), items = Array.isArray(b.items) ? b.items : [];
  if (!mid || !/^[\w.-]+$/.test(mid)) return send(res, 400, { error: 'bad machineId' });
  if (items.length > 500) return send(res, 413, { error: 'too many items in one batch' });
  const msgs = [];
  for (const it of items) {
    if (!['order', 'alert'].includes(it.kind) || typeof it.id !== 'string' || !it.id) continue;
    const col = db.collection(it.kind === 'order' ? 'orders' : 'alerts'), _id = `${mid}:${it.id}`;
    if (!it.data) { await col.deleteOne({ _id }); continue; }
    const prev = await col.findOneAndUpdate({ _id }, { $set: { machineId: mid, id: it.id, data: it.data, updatedAt: new Date() } }, { upsert: true, returnDocument: 'before' });
    const was = prev && prev.data, x = it.data;
    if (x.fake) continue;
    if (it.kind === 'alert') {
      const label = ALERT_TEXT[x.type] || x.type;
      if (!x.resolved && (!was || was.resolved)) msgs.push(`${x.type === 'water_shortage' ? '🚰' : '⚠️'} ${who(mid)}: ${label} (from the ${SOURCE_TEXT[x.source] || x.source}, ${L.jakartaTime(x.timestamp)} WIB).`);
      else if (x.resolved && was && !was.resolved) msgs.push(`✅ ${who(mid)}: "${label}" cleared.`);
    } else if (x.status === 'paid' && x.late_payment && !(was && was.late_payment)) {
      msgs.push(`💸 ${who(mid)}: order **${x.id}** was paid AFTER the kiosk gave up waiting (Rp${(x.price || 0).toLocaleString('id-ID')}). Refund candidate.`);
    }
  }
  if (b.heartbeat && typeof b.heartbeat === 'object') {
    const prev = await db.collection('machines').findOneAndUpdate({ _id: mid },
      { $set: { lastSeen: new Date(), heartbeat: b.heartbeat, offlineNotified: false } }, { upsert: true, returnDocument: 'before' });
    if (prev && prev.offlineNotified) msgs.push(`🔌✅ ${who(mid)} is back online.`);
  } else {
    await db.collection('machines').updateOne({ _id: mid }, { $set: { lastSeen: new Date() } }, { upsert: true });
  }
  for (const t of msgs) await notify(t);
  const checked = await runChecks(db);
  // tell the machine how much we hold, so it can re-send everything if this database was ever emptied
  const counts = { orders: await db.collection('orders').countDocuments({ machineId: mid }), alerts: await db.collection('alerts').countDocuments({ machineId: mid }) };
  return send(res, 200, { ok: true, received: items.length, notified: msgs.length + checked.length, counts });
}

// ---------- what the dashboard reads ----------
async function latestMachine(db) {
  const list = await db.collection('machines').find({}).toArray();
  list.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
  const m = (process.env.MACHINE_ID && list.find(x => x._id === process.env.MACHINE_ID)) || list[0];
  if (!m) return null;
  return { id: m._id, last_seen: m.lastSeen, online: Date.now() - new Date(m.lastSeen) < OFFLINE_MIN * 60000, hb: m.heartbeat || {} };
}
const allOrders = async db => (await db.collection('orders').find({}).toArray()).map(d => d.data).filter(Boolean).sort(L.byNewest);

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const route = String((req.query && req.query.route) || url.searchParams.get('route') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  const m = req.method;
  let db;
  try { db = await getDb(); } catch (e) { console.error('[db]', e.message); return send(res, 500, { error: 'database unavailable: ' + e.message }); }
  try {
    if (route === 'ingest' && m === 'POST') return await ingest(req, res, db);
    if (route === 'check') {   // for an outside timer (cron-job.org, every 5 min): ?key=CRON_SECRET or Authorization: Bearer CRON_SECRET
      const k = bearer(req) || url.searchParams.get('key') || (req.query && req.query.key) || '';
      if (!process.env.CRON_SECRET || !k || !sameSecret(k, process.env.CRON_SECRET)) return send(res, 401, { error: 'wrong key' });
      return send(res, 200, { ok: true, notified: (await runChecks(db)).length });
    }
    if (route === 'login' && m === 'POST') return await login(req, res, db);
    if (route === 'logout' && m === 'POST') { res.setHeader('Set-Cookie', `banyu_session=; HttpOnly${cookieSecure(req)}; SameSite=Strict; Path=/; Max-Age=0`); return send(res, 200, { ok: true }); }
    if (route === 'me') return send(res, isAdmin(req) ? 200 : 401, { admin: isAdmin(req) });
    if (!isAdmin(req)) return send(res, 401, { error: 'login required' });

    if (route === 'config') {
      await runChecks(db).catch(e => console.error('[checks]', e.message));   // opening the dashboard also runs the offline / no-water checks
      const mc = await latestMachine(db), c = (mc && mc.hb.config) || {};
      return send(res, 200, { cloud: true, payment: c.payment, testMode: c.testMode, problem: c.problem, dispenser: c.dispenser,
        machine: mc && { id: mc.id, online: mc.online, last_seen: mc.last_seen } });
    }
    if (route === 'cold') { const mc = await latestMachine(db); return send(res, 200, (mc && mc.hb.cold) || {}); }
    if (route === 'dispenser') {
      const mc = await latestMachine(db), d = (mc && mc.hb.dispenser) || { mode: 'mock' };
      return send(res, 200, mc && !mc.online && d.mode === 'esp32' ? { ...d, online: false } : d);
    }
    if (route === 'stats') {
      const s = L.stats(await allOrders(db));
      s.openAlerts = (await db.collection('alerts').find({}).toArray()).filter(a => a.data && !a.data.resolved && !a.ack).length;
      return send(res, 200, s);
    }
    if (route === 'orders.csv') { res.setHeader('Content-Disposition', 'attachment; filename="banyu-orders.csv"'); return send(res, 200, L.csv(await allOrders(db)), 'text/csv; charset=utf-8'); }
    if (route === 'orders') {
      const s = url.searchParams.get('status') || (req.query && req.query.status);
      let list = (await allOrders(db)).map(o => L.withFlags(o));
      if (s === 'attention') list = list.filter(o => o.attention); else if (s) list = list.filter(o => o.status === s);
      return send(res, 200, list.slice(0, 200));
    }
    if (route === 'alerts') {
      const list = (await db.collection('alerts').find({}).toArray()).filter(a => a.data)
        .map(a => ({ ...a.data, id: a._id, resolved: !!(a.data.resolved || a.ack) })).sort(L.byNewest);
      return send(res, 200, list.slice(0, 50));
    }
    let g;
    if (m === 'POST' && (g = route.match(/^alerts\/(.+)\/resolve$/))) {   // online "Mark refilled": hides it here; the machine clears its own copy when the sensor reads OK
      const r = await db.collection('alerts').updateOne({ _id: decodeURIComponent(g[1]) }, { $set: { ack: true, ackAt: new Date() } });
      return send(res, r.matchedCount ? 200 : 404, { ok: !!r.matchedCount });
    }
    if (/^(cold\/|seed$|orders\/)/.test(route)) return send(res, 409, { error: "That can only be done on the machine's own dashboard." });
    return send(res, 404, { error: 'not found' });
  } catch (e) { console.error('[api]', route, e); return send(res, 500, { error: 'server error' }); }
}
module.exports = handler;
module.exports.runChecks = runChecks;
