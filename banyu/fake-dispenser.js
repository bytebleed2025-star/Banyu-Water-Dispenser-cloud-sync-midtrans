// Stand-in for the ESP32 dispenser, following API.md. For testing without hardware.
// Run: node fake-dispenser.js   (listens on http://localhost:8080; FLOW_ML_S=15 sets ml per second)
// Try the water-low alert:  http://localhost:8080/api/sim?tank=low   (and ?tank=ok to clear it)
const http = require('http'), PORT = process.env.PORT || 8080, RATE = +process.env.FLOW_ML_S || 15;
let job = null, last = null, total = 0, tankLow = false, error = '';
const end = (msg) => { error = msg; last = job; job = null; };
setInterval(() => {
  if (!job || job.paused) return;
  job.ml = Math.min(job.target, job.ml + RATE / 10); total += RATE / 10;
  if (tankLow) end('tank LOW - stopped, refill'); else if (job.ml >= job.target) end('');
}, 100);
const status = () => { const j = job || last;
  return { job_active: !!job, job_paused: !!(job && job.paused), job_state: job ? (job.paused ? 'paused' : 'dispensing') : 'idle',
    channel: job ? job.channel : 'none', job_ml: +(j ? j.ml : 0).toFixed(1), job_target_ml: j ? j.target : 0,
    job_remaining_ml: job ? +(job.target - job.ml).toFixed(1) : 0, tank_low: tankLow, tank_state: tankLow ? 'LOW' : 'NORMAL',
    flow_lpm: job && !job.paused ? +(RATE * 0.06).toFixed(2) : 0, total_ml: +total.toFixed(1), ip: '127.0.0.1', rssi: -55, error, sim: false }; };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), q = u.searchParams;
  const out = (c, b) => { res.writeHead(c, { 'Content-Type': typeof b === 'string' ? 'text/plain' : 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
  switch (u.pathname) {
    case '/api/status': return out(200, status());
    case '/api/dispense': { const ml = +q.get('ml'), ch = q.get('channel');
      if (job) return out(400, 'Rejected: already dispensing');
      if (!['cold', 'normal'].includes(ch)) return out(400, 'Rejected: Select Cold or Normal first');
      if (!(ml > 0 && ml <= 1000)) return out(400, 'Rejected: Bad volume');
      if (tankLow) return out(400, 'Rejected: Tank LOW - refill to start');
      job = { channel: ch, target: ml, ml: 0, paused: false }; error = ''; return out(200, `Started ${ch} ${ml} mL`); }
    case '/api/pause': if (!job) return out(400, 'Rejected: no active job'); if (job.paused) return out(400, 'Rejected: already paused'); job.paused = true; return out(200, 'Paused');
    case '/api/resume': if (!job) return out(400, 'Rejected: no active job'); if (!job.paused) return out(400, 'Rejected: not paused');
      if (tankLow) return out(400, 'Rejected: Tank LOW \u2014 refill to resume'); job.paused = false; return out(200, 'Resumed');
    case '/api/stop': if (!job) return out(200, 'Already idle'); end('stopped by user'); return out(200, 'Stopped');
    case '/api/sim': if (q.get('tank')) tankLow = ['low', '1', 'alarm'].includes(q.get('tank')); return out(200, { sim: true, tank_low: tankLow });
    default: return out(404, 'not found');
  }
}).listen(PORT, () => console.log(`Fake dispenser on http://localhost:${PORT}  (${RATE} ml/s)`));
