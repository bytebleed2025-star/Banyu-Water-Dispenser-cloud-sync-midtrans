// Banyu local server: zero dependencies, needs only Node 18+.  Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
// Settings file: put your Midtrans server key (and cloud sync settings) in settings.env (same folder as this file), then restart.
for (const f of ['settings.env', '.env']) {
  try { for (const l of fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !l.trim().startsWith('#') && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  } } catch (e) { /* file is optional */ }
}

// ===== SETTINGS (placeholders: fill in when you have the real values) =====
const CONFIG = {
  PORT: process.env.PORT || 3000,
  PAYMENT_MODE: process.env.PAYMENT_MODE || '',   // '' = automatic: 'midtrans' when a server key is set, otherwise 'mock'
  MIDTRANS_SERVER_KEY: (process.env.MIDTRANS_SERVER_KEY || '').trim(),
  MIDTRANS_ENV: (process.env.MIDTRANS_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox',   // sandbox = test money
  MIDTRANS_PAYMENTS: (process.env.MIDTRANS_PAYMENTS || '').trim(),   // e.g. other_qris,gopay. Empty = every method enabled on your Midtrans account
  // we ask Midtrans about payments ourselves, so no public notification URL is needed
  // ---- cloud copy (online dashboard + Discord alerts). Empty CLOUD_URL = no syncing, everything stays local ----
  CLOUD_URL: (process.env.CLOUD_URL || '').trim().replace(/\/+$/, ''),   // e.g. https://banyurefillstation.com
  SYNC_SECRET: (process.env.SYNC_SECRET || '').trim(),                    // same value as SYNC_SECRET in Vercel
  MACHINE_ID: (process.env.MACHINE_ID || 'banyu-kiosk-01').trim(),
  DISPENSER_MODE: process.env.DISPENSER_MODE || '',   // '' = automatic: 'esp32' when ESP32_BASE_URL is set, otherwise the tablet fakes the pour
  ESP32_BASE_URL: (process.env.ESP32_BASE_URL || '').replace(/\/+$/, ''),   // e.g. http://192.168.31.171 (set it in settings.env)
};
// ===== ADMIN LOGIN (placeholder) =====
// NOTE: for now the dashboard accepts ONLY the keywords listed in ADMIN_KEYWORDS (settings.env, comma separated).
// There are no user accounts and no database behind it yet. Anyone who knows one of the keywords gets in.
// Later this is meant to be replaced by real admin accounts in a database (see README, "Admin login").
const crypto = require('crypto');
const KEYWORDS_SET = !!(process.env.ADMIN_KEYWORDS || '').trim();
const ADMIN_KEYWORDS = (process.env.ADMIN_KEYWORDS || 'banyu-admin').split(',').map(k => k.trim()).filter(Boolean);
const sha = x => crypto.createHash('sha256').update(String(x)).digest();
const KEYWORD_HASHES = ADMIN_KEYWORDS.map(sha);
const keywordOk = k => KEYWORD_HASHES.map(h => crypto.timingSafeEqual(h, sha(k))).some(Boolean);   // constant-time compare
const SESSION_MS = 12 * 3600 * 1000;
const SECRET = process.env.SESSION_SECRET || sha('banyu-session|' + ADMIN_KEYWORDS.join('|')).toString('hex');
const sign = exp => exp + '.' + crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
const failed = new Map();                                     // ip -> { n, until }: slows down keyword guessing
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = c.slice(i + 1).trim(); }); return o; }
function isAdmin(req) {
  const t = cookies(req).banyu_session || '', i = t.indexOf('.');
  if (i < 1 || !(+t.slice(0, i) > Date.now())) return false;
  const good = sign(+t.slice(0, i));
  return t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
}

// ===== MIDTRANS (Snap checkout). Sandbox = test money, production = real money (MIDTRANS_ENV in settings.env) =====
const MKEY = CONFIG.MIDTRANS_SERVER_KEY, HAS_KEY = MKEY.length > 10 && !MKEY.startsWith('<');
const MTEST = CONFIG.MIDTRANS_ENV !== 'production';
const KEY_PROBLEM = !HAS_KEY ? 'no MIDTRANS_SERVER_KEY found in settings.env'
  : /^SB-Mid-client|^Mid-client/.test(MKEY) ? 'that is the CLIENT key; the SERVER key is needed' : '';
const KEY_WARNING = !HAS_KEY ? '' : (MKEY.startsWith('SB-') && !MTEST) ? 'this looks like a SANDBOX key but MIDTRANS_ENV=production'
  : (/^Mid-server-/.test(MKEY) && MTEST) ? 'this looks like a PRODUCTION key but MIDTRANS_ENV is sandbox' : '';
if (!CONFIG.PAYMENT_MODE) CONFIG.PAYMENT_MODE = HAS_KEY && !KEY_PROBLEM ? 'midtrans' : 'mock';
const MT_SNAP = process.env.MIDTRANS_SNAP_BASE || (MTEST ? 'https://app.sandbox.midtrans.com/snap/v1' : 'https://app.midtrans.com/snap/v1');
const MT_API = process.env.MIDTRANS_API_BASE || (MTEST ? 'https://api.sandbox.midtrans.com/v2' : 'https://api.midtrans.com/v2');
const lastLog = {};
function logThrottled(m) { const t = Date.now(); if (!lastLog[m] || t - lastLog[m] > 30000) { lastLog[m] = t; console.error(m); } }   // same message at most every 30s
const NET_HINT = { ENOTFOUND: 'cannot look up the address: no internet or DNS problem on this computer', ETIMEDOUT: 'timed out: no internet, or a firewall/VPN is blocking it',
  ECONNREFUSED: 'connection refused', ECONNRESET: 'connection dropped (weak Wi-Fi, VPN or antivirus?)', EAI_AGAIN: 'DNS problem: no internet on this computer',
  CERT_HAS_EXPIRED: 'certificate error: check this computer\'s date and time', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate error: antivirus or network is intercepting HTTPS' };
function netError(e, who) {   // turn low-level network errors into a sentence a person can act on
  if (e.name === 'TimeoutError') return new Error(`cannot reach ${who} (timeout): ${NET_HINT.ETIMEDOUT}`);
  const c = e.cause && (e.cause.code || e.cause.message);
  return c ? new Error(`cannot reach ${who} (${c}): ${NET_HINT[c] || 'check this computer\'s internet connection'}`) : e;
}
// Returns { status, body }. Midtrans answers "not found" with 404 until the customer has picked a payment method.
async function midtrans(method, url, body) {
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(10000), method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Basic ' + Buffer.from(MKEY + ':').toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json' } }); }
  catch (e) { throw netError(e, 'Midtrans'); }
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
const mtMessage = res => `Midtrans ${res.status}: ${(res.body.error_messages || [res.body.status_message || 'no details']).join('; ')}`;
async function mtExpire(o) {   // best effort: make an abandoned payment impossible to complete
  if (!o.midtrans_order_id || o.mt_expire_sent || o.payment_id) return;
  o.mt_expire_sent = true; save();
  try { await midtrans('POST', `${MT_API}/${encodeURIComponent(o.midtrans_order_id)}/expire`); } catch (e) { logThrottled('[midtrans expire] ' + e.message); }
}
// Every 2s: ask Midtrans whether recent orders were paid. Also catches payments that land just AFTER the kiosk gave up.
let mtPolling = false;
setInterval(async () => {
  if (CONFIG.PAYMENT_MODE !== 'midtrans' || mtPolling) return;
  mtPolling = true;
  try {
    for (const o of db.orders) {
      const age = Date.now() - new Date(o.created_at);
      if (!o.midtrans_order_id || o.payment_id || age > 900000) continue;
      if (o.status === 'awaiting_payment' && age > 310000) { setStatus(o, 'expired'); save(); }
      if (['expired', 'cancelled'].includes(o.status)) mtExpire(o);
      if (!['awaiting_payment', 'expired', 'cancelled'].includes(o.status)) continue;
      try {
        const res = await midtrans('GET', `${MT_API}/${encodeURIComponent(o.midtrans_order_id)}/status`);
        if (res.status === 404 || res.body.status_code === '404') continue;   // customer has not chosen a method yet
        if (res.status >= 400) { logThrottled('[midtrans status] ' + mtMessage(res)); continue; }
        const ts = res.body.transaction_status, fraud = res.body.fraud_status;
        if (ts === 'settlement' || (ts === 'capture' && (!fraud || fraud === 'accept'))) {
          o.payment_id = res.body.transaction_id || o.midtrans_order_id; o.payment_type = res.body.payment_type || null;
          if (o.status === 'awaiting_payment') setStatus(o, 'paid');
          else { o.status = 'paid'; o.late_payment = true; o.paid_at = now(); o.ended_at = null; }   // paid after we gave up: refund candidate
          save();
        } else if (o.status === 'awaiting_payment' && ['expire', 'cancel', 'deny', 'failure'].includes(ts)) {
          setStatus(o, ts === 'expire' ? 'expired' : 'cancelled'); save();
        }
      } catch (e) { logThrottled('[midtrans status] ' + e.message); }
    }
  } finally { mtPolling = false; }
}, 2000);

if (!CONFIG.DISPENSER_MODE) CONFIG.DISPENSER_MODE = CONFIG.ESP32_BASE_URL ? 'esp32' : 'mock';
const PRICES = { 300: 2000, 600: 2500, 900: 5000 };   // server decides prices, not the tablet
const TERMINAL = ['completed', 'stopped', 'expired', 'cancelled'];
const STATUSES = ['awaiting_payment', 'paid', 'dispensing', ...TERMINAL];
const DB_FILE = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { seq: 0, orders: [], alerts: [] };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const now = () => new Date().toISOString();
const pad = (n, l) => String(n).padStart(l, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;

function newOrder(kioskId, volume, temp, when, fake) {
  db.seq++;
  const d = when || new Date();
  return { id: `BNY-${ymd(d)}-${pad(db.seq, 4)}`, kioskId, volume, temp, channel: temp === 'dingin' ? 'cold' : 'normal',
    price: PRICES[volume], status: 'awaiting_payment', dispensed_ml: 0, created_at: d.toISOString(),
    paid_at: null, started_at: null, ended_at: null, fake: !!fake };
}
function setStatus(o, status, ml) {
  if (TERMINAL.includes(o.status)) return false;           // finished orders never change
  o.status = status; const t = now();
  if (status === 'paid') o.paid_at = t;
  if (status === 'dispensing' && !o.started_at) o.started_at = t;
  if (TERMINAL.includes(status)) { o.ended_at = t; if (ml != null) o.dispensed_ml = Math.min(ml, o.volume); }
  return true;
}
const withFlags = o => {
  const age = (Date.now() - new Date(o.paid_at || o.created_at)) / 60000;
  return { ...o, attention: (o.status === 'paid' && age > 2) || (o.status === 'dispensing' && age > 10),
    qc: o.status === 'completed' && o.variance_pct != null && Math.abs(o.variance_pct) > 5 };   // poured amount off by more than 5%
};
const paidStatuses = ['paid', 'dispensing', 'completed', 'stopped'];

// ===== COLD WATER ESTIMATOR =====
// The cold tank holds ~2 L. Every cold sale pulls water out and the tank refills with warm water, which the chiller then has
// to cool again. We model it as a "cold level": each cold sale subtracts its ml, and the level climbs back at a steady rate.
// Nothing is stored except the sales themselves: the level is recomputed from the order timestamps, so a restart loses nothing.
// The numbers below are first guesses. Calibrate them with a thermometer at the cold outlet (see README).
db.cold = db.cold || { override: 'auto', baseline: null };   // override: 'auto' | 'on' | 'off'. baseline: { at, level } set by the admin buttons
const numEnv = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && !isNaN(+process.env[k])) ? +process.env[k] : d;
const COLD = { CAP: numEnv('COLD_CAPACITY_ML', 2000), RATE: numEnv('COLD_RECOVER_ML_MIN', 22),   // 2 L in ~1.5 h = ~22 ml/min
  COLD_ABOVE: numEnv('COLD_ABOVE_ML', 1500), LOCK_BELOW: numEnv('COLD_LOCK_BELOW_ML', 1000), REENABLE_AT: numEnv('COLD_REENABLE_AT_ML', 1250) };
function coldModel(at = Date.now()) {
  const windowMs = (COLD.CAP / COLD.RATE + 30) * 60000, wStart = at - windowMs, b = db.cold.baseline;
  const base = b && +new Date(b.at) > wStart ? { t: +new Date(b.at), level: b.level } : { t: wStart, level: COLD.CAP };   // older than a full recovery = tank is back to full
  const ev = db.orders.filter(o => o.temp === 'dingin' && !o.fake && ['dispensing', 'completed', 'stopped'].includes(o.status))
    .map(o => ({ id: o.id, t: +new Date(o.started_at || o.paid_at || o.created_at), ml: o.status === 'dispensing' ? o.volume : (o.dispensed_ml || 0) }))
    .filter(e => e.ml > 0 && e.t > base.t && e.t <= at).sort((a, b2) => a.t - b2.t);
  let level = base.level, t = base.t, disabled = level < COLD.LOCK_BELOW, since = level < COLD.CAP ? base.t : null;
  const advance = to => { level = Math.min(COLD.CAP, level + (to - t) / 60000 * COLD.RATE); t = to;
    if (disabled && level >= COLD.REENABLE_AT) disabled = false;   // hysteresis: back on at REENABLE_AT, not right at the lock line
    if (level >= COLD.CAP) since = null; };
  for (const e of ev) { advance(e.t); if (since === null) since = e.t; level = Math.max(0, level - e.ml); if (level < COLD.LOCK_BELOW) disabled = true; }
  advance(at);
  const autoState = disabled ? 'disabled' : level >= COLD.COLD_ABOVE ? 'cold' : 'cool';
  const ov = db.cold.override;
  const state = ov === 'off' ? 'disabled' : ov === 'on' ? (autoState === 'disabled' ? 'cool' : autoState) : autoState;
  const mins = target => Math.max(0, Math.ceil((target - level) / COLD.RATE));
  return { level: Math.round(level), capacity: COLD.CAP, state, auto_state: autoState, override: ov || 'auto', enabled: state !== 'disabled',
    thresholds: { cold_above: COLD.COLD_ABOVE, lock_below: COLD.LOCK_BELOW, reenable_at: COLD.REENABLE_AT }, recover_ml_per_min: COLD.RATE,
    back_in_min: autoState === 'disabled' ? mins(COLD.REENABLE_AT) : 0,   // minutes until cold sales resume (auto mode)
    cold_again_in_min: level >= COLD.COLD_ABOVE ? 0 : mins(COLD.COLD_ABOVE), full_in_min: mins(COLD.CAP),
    tracking_since: since ? new Date(since).toISOString() : null,   // first cold sale of the current streak; empty once the tank has fully recovered
    last_set: b ? { at: b.at, level: b.level } : null, recent: ev.slice(-6).reverse().map(e => ({ id: e.id, time: new Date(e.t).toISOString(), ml: Math.round(e.ml) })) };
}
const coldAvailable = () => coldModel().enabled;

function stats() {
  const today = ymd(new Date()), O = db.orders;
  const t = O.filter(o => ymd(new Date(o.created_at)) === today);
  const paid = t.filter(o => paidStatuses.includes(o.status));
  const done = O.filter(o => o.status === 'completed').length, stp = O.filter(o => o.status === 'stopped').length;
  const by = (key, vals) => vals.map(v => ({ key: v, orders: paid.filter(o => String(o[key]) === String(v)).length }));
  return { ordersToday: t.length, paidToday: paid.length, revenueToday: paid.reduce((s, o) => s + o.price, 0),
    mlToday: Math.round(paid.reduce((s, o) => s + o.dispensed_ml, 0)),
    completionRate: done + stp ? Math.round(100 * done / (done + stp)) : null,
    attention: O.filter(o => withFlags(o).attention).length, openAlerts: db.alerts.filter(a => !a.resolved).length,
    bottlesSaved: done, byTemp: by('temp', ['ruang', 'dingin']), byVolume: by('volume', [300, 600, 900]),
    fakeCount: O.filter(o => o.fake).length };
}
function seed(n) {
  const r = Math.random;
  for (let i = 0; i < n; i++) {
    const when = new Date(Date.now() - r() * 7 * 864e5), vol = [300, 600, 900][Math.floor(r() * 3)];
    const o = newOrder('banyu-kiosk-01', vol, r() < 0.4 ? 'dingin' : 'ruang', when, true), x = r();
    if (x < 0.06) { setStatus(o, 'expired'); }
    else { setStatus(o, 'paid');
      if (x < 0.10) { if (when < Date.now() - 36e5) { /* stays paid, no water: needs attention */ } }
      else if (x < 0.20) { setStatus(o, 'dispensing'); setStatus(o, 'stopped', Math.round(vol * (0.1 + r() * 0.7))); }
      else { setStatus(o, 'dispensing'); setStatus(o, 'completed', vol); } }
    o.paid_at = o.paid_at && when.toISOString(); o.ended_at = o.ended_at && new Date(+when + 9e4).toISOString();
    db.orders.push(o);
  }
  if (!db.alerts.some(a => a.fake)) db.alerts.push({ id: 'A-demo', type: 'water_shortage', source: 'manual_button', kioskId: 'banyu-kiosk-01', timestamp: now(), resolved: false, fake: true });
}
const csv = () => ['id,created_at,kiosk,volume_ml,temp,price_idr,status,dispensed_ml,paid_at,ended_at,payment_id,payment_type,dispenser_ml,duration_s,variance_pct,sample']
  .concat(db.orders.map(o => [o.id, o.created_at, o.kioskId, o.volume, o.temp, o.price, o.status, o.dispensed_ml, o.paid_at || '', o.ended_at || '', o.payment_id || o.xendit_payment_id || '', o.payment_type || '', o.dispenser_ml ?? '', o.duration_s ?? '', o.variance_pct ?? '', o.fake].join(','))).join('\n');

// ===== DISPENSER (ESP32, see API.md). We ask it for status: every 1s during a pour, every 5s otherwise =====
const TANK_LOW_MS = (+process.env.TANK_LOW_SECONDS || 20) * 1000, OFFLINE_MS = (+process.env.OFFLINE_SECONDS || 30) * 1000;
const disp = { online: false, lastOk: Date.now(), status: null, lowSince: 0, okSince: 0 };
async function esp(p) {
  const r = await fetch(CONFIG.ESP32_BASE_URL + p, { signal: AbortSignal.timeout(3000), cache: 'no-store' });
  return { ok: r.ok, text: (await r.text()).trim() };
}
function raiseAlert(type, source) {   // one open alert per kind, never a flood
  if (db.alerts.some(a => a.type === type && a.source === source && !a.resolved)) return;
  db.alerts.push({ id: 'A-' + Date.now(), type, source, kioskId: 'banyu-kiosk-01', timestamp: now(), resolved: false }); save();
}
function clearAlert(type, source) {
  let ch = false; db.alerts.forEach(a => { if (a.type === type && a.source === source && !a.resolved) { a.resolved = true; ch = true; } });
  if (ch) save();
}
function availability() {   // never sell water we cannot pour
  if (CONFIG.DISPENSER_MODE !== 'esp32') return { ok: true };
  if (!disp.status || Date.now() - disp.lastOk > 12000) return { ok: false, reason: 'dispenser offline' };   // tolerates one missed reading
  if (disp.status.tank_low) return { ok: false, reason: 'tank low' };
  if (disp.status.job_active) return { ok: false, reason: 'busy' };
  return { ok: true };
}
function onStatus(st) {
  const t = Date.now();
  if (st.tank_low) { disp.okSince = 0; disp.lowSince = disp.lowSince || t; if (t - disp.lowSince >= TANK_LOW_MS) raiseAlert('water_shortage', 'esp32_sensor'); }
  else { disp.lowSince = 0; disp.okSince = disp.okSince || t; if (t - disp.okSince >= TANK_LOW_MS) clearAlert('water_shortage', 'esp32_sensor'); }
  const o = db.orders.find(x => x.status === 'dispensing');
  if (!o) return;
  if (st.job_active) {
    o.dispensed_ml = Math.min(st.job_ml, o.volume); o.last_active_ml = st.job_ml; o.paused = st.job_paused; save();
  } else if (t - (o.dispense_started_ms || 0) > 1500) {   // job over: job_ml is NOT frozen by the device, so record it now
    const ml = Math.max(o.last_active_ml || 0, st.job_ml || 0), err = st.error || '';
    const ok = ml >= o.volume * 0.95 && !/stopped|timeout|tank|no flow/i.test(err);
    o.dispenser_ml = ml; o.dispenser_error = err; o.duration_s = Math.round((t - o.dispense_started_ms) / 1000);
    o.variance_pct = Math.round((ml - o.volume) / o.volume * 1000) / 10; o.paused = false;
    setStatus(o, ok ? 'completed' : 'stopped', ml); save();
  }
}
const ESP_HINT = { TimeoutError: 'no reply: the ESP is probably not on this network, or its IP changed', UND_ERR_CONNECT_TIMEOUT: 'no reply: the ESP is probably not on this network, or its IP changed',
  ETIMEDOUT: 'no reply: the ESP is probably not on this network, or its IP changed', EHOSTUNREACH: 'no route to the ESP: it is not on this network (check its Wi-Fi), or the IP is wrong',
  ENETUNREACH: 'this computer is not on the ESP\'s network', ECONNREFUSED: 'the address answers but nothing listens there: wrong IP?', ECONNRESET: 'connection dropped mid-way: weak signal or the ESP restarted',
  SyntaxError: 'got an answer that is not the dispenser status: wrong address?' };
function connEvent(type) {   // keep a diary of every drop, with what the ESP last reported, to find the cause
  const st = disp.status || {}, t = Date.now();
  const e = { time: now(), event: type, rssi: st.rssi, wifi: st.wifi_status_name, job_state: st.job_state, pump_on: !!(st.pump_cold || st.pump_normal), flow_lpm: st.flow_lpm };
  if (type === 'offline') disp.downSince = disp.lastOk;
  if (type === 'online' && disp.downSince) { e.down_s = Math.round((t - disp.downSince) / 1000); disp.downSince = 0; }
  db.dispenserLog = (db.dispenserLog || []).concat(e).slice(-200); save();
  console.log('[dispenser]', type.toUpperCase(), type === 'offline' ? `(last reading: signal ${e.rssi} dBm, ${e.job_state}${e.pump_on ? ', PUMP ON' : ''})` : e.down_s != null ? `(was down ${e.down_s}s)` : '');
}
function dispenserInfo() {   // what the dashboards show about the dispenser connection
  const st = disp.status || {};
  return CONFIG.DISPENSER_MODE !== 'esp32' ? { mode: 'mock' } :
        { mode: 'esp32', online: disp.online, tank_low: !!st.tank_low, tank_state: st.tank_state, job_state: st.job_state, flow_lpm: st.flow_lpm, rssi: st.rssi,
          wifi: st.wifi_status_name, last_seen_s: Math.round((Date.now() - disp.lastOk) / 1000), last_error: disp.lastErr || null,
          drops_24h: (db.dispenserLog || []).filter(e => e.event === 'offline' && Date.now() - new Date(e.time) < 864e5).length,
          log: (db.dispenserLog || []).slice(-10).reverse() };
}
let polling = false;
async function pollDispenser() {
  if (CONFIG.DISPENSER_MODE !== 'esp32' || polling) return;   // never two requests at once: the ESP32 serves them one by one
  polling = true;
  try {
    const st = JSON.parse((await esp('/api/status')).text);
    disp.status = st; disp.lastOk = Date.now(); disp.fails = 0; disp.lastErr = null;
    if (!disp.online) { disp.online = true; connEvent('online'); }
    clearAlert('dispenser_offline', 'server'); onStatus(st);
  } catch (e) {
    const c = (e.cause && e.cause.code) || e.name; disp.fails = (disp.fails || 0) + 1; disp.lastErr = c;
    logThrottled(`[dispenser] cannot reach ${CONFIG.ESP32_BASE_URL} (${c}): ${ESP_HINT[c] || 'unknown network problem'}`);
    if (disp.online && disp.fails >= 2) { disp.online = false; connEvent('offline'); }   // one missed reply is tolerated
    if (Date.now() - disp.lastOk > OFFLINE_MS) raiseAlert('dispenser_offline', 'server');
  } finally { polling = false; }
}
let loopTimer;
const schedule = () => { clearTimeout(loopTimer); loopTimer = setTimeout(kick, db.orders.some(o => o.status === 'dispensing') ? 1000 : 5000); };
async function kick() { clearTimeout(loopTimer); await pollDispenser(); schedule(); }   // also called right after every command, so progress shows at once
kick();

// ===== CLOUD COPY (online dashboard on CLOUD_URL + Discord alerts) =====
// This computer stays the source of truth. Every 5s we send the orders and alerts that changed since the last
// successful upload; nothing is marked as sent until the cloud says OK, so an internet outage only delays the copy.
// Once a minute we also send a heartbeat (dispenser state, cold estimate) so the cloud can tell when this machine goes quiet.
db.sync = db.sync || { sent: {} };   // "order:ID" / "alert:ID" -> fingerprint of the version the cloud has
const fp = x => crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const sync = { busy: false, lastOk: null, lastError: null, lastBeat: 0 };
function syncPending(limit = 100) {
  const out = [], seen = new Set();
  for (const [kind, list] of [['order', db.orders], ['alert', db.alerts]]) for (const x of list) {
    const key = kind + ':' + x.id, h = fp(x); seen.add(key);
    if (db.sync.sent[key] !== h) out.push({ kind, id: x.id, data: x, h });
  }
  for (const key of Object.keys(db.sync.sent)) if (!seen.has(key)) {   // deleted here (e.g. "Clear sample data"): delete in the cloud too
    const i = key.indexOf(':'); out.push({ kind: key.slice(0, i), id: key.slice(i + 1), data: null, h: null });
  }
  return { items: out.slice(0, limit), total: out.length };
}
function heartbeat() {
  return { at: now(), config: { payment: CONFIG.PAYMENT_MODE, testMode: MTEST, problem: KEY_PROBLEM, dispenser: CONFIG.DISPENSER_MODE },
    cold: coldModel(), dispenser: dispenserInfo(), availability: availability() };
}
async function syncNow() {
  if (!CONFIG.CLOUD_URL || !CONFIG.SYNC_SECRET || sync.busy) return;
  const { items } = syncPending(), beat = Date.now() - sync.lastBeat >= 60000;
  if (!items.length && !beat) return;
  sync.busy = true;
  try {
    let r;
    try { r = await fetch(CONFIG.CLOUD_URL + '/api/ingest', { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CONFIG.SYNC_SECRET },
      body: JSON.stringify({ machineId: CONFIG.MACHINE_ID, items: items.map(({ h, ...rest }) => rest), heartbeat: beat ? heartbeat() : undefined }) }); }
    catch (e) { throw netError(e, CONFIG.CLOUD_URL); }
    if (!r.ok) { const t = (await r.text()).slice(0, 200);
      throw new Error(`cloud said ${r.status}${r.status === 401 ? ' (SYNC_SECRET here does not match SYNC_SECRET in Vercel)' : r.status === 404 ? ' (wrong CLOUD_URL, or the cloud part is not deployed)' : ''}: ${t}`); }
    for (const it of items) { const key = it.kind + ':' + it.id; if (it.data) db.sync.sent[key] = it.h; else delete db.sync.sent[key]; }
    if (items.length) save();
    const j = await r.json().catch(() => ({})), c = j.counts;
    if (c && syncPending(1).total === 0 && (c.orders < db.orders.length || c.alerts < db.alerts.length)) {
      console.warn(`[cloud sync] the cloud has ${c.orders}/${db.orders.length} orders and ${c.alerts}/${db.alerts.length} alerts: sending everything again`);
      db.sync.sent = {}; save();
    }
    if (beat) sync.lastBeat = Date.now();
    sync.lastOk = now(); sync.lastError = null;
  } catch (e) { sync.lastError = e.message; logThrottled('[cloud sync] ' + e.message); }
  finally { sync.busy = false; }
}
const syncInfo = () => ({ enabled: !!(CONFIG.CLOUD_URL && CONFIG.SYNC_SECRET), url: CONFIG.CLOUD_URL || null, last_ok: sync.lastOk, last_error: sync.lastError, pending: syncPending(1e9).total });
setInterval(syncNow, 5000); setTimeout(syncNow, 1500);

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  let g;
  // --- who may call what: the kiosk (tablet) stays open, everything admin-only needs the dashboard login ---
  const kioskOpen = (m === 'GET' && (p === '/api/config' || p === '/api/cold/public' || /^\/api\/orders\/[\w-]+$/.test(p)))
    || (m === 'POST' && (p === '/api/orders' || p === '/api/alerts' || /^\/api\/orders\/[\w-]+\/(status|start|pause|resume|stop)$/.test(p)));
  if (p === '/api/login' && m === 'POST') {
    const ip = req.socket.remoteAddress, f = failed.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return send(res, 429, { error: 'Too many wrong tries. Wait a minute.' });
    const b = await readBody(req);
    if (typeof b.keyword === 'string' && keywordOk(b.keyword.trim())) {
      failed.delete(ip); const t = sign(Date.now() + SESSION_MS);
      res.setHeader('Set-Cookie', `banyu_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));
      return send(res, 200, { ok: true });
    }
    f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } failed.set(ip, f);
    return send(res, 401, { error: 'That keyword is not accepted.' });
  }
  if (p === '/api/logout' && m === 'POST') { res.setHeader('Set-Cookie', 'banyu_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
  if (p === '/api/me' && m === 'GET') return send(res, isAdmin(req) ? 200 : 401, { admin: isAdmin(req) });
  if (p.startsWith('/api/') && !kioskOpen && !isAdmin(req)) return send(res, 401, { error: 'login required' });
  if (p === '/dashboard.html' && !isAdmin(req)) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
  if (p.startsWith('/api/')) {
    if (m === 'GET' && p === '/api/config') return send(res, 200, { payment: CONFIG.PAYMENT_MODE, dispenser: CONFIG.DISPENSER_MODE, testMode: MTEST, problem: KEY_PROBLEM, flow: CONFIG.PAYMENT_MODE === 'midtrans' ? 'invoice' : 'mock', sync: syncInfo() });
    if (m === 'GET' && p === '/api/cold/public') { const c = coldModel(); return send(res, 200, { state: c.state, enabled: c.enabled, back_in_min: c.enabled ? 0 : Math.max(c.back_in_min, 1) }); }   // the tablet only needs this much
    if (m === 'GET' && p === '/api/cold') return send(res, 200, coldModel());
    if (m === 'POST' && p === '/api/cold/override') {   // admin: 'auto' = follow the estimator, 'on' = never block cold, 'off' = block cold
      const b = await readBody(req); if (!['auto', 'on', 'off'].includes(b.mode)) return send(res, 400, { error: 'mode must be auto, on or off' });
      db.cold.override = b.mode; save(); return send(res, 200, coldModel());
    }
    if (m === 'POST' && p === '/api/cold/reset') {   // admin: tell the estimator what the tank is like right now (machine just switched on = 0, known cold and full = capacity)
      const b = await readBody(req), lv = Number(b.level_ml); if (!isFinite(lv) || lv < 0 || lv > COLD.CAP) return send(res, 400, { error: 'level_ml must be 0 to ' + COLD.CAP });
      db.cold.baseline = { at: now(), level: lv }; save(); return send(res, 200, coldModel());
    }
    if (m === 'GET' && p === '/api/stats') return send(res, 200, stats());
    if (m === 'GET' && p === '/api/orders.csv') return send(res, 200, csv(), 'text/csv; charset=utf-8');
    if (m === 'GET' && p === '/api/orders') {
      const s = url.searchParams.get('status'); let list = db.orders.map(withFlags);
      if (s === 'attention') list = list.filter(o => o.attention); else if (s) list = list.filter(o => o.status === s);
      return send(res, 200, list.reverse().slice(0, 200));
    }
    if (m === 'POST' && p === '/api/orders') {
      const b = await readBody(req);
      if (!PRICES[b.volume] || !['ruang', 'dingin'].includes(b.temp)) return send(res, 400, { error: 'bad volume or temp' });
      const av = availability(); if (!av.ok) return send(res, 503, { error: 'unavailable', reason: av.reason });
      if (b.temp === 'dingin' && !coldAvailable()) return send(res, 503, { error: 'unavailable', reason: 'cold unavailable' });   // cold tank is running low
      const o = newOrder(b.kioskId || 'banyu-kiosk-01', b.volume, b.temp); db.orders.push(o);
      if (CONFIG.PAYMENT_MODE === 'midtrans') {   // Midtrans Snap: the tablet goes to Midtrans's payment page and comes back to /?order=ID
        try {
          const origin = 'http://' + (req.headers.host || 'localhost:' + CONFIG.PORT);
          o.midtrans_order_id = `${o.id}-${crypto.randomBytes(2).toString('hex')}`;   // unique even if db.json is ever reset
          const body = { transaction_details: { order_id: o.midtrans_order_id, gross_amount: o.price },
            item_details: [{ id: `${o.volume}-${o.temp}`, price: o.price, quantity: 1, name: `Banyu ${o.volume} ml ${o.temp === 'dingin' ? 'dingin' : 'suhu ruang'}` }],
            expiry: { unit: 'minutes', duration: 5 }, callbacks: { finish: `${origin}/?order=${o.id}` },
            custom_field1: o.kioskId, custom_field2: o.id };
          if (CONFIG.MIDTRANS_PAYMENTS) body.enabled_payments = CONFIG.MIDTRANS_PAYMENTS.split(',').map(x => x.trim()).filter(Boolean);
          const r = await midtrans('POST', `${MT_SNAP}/transactions`, body);
          if (r.status >= 400 || !r.body.redirect_url) throw new Error(mtMessage(r));
          o.payment_url = r.body.redirect_url; o.snap_token = r.body.token;
        } catch (e) { console.error('[midtrans create]', e.message); setStatus(o, 'cancelled'); o.error = e.message; save(); return send(res, 502, { error: 'payment unavailable' }); }
      }
      save(); return send(res, 201, o);
    }
    if (m === 'POST' && (g = p.match(/^\/api\/orders\/([\w-]+)\/status$/))) {
      const o = db.orders.find(x => x.id === g[1]), b = await readBody(req);
      if (!o) return send(res, 404, { error: 'no such order' });
      if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'bad status' });
      if (CONFIG.PAYMENT_MODE === 'midtrans' && b.status === 'paid') return send(res, 403, { error: 'only Midtrans can mark an order paid' });
      if (CONFIG.DISPENSER_MODE === 'esp32' && ['dispensing', 'completed', 'stopped'].includes(b.status)) return send(res, 403, { error: 'only the dispenser decides that' });
      const ok = setStatus(o, b.status, b.dispensed_ml); save();
      if (ok && ['cancelled', 'expired'].includes(b.status)) mtExpire(o);   // customer walked away: close the payment at Midtrans too
      return send(res, ok ? 200 : 409, o);
    }
    if (m === 'GET' && (g = p.match(/^\/api\/orders\/([\w-]+)$/))) {
      const o = db.orders.find(x => x.id === g[1]); return o ? send(res, 200, o) : send(res, 404, { error: 'no such order' });
    }
    if (m === 'GET' && p === '/api/dispenser') return send(res, 200, dispenserInfo());
    if (m === 'POST' && (g = p.match(/^\/api\/orders\/([\w-]+)\/(start|pause|resume|stop)$/))) {   // only the server talks to the dispenser
      const o = db.orders.find(x => x.id === g[1]), act = g[2];
      if (!o) return send(res, 404, { error: 'no such order' });
      if (CONFIG.DISPENSER_MODE !== 'esp32') return send(res, 409, { error: 'dispenser is in demo mode' });
      if (act === 'start' ? o.status !== 'paid' : o.status !== 'dispensing') return send(res, 409, { error: 'wrong state: ' + o.status });
      try {
        const r = await esp(act === 'start' ? `/api/dispense?channel=${o.channel}&ml=${o.volume}` : `/api/${act}`);
        if (!r.ok) { o.dispense_error = r.text; save(); return send(res, 409, { error: r.text }); }   // paid order stays "paid, no water" -> refund
        if (act === 'start') { setStatus(o, 'dispensing'); o.dispense_started_ms = Date.now(); o.last_active_ml = 0; o.dispense_error = null; }
        save(); setTimeout(kick, 300); return send(res, 200, o);
      } catch (e) { o.dispense_error = 'dispenser unreachable'; save(); return send(res, 502, { error: 'dispenser unreachable' }); }
    }
    if (m === 'GET' && p === '/api/alerts') return send(res, 200, db.alerts.slice().reverse().slice(0, 50));
    if (m === 'POST' && p === '/api/alerts') {   // water shortage: from the button now, from the ESP32 sensor later
      const b = await readBody(req); const a = { id: 'A-' + Date.now(), type: b.type || 'water_shortage', source: b.source || 'unknown',
        kioskId: b.kioskId || 'banyu-kiosk-01', timestamp: b.timestamp || now(), resolved: false }; db.alerts.push(a); save(); return send(res, 201, a);
    }
    if (m === 'POST' && (g = p.match(/^\/api\/alerts\/([\w-]+)\/resolve$/))) {
      const a = db.alerts.find(x => x.id === g[1]); if (!a) return send(res, 404, {}); a.resolved = true; save(); return send(res, 200, a);
    }
    if (m === 'POST' && p === '/api/seed') { seed(60); save(); return send(res, 200, stats()); }
    if (m === 'DELETE' && p === '/api/seed') { db.orders = db.orders.filter(o => !o.fake); db.alerts = db.alerts.filter(a => !a.fake); save(); return send(res, 200, stats()); }
    return send(res, 404, { error: 'not found' });
  }
  const file = path.join(__dirname, 'public', p === '/' ? 'index.html' : p);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}).listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`Banyu running. Kiosk: http://localhost:${CONFIG.PORT}  Dashboard: http://localhost:${CONFIG.PORT}/dashboard.html`);
  if (CONFIG.PAYMENT_MODE === 'midtrans') console.log(`PAYMENT: Midtrans ${MTEST ? 'SANDBOX (no real money)' : 'PRODUCTION (REAL MONEY)'} | methods: ${CONFIG.MIDTRANS_PAYMENTS || 'all enabled on the account'} | key ${MKEY.slice(0, 10)}...`);
  else console.log(`PAYMENT: DEMO MODE. Midtrans is NOT connected (${KEY_PROBLEM || 'PAYMENT_MODE=mock'}). Edit settings.env and restart.`);
  if (KEY_WARNING) console.warn('PAYMENT WARNING: ' + KEY_WARNING);
  console.log(CONFIG.CLOUD_URL && CONFIG.SYNC_SECRET ? `CLOUD SYNC: on, to ${CONFIG.CLOUD_URL} as "${CONFIG.MACHINE_ID}"` : `CLOUD SYNC: off (${CONFIG.CLOUD_URL ? 'SYNC_SECRET' : 'CLOUD_URL'} is empty in settings.env). Data stays on this computer only.`);
  console.log(KEYWORDS_SET ? `DASHBOARD LOGIN: ${ADMIN_KEYWORDS.length} keyword(s) accepted (from settings.env)` : 'DASHBOARD LOGIN: WARNING, ADMIN_KEYWORDS is not set in settings.env, so the default keyword "banyu-admin" works. Change it.');
  console.log(`COLD ESTIMATOR: ${COLD.CAP} ml tank, recovers ${COLD.RATE} ml/min, Cold above ${COLD.COLD_ABOVE}, locked below ${COLD.LOCK_BELOW}, back on at ${COLD.REENABLE_AT}`);
  console.log(CONFIG.DISPENSER_MODE === 'esp32' ? `DISPENSER: ESP32 at ${CONFIG.ESP32_BASE_URL} (water-low alert after ${TANK_LOW_MS / 1000}s LOW)` : 'DISPENSER: DEMO MODE (no ESP32_BASE_URL in settings.env): the tablet fakes the pour');
});
