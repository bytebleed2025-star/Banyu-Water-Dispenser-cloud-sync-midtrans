# Banyu online dashboard (Vercel + MongoDB + Discord)

How it fits together:

```
ESP32 dispenser ──local Wi-Fi──> banyu/server.js (computer next to the machine) ──internet──> Vercel (/api/ingest) ──> MongoDB Atlas
   tablet kiosk ──local Wi-Fi──┘        │ talks to Midtrans                                  │
                                        └ its own dashboard (local)                          ├ online dashboard: banyurefillstation.com
                                                                                             └ Discord alerts
```

Vercel only hosts the **online copy**. It never runs `banyu/server.js` and it cannot reach the dispenser.

## 1. Vercel project settings (one time)
Project → Settings → **General → Build & Development Settings**:
- **Root Directory**: empty (the repository root). If it was set to `banyu` or `banyu/public` before, clear it.
- Framework Preset: **Other**. Leave Build/Output/Install commands on default (`vercel.json` sets them).

Project → Settings → **Environment Variables** (Production and Preview):

| Name | What |
|---|---|
| `MONGODB_URI` | Atlas connection string (`mongodb+srv://user:password@...`) |
| `SYNC_SECRET` | long random string. The SAME value goes in the machine's `banyu/settings.env` |
| `ADMIN_PASSWORD` | password for the online dashboard. Several allowed, comma separated. Changing it logs everyone out |
| `DISCORD_WEBHOOK_URL` | Discord channel webhook. To move channels: new webhook, replace this, redeploy |
| `CRON_SECRET` | another random string, only for the offline check below |
| `MACHINE_ID` *(optional)* | which machine the dashboard shows first, default = the most recently seen |
| `OFFLINE_MINUTES` / `PAID_NO_WATER_MINUTES` *(optional)* | alert thresholds, default 5 and 3 |

Random string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

After changing variables: Deployments → latest → **Redeploy**.

## 2. Domain
Project → Settings → Domains → add `banyurefillstation.com` (and `www.`). Put the DNS records Vercel shows at your domain registrar.

## 3. Machine side
In `banyu/settings.env` on the computer next to the dispenser:
```
CLOUD_URL=https://banyurefillstation.com
SYNC_SECRET=<same as in Vercel>
MACHINE_ID=banyu-kiosk-01
```
Restart `node server.js`. It should print `CLOUD SYNC: on, to https://banyurefillstation.com`. The local dashboard's top line then shows
"Cloud copy: up to date". "failing" shows the reason (401 = the two SYNC_SECRETs differ, 404 = wrong CLOUD_URL or not deployed).

## 4. Offline alert timer (free, 2 minutes)
"Machine stopped checking in" can only be noticed if something asks. Opening the online dashboard does that, but to get the Discord
message even when nobody is looking, create a free job at https://cron-job.org that opens this URL every 5 minutes:
```
https://banyurefillstation.com/api/check?key=<CRON_SECRET>
```

## What goes to Discord
- 🚰 water running low (tank sensor or kiosk button) and ✅ when it clears
- ⚠️ dispenser not responding (the machine's server cannot reach the ESP32)
- 💧❌ paid, but no water poured after 3 minutes (refund candidate)
- 💸 payment arrived after the kiosk gave up (refund candidate)
- 🔌 machine stopped checking in for 5 minutes, and 🔌✅ when it is back

Sample data from "Add sample data" is synced (marked "sample") but never sent to Discord.

## Never commit
`banyu/settings.env` and `banyu/data/` are in `.gitignore`. Keys live only in Vercel's settings and in that file.
