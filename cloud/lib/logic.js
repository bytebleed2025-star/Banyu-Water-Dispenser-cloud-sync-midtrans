// Pure helpers for the online dashboard: same numbers as the machine's own dashboard (banyu/server.js).
// Vercel runs in UTC, so "today" is worked out in Jakarta time on purpose.
const JKT_OFFSET_MS = 7 * 3600 * 1000;
const pad = (n, l) => String(n).padStart(l, '0');
const ymdJakarta = d => { const x = new Date(new Date(d).getTime() + JKT_OFFSET_MS); return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1, 2)}${pad(x.getUTCDate(), 2)}`; };
const jakartaTime = d => new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const paidStatuses = ['paid', 'dispensing', 'completed', 'stopped'];
const withFlags = (o, at = Date.now()) => {
  const age = (at - new Date(o.paid_at || o.created_at)) / 60000;
  return { ...o, attention: (o.status === 'paid' && age > 2) || (o.status === 'dispensing' && age > 10),
    qc: o.status === 'completed' && o.variance_pct != null && Math.abs(o.variance_pct) > 5 };
};

function stats(O, at = Date.now()) {
  const today = ymdJakarta(at);
  const t = O.filter(o => ymdJakarta(o.created_at) === today);
  const paid = t.filter(o => paidStatuses.includes(o.status));
  const done = O.filter(o => o.status === 'completed').length, stp = O.filter(o => o.status === 'stopped').length;
  const by = (key, vals) => vals.map(v => ({ key: v, orders: paid.filter(o => String(o[key]) === String(v)).length }));
  return { ordersToday: t.length, paidToday: paid.length, revenueToday: paid.reduce((s, o) => s + (o.price || 0), 0),
    mlToday: Math.round(paid.reduce((s, o) => s + (o.dispensed_ml || 0), 0)),
    completionRate: done + stp ? Math.round(100 * done / (done + stp)) : null,
    attention: O.filter(o => withFlags(o, at).attention).length, openAlerts: 0,
    bottlesSaved: done, byTemp: by('temp', ['ruang', 'dingin']), byVolume: by('volume', [300, 600, 900]),
    fakeCount: O.filter(o => o.fake).length };
}

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = O => ['id,created_at,kiosk,volume_ml,temp,price_idr,status,dispensed_ml,paid_at,ended_at,payment_id,payment_type,dispenser_ml,duration_s,variance_pct,sample']
  .concat(O.map(o => [o.id, o.created_at, o.kioskId, o.volume, o.temp, o.price, o.status, o.dispensed_ml, o.paid_at, o.ended_at,
    o.payment_id || o.xendit_payment_id, o.payment_type, o.dispenser_ml, o.duration_s, o.variance_pct, o.fake].map(csvCell).join(','))).join('\n');

const byNewest = (a, b) => String(b.created_at || b.timestamp).localeCompare(String(a.created_at || a.timestamp));

module.exports = { ymdJakarta, jakartaTime, withFlags, stats, csv, byNewest, paidStatuses };
