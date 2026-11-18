// Discord alerts. Set DISCORD_WEBHOOK_URL in Vercel; to move channels, make a new webhook and replace the value.
const sent = [];   // kept for tests
async function notify(text) {
  sent.push(text);
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Banyu', content: text.slice(0, 1900), allowed_mentions: { parse: [] } }) });
    if (!r.ok) console.error('[discord]', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('[discord]', e.message); return false; }
}
module.exports = { notify, sent };
