import fs from "node:fs";
import path from "node:path";

const DATA = "/data";
const optionsPath = path.join(DATA, "options.json");
const configPath = path.join(DATA, "bridge.config.json");
const exposedPath = path.join(DATA, "exposed-entities.json");

const options = JSON.parse(fs.readFileSync(optionsPath, "utf8"));
const required = ["photon_app_id", "room_name", "remote_password"];
for (const name of required) {
  if (!String(options[name] || "").trim()) {
    throw new Error(`Add-on option ${name} must be configured.`);
  }
}

const supervisorToken = process.env.SUPERVISOR_TOKEN;
if (!supervisorToken) {
  throw new Error("Home Assistant did not supply SUPERVISOR_TOKEN.");
}

const config = {
  photonAppId: String(options.photon_app_id).trim(),
  photonRegion: String(options.photon_region || "eu").trim(),
  photonSdkPath: "vendor/photon.min.js",
  roomName: String(options.room_name).trim(),
  remotePassword: String(options.remote_password),
  haWebSocketUrl: "ws://supervisor/core/websocket",
  haToken: supervisorToken,
  adminHost: "0.0.0.0",
  adminPort: 8765,
  exposedEntitiesFile: exposedPath,
  debug: options.debug === true,
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

if (!fs.existsSync(exposedPath)) {
  fs.copyFileSync(path.join(process.cwd(), "exposed-entities.example.json"), exposedPath);
}

process.env.PHOTON_HA_CONFIG = configPath;
await import("./photon-bridge.mjs");
