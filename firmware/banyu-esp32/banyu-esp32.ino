// =====================================================================================
// Banyu ESP32 firmware - MQTT version
// On start: joins Wi-Fi -> connects to the MQTT broker (HiveMQ Cloud, TLS) -> listens for commands.
// The pour itself is controlled HERE, on the ESP: it stops at the target volume by itself,
// even if Wi-Fi or MQTT drops in the middle.
//
// Board: "ESP32 Dev Module" (Arduino IDE / PlatformIO, ESP32 core 2.x or 3.x)
// Libraries (Library Manager): PubSubClient by Nick O'Leary (2.8+), ArduinoJson by Benoit Blanchon (7.x)
// Settings (Wi-Fi, broker, passwords): copy secrets.h.example to secrets.h and fill it in.
// Message formats: see PROTOCOL.md in this folder.
// =====================================================================================
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "secrets.h"

#define FW_VERSION "1.0.0"

// ======================= HARDWARE: CHECK EVERY LINE AGAINST THE REAL WIRING =======================
const int  PIN_PUMP        = 26;    // TODO(hardware): relay for the pump
const int  PIN_VALVE_ROOM  = 27;    // TODO(hardware): relay/solenoid for room-temperature water ("ruang")
const int  PIN_VALVE_COLD  = 25;    // TODO(hardware): relay/solenoid for cold water ("dingin")
const int  PIN_FLOW        = 33;    // TODO(hardware): flow sensor signal wire (needs a pin with pull-up; NOT 34-39)
const int  PIN_TANK        = 32;    // TODO(hardware): tank level / float switch
const bool RELAY_ACTIVE_LOW = true; // TODO(hardware): most cheap relay boards switch ON when the pin is LOW
const int  TANK_LOW_READS   = LOW;  // TODO(hardware): pin value that means "water is low"
float PULSES_PER_ML = 0.45f;        // TODO(calibrate): YF-S201 is ~450 pulses per litre. Pour 1000 ml into a
                                    // measuring jug, read "pulses" in the status message, set = pulses / 1000.

// ======================= SAFETY LIMITS =======================
const float    MAX_POUR_ML     = 1500;     // refuse anything bigger
const uint32_t NO_FLOW_MS      = 4000;     // pump on but no water counted for this long -> stop (empty tank, blocked pipe)
const uint32_t MAX_POUR_MS     = 120000;   // no pour may take longer than 2 minutes
const uint32_t MAX_PAUSE_MS    = 120000;   // paused longer than this -> stop
const uint32_t TANK_STABLE_MS  = 3000;     // tank sensor must read the same for 3 s before we believe it
const uint32_t STATUS_EVERY_MS = 30000;    // heartbeat while idle
const uint32_t PROGRESS_EVERY_MS = 1000;   // progress while pouring

// ======================= STATE =======================
WiFiClientSecure tlsMqtt;
PubSubClient mqtt(tlsMqtt);
String tCmd, tStatus, tEvent;

enum JobState { IDLE, POURING, PAUSED };
JobState job = IDLE;
String jobId = "", jobTemp = "";
float targetMl = 0;
uint32_t jobStartMs = 0, pausedAtMs = 0, startPulses = 0;
float pouredBeforePause = 0;

volatile uint32_t pulses = 0;
volatile uint32_t lastPulseMs = 0;
void IRAM_ATTR onPulse() { pulses++; lastPulseMs = millis(); }

bool tankLow = false; int tankRaw = -1; uint32_t tankChangedMs = 0;
uint32_t lastStatusMs = 0, lastProgressMs = 0, lastWifiTry = 0, lastMqttTry = 0, mqttBackoff = 2000;
String recentCmds[8]; int recentIdx = 0;   // ignore the same command delivered twice

// ======================= OUTPUTS =======================
void setOut(int pin, bool on) { digitalWrite(pin, (on != RELAY_ACTIVE_LOW) ? HIGH : LOW); }
void allOff() { setOut(PIN_PUMP, false); setOut(PIN_VALVE_ROOM, false); setOut(PIN_VALVE_COLD, false); }
void waterOn(const String& temp) {
  setOut(temp == "dingin" ? PIN_VALVE_COLD : PIN_VALVE_ROOM, true);
  delay(150);                                   // let the valve open before the pump pushes
  setOut(PIN_PUMP, true);
}
void waterOff() { setOut(PIN_PUMP, false); delay(100); setOut(PIN_VALVE_ROOM, false); setOut(PIN_VALVE_COLD, false); }

float pouredNow() {
  if (job == POURING) return pouredBeforePause + (pulses - startPulses) / PULSES_PER_ML;
  return pouredBeforePause;
}
const char* jobName() { return job == POURING ? "pouring" : job == PAUSED ? "paused" : "idle"; }

// ======================= REPORTING =======================
// HTTPS posts can take seconds, so they are queued and only sent while NOT pouring (the pour checks must never wait).
String postQueue[8]; int postCount = 0;
void queuePost(const String& body) {
  if (strlen(EVENT_URL) == 0) return;
  if (postCount == 8) { for (int i = 1; i < 8; i++) postQueue[i - 1] = postQueue[i]; postCount = 7; }   // full: drop the oldest
  postQueue[postCount++] = body;
}
void postEvent(const String& body);
void flushPosts() {
  if (job == POURING || postCount == 0 || WiFi.status() != WL_CONNECTED) return;
  String body = postQueue[0];
  for (int i = 1; i < postCount; i++) postQueue[i - 1] = postQueue[i];
  postCount--;
  postEvent(body);
}
void postEvent(const String& body) {            // optional: also tell the website directly over HTTPS
  if (strlen(EVENT_URL) == 0 || WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure tls; tls.setInsecure();      // TODO(security): pin the website's root certificate before launch
  HTTPClient http;
  if (!http.begin(tls, EVENT_URL)) return;
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  int code = http.POST(body);
  if (code < 200 || code >= 300) Serial.printf("[event POST] HTTP %d\n", code);
  http.end();
}

void publishStatus() {
  JsonDocument d;
  d["online"] = true; d["fw"] = FW_VERSION; d["machine"] = MACHINE_ID;
  d["job_state"] = jobName(); d["job_id"] = jobId; d["target_ml"] = targetMl; d["poured_ml"] = (int)pouredNow();
  d["tank_state"] = tankLow ? "LOW" : "NORMAL"; d["pulses"] = (uint32_t)pulses;
  d["rssi"] = WiFi.RSSI(); d["uptime_s"] = millis() / 1000;
  String s; serializeJson(d, s);
  if (mqtt.connected()) mqtt.publish(tStatus.c_str(), s.c_str(), true);   // retained: newest status is always there
  lastStatusMs = millis();
}

void sendEvent(const char* type, const String& id, const char* reason = "") {
  JsonDocument d;
  d["machine"] = MACHINE_ID; d["type"] = type; d["id"] = id;
  d["poured_ml"] = (int)pouredNow(); d["target_ml"] = targetMl;
  if (strlen(reason)) d["reason"] = reason;
  d["uptime_s"] = millis() / 1000;
  String s; serializeJson(d, s);
  Serial.println("[event] " + s);
  if (mqtt.connected()) mqtt.publish(tEvent.c_str(), s.c_str(), false);
  queuePost(s);
  publishStatus();
}

// ======================= JOB CONTROL =======================
void finishJob(const char* type, const char* reason = "") {
  waterOff();
  if (job == POURING) pouredBeforePause = pouredNow();
  job = IDLE;
  sendEvent(type, jobId, reason);
  jobId = ""; targetMl = 0; pouredBeforePause = 0;
}

void startPour(const String& id, float ml, const String& temp) {
  if (job != IDLE)            { sendEvent("rejected", id, "busy"); return; }
  if (tankLow)                { sendEvent("rejected", id, "tank_low"); return; }
  if (ml <= 0 || ml > MAX_POUR_ML) { sendEvent("rejected", id, "bad_volume"); return; }
  jobId = id; targetMl = ml; jobTemp = temp; pouredBeforePause = 0;
  startPulses = pulses; lastPulseMs = millis(); jobStartMs = millis();
  job = POURING;
  waterOn(temp);
  sendEvent("started", id);
}

void pauseJob()  { if (job != POURING) return; waterOff(); pouredBeforePause = pouredNow(); job = PAUSED; pausedAtMs = millis(); sendEvent("paused", jobId); }
void resumeJob() {
  if (job != PAUSED) return;
  if (tankLow) { sendEvent("rejected", jobId, "tank_low"); return; }
  startPulses = pulses; lastPulseMs = millis(); job = POURING; waterOn(jobTemp); sendEvent("resumed", jobId);
}

// ======================= COMMANDS (from the website, via MQTT) =======================
bool seenBefore(const String& cmdId) {
  for (auto& c : recentCmds) if (c == cmdId) return true;
  recentCmds[recentIdx] = cmdId; recentIdx = (recentIdx + 1) % 8; return false;
}

void onMqtt(char* topic, byte* payload, unsigned int len) {
  JsonDocument d;
  if (deserializeJson(d, payload, len)) { Serial.println("[cmd] not valid JSON, ignored"); return; }
  String action = d["action"] | "", id = d["id"] | "", cmdId = d["cmd_id"] | "";
  Serial.printf("[cmd] %s id=%s\n", action.c_str(), id.c_str());
  if (cmdId.length() && seenBefore(cmdId)) { Serial.println("[cmd] duplicate, ignored"); return; }

  if (action == "pour")        startPour(id, d["ml"] | 0.0f, String(d["temp"] | "ruang"));
  else if (action == "stop")   { if (job != IDLE && (id == "" || id == jobId)) finishJob("stopped", "stop_command"); }
  else if (action == "pause")  { if (id == "" || id == jobId) pauseJob(); }
  else if (action == "resume") { if (id == "" || id == jobId) resumeJob(); }
  else if (action == "ping")   publishStatus();
  else if (action == "calibrate") { float v = d["pulses_per_ml"] | 0.0f; if (v > 0.05f && v < 20) { PULSES_PER_ML = v; publishStatus(); } }   // not saved: put the final value in the code
  else Serial.println("[cmd] unknown action");
}

// ======================= CONNECTIONS (never block the pour) =======================
void keepWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < 20000 && lastWifiTry) return;
  lastWifiTry = millis();
  Serial.println("[wifi] connecting to " + String(WIFI_SSID));
  WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void keepMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (job == POURING) return;                   // a TLS reconnect can take seconds: finish the pour first
  if (millis() - lastMqttTry < mqttBackoff) return;
  lastMqttTry = millis();
  Serial.printf("[mqtt] connecting to %s:%d\n", MQTT_HOST, MQTT_PORT);
  String clientId = String(MACHINE_ID) + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  // "Last will": if the ESP vanishes, the broker itself publishes online:false for us
  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, tStatus.c_str(), 1, true, "{\"online\":false}")) {
    Serial.println("[mqtt] connected");
    mqttBackoff = 2000;
    mqtt.subscribe(tCmd.c_str(), 1);
    publishStatus();
  } else {
    Serial.printf("[mqtt] failed, state=%d (-2 = network/TLS, 4 = wrong user/password, 5 = not allowed)\n", mqtt.state());
    mqttBackoff = min<uint32_t>(mqttBackoff * 2, 60000);
  }
}

// ======================= SENSORS =======================
void readTank() {
  int raw = digitalRead(PIN_TANK);
  if (raw != tankRaw) { tankRaw = raw; tankChangedMs = millis(); return; }
  bool low = (raw == TANK_LOW_READS);
  if (low != tankLow && millis() - tankChangedMs >= TANK_STABLE_MS) {
    tankLow = low;
    sendEvent(low ? "tank_low" : "tank_ok", jobId);
    if (low && job == POURING) finishJob("stopped", "tank_low");
  }
}

void watchPour() {
  uint32_t t = millis();
  if (job == POURING) {
    if (pouredNow() >= targetMl)                     { finishJob("done"); return; }
    if (t - lastPulseMs > NO_FLOW_MS)                { finishJob("stopped", "no_flow"); return; }
    if (t - jobStartMs > MAX_POUR_MS)                { finishJob("stopped", "timeout"); return; }
    if (t - lastProgressMs > PROGRESS_EVERY_MS)      { lastProgressMs = t; publishStatus(); }
  } else if (job == PAUSED && t - pausedAtMs > MAX_PAUSE_MS) {
    finishJob("stopped", "pause_timeout");
  }
}

// ======================= SETUP / LOOP =======================
void setup() {
  pinMode(PIN_PUMP, OUTPUT); pinMode(PIN_VALVE_ROOM, OUTPUT); pinMode(PIN_VALVE_COLD, OUTPUT);
  allOff();                                         // first thing: everything OFF
  Serial.begin(115200); delay(200);
  Serial.printf("\nBanyu firmware %s, machine %s\n", FW_VERSION, MACHINE_ID);
  pinMode(PIN_FLOW, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(PIN_FLOW), onPulse, FALLING);
  pinMode(PIN_TANK, INPUT_PULLUP);

  String base = String("banyu/") + MACHINE_ID + "/";
  tCmd = base + "cmd"; tStatus = base + "status"; tEvent = base + "event";

  if (MQTT_INSECURE) tlsMqtt.setInsecure();         // first tests only: no certificate check
  else tlsMqtt.setCACert(MQTT_ROOT_CA);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
  mqtt.setBufferSize(1024);
  mqtt.setKeepAlive(30);

  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true);
  keepWifi();
}

void loop() {
  watchPour();            // safety first, every loop
  readTank();
  keepWifi();
  keepMqtt();
  if (mqtt.connected()) mqtt.loop();
  if (job == IDLE && millis() - lastStatusMs > STATUS_EVERY_MS) publishStatus();
  flushPosts();
  delay(5);
}
