# Banyu ESP32 ⇄ MQTT protocol

Topics (`<id>` = `MACHINE_ID` in secrets.h, e.g. `banyu-kiosk-01`):

| Topic | Direction | Retained | What |
|---|---|---|---|
| `banyu/<id>/cmd` | website → ESP | no | commands |
| `banyu/<id>/status` | ESP → everyone | **yes** | current state; every 30 s idle, every 1 s while pouring. `{"online":false}` is published by the broker if the ESP disappears |
| `banyu/<id>/event` | ESP → everyone | no | things that happened |

## Commands (JSON on `cmd`)
`cmd_id` should be unique per command; the ESP ignores a repeat of one of its last 8.
```json
{"cmd_id":"c-001","action":"pour","id":"BNY-20261117-0001","ml":600,"temp":"dingin"}
{"cmd_id":"c-002","action":"pause","id":"BNY-20261117-0001"}
{"cmd_id":"c-003","action":"resume","id":"BNY-20261117-0001"}
{"cmd_id":"c-004","action":"stop","id":"BNY-20261117-0001"}
{"cmd_id":"c-005","action":"ping"}
{"cmd_id":"c-006","action":"calibrate","pulses_per_ml":0.45}
```
`temp` is `"dingin"` (cold valve) or `"ruang"` (room-temperature valve). Max 1500 ml.

## Events (JSON on `event`)
`type` is one of: `started`, `done`, `stopped` (with `reason`: `stop_command`, `no_flow`, `timeout`, `tank_low`, `pause_timeout`),
`paused`, `resumed`, `rejected` (with `reason`: `busy`, `tank_low`, `bad_volume`), `tank_low`, `tank_ok`.
```json
{"machine":"banyu-kiosk-01","type":"done","id":"BNY-20261117-0001","poured_ml":601,"target_ml":600,"uptime_s":5123}
```

## Status (JSON on `status`)
```json
{"online":true,"fw":"1.0.0","machine":"banyu-kiosk-01","job_state":"pouring","job_id":"BNY-20261117-0001",
 "target_ml":600,"poured_ml":240,"tank_state":"NORMAL","pulses":10234,"rssi":-58,"uptime_s":5120}
```

## Safety rules built into the firmware
- Everything is switched OFF at power-on.
- The ESP stops the pour itself at the target volume. Wi-Fi/MQTT dropping mid-pour does not affect it.
- Stops on: no flow for 4 s, pour longer than 2 min, tank low, paused longer than 2 min.
- Refuses a new pour while busy, when the tank is low, or above 1500 ml.

## First test, without the website (HiveMQ Cloud web client)
1. HiveMQ Cloud console → your cluster → **Access Management**: create credentials (user + password) for the ESP,
   and a second set for yourself in the web client.
2. Fill in `secrets.h`, flash, open Serial Monitor at 115200. Expect `[wifi] ...` then `[mqtt] connected`.
3. HiveMQ console → **Web Client** → connect with your own credentials → subscribe to `banyu/#`.
   You should see the retained status message straight away.
4. Publish to `banyu/banyu-kiosk-01/cmd`: `{"cmd_id":"t1","action":"pour","id":"TEST-1","ml":200,"temp":"ruang"}`
   → expect a `started` event, status messages every second, then `done`.
5. Unplug the ESP's power → within ~45 s the broker publishes `{"online":false}` on status.
6. Calibrate the flow sensor: pour into a measuring jug, compare, adjust `PULSES_PER_ML`.

Serial `[mqtt] failed, state=-2` usually means wrong host/port or no internet; `state=4` = wrong user/password.
