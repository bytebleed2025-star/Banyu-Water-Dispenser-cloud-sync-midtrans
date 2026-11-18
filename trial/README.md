# Trial — Recipe A: laptop only

Everything runs on one Windows laptop next to the dispenser. No Vercel, no
MongoDB, no domain. Orders stay in `banyu/data/db.json`.

```
tablet browser ──LAN──> laptop:3000 (banyu/server.js) ──HTTP LAN──> ESP32 (Hydronode firmware)
                              └──HTTPS──> Midtrans (optional; mock by default)
```

This is the quickest way to trial the kiosk + dashboard. Recipe B adds the
online copy + MongoDB + Discord (separate branch `trial/recipe-b-cloud`).

## Requirements

- Windows laptop, Node.js **18+** (`node --version`), on the same Wi-Fi as the ESP32.
- Your current ESP firmware (HTTP API), **no firmware change**.
- Optional: Midtrans server key (sandbox) for real QRIS; otherwise mock payment.

## Start

```powershell
cd C:\Users\fitri\Documents\OPENCODE\Banyu-Water-Dispenser-cloud-sync-midtrans
powershell -ExecutionPolicy Bypass -File .\trial\start-recipe-a.ps1 -EspIp 192.168.1.50
```

- Omit `-EspIp` for **demo mode** (no hardware; the tablet fakes the pour).
- First run creates `banyu/settings.env` (ignored by git) and opens the kiosk.
- Stop with Ctrl+C in that window.

URLs printed by the script:

| What | URL |
|---|---|
| Kiosk (tablet) | `http://<laptop-ip>:3000/` |
| Dashboard | `http://<laptop-ip>:3000/dashboard.html` |
| ESP status | `http://<esp-ip>/api/status` |

Dashboard login keyword: `banyu123` (first `ADMIN_KEYWORDS` entry; change it in
`banyu/settings.env` and restart). The kiosk tablet does not log in.

## Payment modes

- **mock (default):** the payment screen shows a demo button. Use this without a
  Midtrans account; orders/statistics work, no money moves.
- **Midtrans sandbox:** edit `banyu/settings.env`:

  ```
  MIDTRANS_SERVER_KEY=SB-Mid-server-...
  MIDTRANS_ENV=sandbox
  PAYMENT_MODE=midtrans
  ```

  Test money only; the server **polls** Midtrans every 2 s, so no public
  webhook/domain is needed. Keep `PAYMENT_MODE=mock` until the key is in.

## ESP32 check

```powershell
powershell -ExecutionPolicy Bypass -File .\trial\check-esp.ps1 -EspIp 192.168.1.50
```

Shows build, Wi-Fi/RSSI, tank raw/mode/filter, job, flow. If it fails:

- laptop and ESP on the same router (not the ESP AP unless the laptop joins it);
- `ESP32_BASE_URL` correct in `settings.env`;
- Windows firewall allows TCP 3000 (for the tablet, not for the ESP):
  run as admin:
  ```powershell
  netsh advfirewall firewall add rule name="Banyu Kiosk 3000" dir=in action=allow protocol=TCP localport=3000
  ```

## Laptop hygiene (important for a trial day)

- Power & sleep: **Never** for screen/sleep; lid close = do nothing; disable
  "fast startup" if the Wi-Fi does not return after a reboot.
- Give the laptop and the ESP a **DHCP reservation** in the router so the IPs do
  not change overnight.
- Do not expose port 3000 to the internet; no port forwarding.
- Back up `banyu/data/db.json` (it contains all orders). The cloud copy in
  Recipe B is the backup.
- Keep the laptop on the charger; disable Windows Update auto-restart during the
  trial hours.

## Trial script

1. Start the laptop server, open the kiosk on the tablet.
2. Dashboard → check "Dispenser" tile is online and tank NORMAL.
3. Mock: 300 mL room temp → demo pay → Start → watch mL; dashboard should show
   the order when completed.
4. Real Midtrans sandbox: create an order, pay on Midtrans's page, return to the
   kiosk, Start.
5. Fail tests: unplug the ESP (offline blocks new orders), tank LOW (order
   refused), pause/stop during a pour.

## Limits of Recipe A

- No online dashboard from outside the shop, no Discord alerts.
- If the laptop sleeps/crashes, the kiosk is down.
- `db.json` is the only copy of orders (Recipe B syncs it to MongoDB).
- Midtrans polling only; no webhook. Late payments are recorded and flagged in
  the dashboard, but refunds are manual.

---

# Recipe B — laptop + local cloud copy (MongoDB)

Branch: `trial/recipe-b-cloud`. Same kiosk/ESP path as Recipe A, plus the online
dashboard + API + MongoDB running **on the same laptop** (or an Atlas database).
No Vercel account or domain is needed for the trial.

```
tablet ──> laptop:3000 (kiosk/API) ──HTTP LAN──> ESP32
                  └── outbound ──> laptop:4000 (cloud API) ──> MongoDB
                                          └──> online dashboard + Discord (optional)
```

## Start

```powershell
cd C:\Users\fitri\Documents\OPENCODE\Banyu-Water-Dispenser-cloud-sync-midtrans
powershell -ExecutionPolicy Bypass -File .\trial\start-recipe-b.ps1 -EspIp 192.168.1.50
```

It opens two windows:

| Window | What | URL |
|---|---|---|
| kiosk | `banyu/server.js` | `http://localhost:3000/` |
| cloud | `trial/cloud-dev.js` | `http://localhost:4000/dashboard.html` |

Cloud dashboard login = the first `ADMIN_KEYWORDS` value (default `banyu123`).
The script adds `CLOUD_URL=http://localhost:4000` and a random `SYNC_SECRET` to
`banyu/settings.env` if they are empty, then starts both halves.

## MongoDB

- **Default — in-memory:** no install, no account. The first cloud start
  downloads a ~100 MB MongoDB binary (one time). Data lives until the cloud
  window is closed.
- **Persistent — Atlas / local mongod:**

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\trial\start-recipe-b.ps1 `
    -MongoUri "mongodb+srv://user:password@cluster/banyu"
  ```

  or a local install: `-MongoUri "mongodb://127.0.0.1:27017"`.
- If the in-memory database is lost, the local `banyu/data/db.json` is the source
  of truth: the next heartbeat tells the cloud that its counts are lower and the
  machine re-sends everything (usually within a minute).

## Verify the trial

1. Wait for `Dashboard :` in the cloud window (first run only).
2. Open both URLs; the local dashboard and the cloud dashboard should both log
   in with the same keyword.
3. Create a 300 mL order → mock pay → Start.
4. The cloud dashboard should show the machine online and the order within
   ~5–10 s (machine sync = 5 s, heartbeat = 60 s).
5. Discord messages appear only if `DISCORD_WEBHOOK_URL` is set in the cloud
   window's environment (optional).

## Recipe A vs B

| | A | B |
|---|---|---|
| ESP HTTP control | yes | yes |
| Kiosk + local dashboard | yes | yes |
| Online dashboard | — | yes |
| MongoDB | — | in-memory or Atlas |
| Discord alerts | — | optional |
| Accounts/domain | none | none for local trial |

To go back to A after running B, either use the A branch or clear `CLOUD_URL`
and `SYNC_SECRET` in `banyu/settings.env`. When the customer is ready for
Vercel + Atlas, deploy this same repo with `SETUP-ONLINE.md` and point
`CLOUD_URL` at the domain.
