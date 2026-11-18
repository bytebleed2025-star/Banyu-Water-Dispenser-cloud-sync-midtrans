// Vercel build step: publish ONLY the dashboard pages online. The kiosk page (index.html) stays on the machine.
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'banyu', 'public'), out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
for (const f of ['dashboard.html', 'login.html', 'banyu-logo.png']) fs.copyFileSync(path.join(src, f), path.join(out, f));
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta http-equiv="refresh" content="0;url=/dashboard.html"><a href="/dashboard.html">Banyu dashboard</a>');
console.log('Built cloud/dist: dashboard.html, login.html, banyu-logo.png');
