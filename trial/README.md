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
