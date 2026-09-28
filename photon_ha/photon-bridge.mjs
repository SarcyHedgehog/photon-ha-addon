import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import WebSocket from "ws";

const ROOT = process.cwd();
const CONFIG_PATH = process.env.PHOTON_HA_CONFIG || path.join(ROOT, "bridge.config.json");
const EVENT = Object.freeze({
  AUTH_REQUEST: 1,
  AUTH_RESULT: 2,
  COMMAND_REQUEST: 3,
  COMMAND_RESULT: 4,
  SNAPSHOT: 5,
  BRIDGE_HELLO: 6,
});

globalThis.WebSocket = WebSocket;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function controlFor(entityId, attributes = {}) {
  const domain = entityId.split(".")[0];
  if (["light", "switch", "input_boolean", "fan", "automation"].includes(domain)) {
    return { type: "toggle" };
  }
  if (["button", "input_button", "script"].includes(domain)) {
    return { type: "button" };
  }
  if (["number", "input_number"].includes(domain)) {
    return {
      type: "number",
      min: attributes.min ?? 0,
      max: attributes.max ?? 100,
      step: attributes.step ?? 1,
      unit: attributes.unit_of_measurement || "",
    };
  }
  if (["select", "input_select"].includes(domain)) {
    return { type: "select", options: attributes.options || [] };
  }
  if (domain === "cover") {
    return { type: "cover" };
  }
  if (domain === "lock") {
    return { type: "lock" };
  }
  return { type: "read_only" };
}

function serviceCallFor(entityId, request) {
  const domain = entityId.split(".")[0];
  const target = { entity_id: entityId };
  switch (request.action) {
    case "toggle":
      if (!["light", "switch", "input_boolean", "fan", "automation"].includes(domain)) break;
      return { domain, service: "toggle", target, service_data: {} };
    case "turn_on":
    case "turn_off":
      if (!["light", "switch", "input_boolean", "fan", "automation"].includes(domain)) break;
      return { domain, service: request.action, target, service_data: {} };
    case "press":
      if (domain === "script") return { domain, service: "turn_on", target, service_data: {} };
      if (["button", "input_button"].includes(domain)) return { domain, service: "press", target, service_data: {} };
      break;
    case "set_value":
      if (["number", "input_number"].includes(domain) && Number.isFinite(Number(request.value))) {
        return { domain, service: "set_value", target, service_data: { value: Number(request.value) } };
      }
      break;
    case "select_option":
      if (["select", "input_select"].includes(domain) && typeof request.value === "string") {
        return { domain, service: "select_option", target, service_data: { option: request.value } };
      }
      break;
    case "open_cover":
    case "close_cover":
    case "stop_cover":
      if (domain === "cover") return { domain, service: request.action, target, service_data: {} };
      break;
    case "lock":
    case "unlock":
      if (domain === "lock") return { domain, service: request.action, target, service_data: {} };
      break;
  }
  throw new Error(`Action ${request.action} is not allowed for ${entityId}`);
}

class HomeAssistantClient {
  constructor(config) {
    this.url = config.haWebSocketUrl;
    this.token = config.haToken;
    this.states = new Map();
    this.registry = new Map();
    this.devices = new Map();
    this.areas = new Map();
    this.pending = new Map();
    this.stateListeners = new Set();
    this.connectionListeners = new Set();
    this.nextId = 1;
    this.connected = false;
    this.reconnectTimer = null;
  }

  async connect() {
    clearTimeout(this.reconnectTimer);
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timeout = setTimeout(() => {
        if (!settled) reject(new Error("Home Assistant connection timed out"));
        socket.close();
      }, 15000);

      socket.on("message", async (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "auth_required") {
          socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
          return;
        }
        if (message.type === "auth_invalid") {
          clearTimeout(timeout);
          if (!settled) reject(new Error(`Home Assistant authentication failed: ${message.message}`));
          settled = true;
          return;
        }
        if (message.type === "auth_ok") {
          try {
            await this.initialize();
            clearTimeout(timeout);
            settled = true;
            resolve();
          } catch (error) {
            clearTimeout(timeout);
            settled = true;
            reject(error);
          }
          return;
        }
        if (message.type === "event" && message.event?.event_type === "state_changed") {
          const state = message.event.data.new_state;
          if (state) this.states.set(state.entity_id, state);
          else this.states.delete(message.event.data.entity_id);
          this.stateListeners.forEach((listener) => listener(message.event.data));
          return;
        }
        if (message.id && this.pending.has(message.id)) {
          const { resolve: done, reject: fail } = this.pending.get(message.id);
          this.pending.delete(message.id);
          message.success ? done(message.result) : fail(new Error(message.error?.message || "HA request failed"));
        }
      });

      socket.on("close", () => {
        this.connected = false;
        this.connectionListeners.forEach((listener) => listener(false));
        for (const { reject: fail } of this.pending.values()) fail(new Error("HA connection closed"));
        this.pending.clear();
        if (settled) this.scheduleReconnect();
      });
      socket.on("error", (error) => {
        if (!settled) {
          clearTimeout(timeout);
          settled = true;
          reject(error);
        }
      });
    });
  }

  async initialize() {
    const [states, registry, devices, areas] = await Promise.all([
      this.request({ type: "get_states" }),
      this.optionalRequest({ type: "config/entity_registry/list" }, []),
      this.optionalRequest({ type: "config/device_registry/list" }, []),
      this.optionalRequest({ type: "config/area_registry/list" }, []),
    ]);
    this.states = new Map(states.map((state) => [state.entity_id, state]));
    this.registry = new Map(registry.map((entity) => [entity.entity_id, entity]));
    this.devices = new Map(devices.map((device) => [device.id, device]));
    this.areas = new Map(areas.map((area) => [area.area_id, area]));
    await this.request({ type: "subscribe_events", event_type: "state_changed" });
    this.connected = true;
    this.connectionListeners.forEach((listener) => listener(true));
    log(`Home Assistant connected; ${this.states.size} states discovered.`);
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      log("Reconnecting to Home Assistant...");
      this.connect().catch((error) => {
        log(`HA reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      });
    }, 5000);
  }

  request(payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, ...payload }));
    });
  }

  async optionalRequest(payload, fallback) {
    try { return await this.request(payload); }
    catch (error) {
      log(`Optional HA metadata unavailable (${payload.type}): ${error.message}`);
      return fallback;
    }
  }

  callService(call) {
    if (!this.connected) throw new Error("Home Assistant is offline");
    return this.request({ type: "call_service", ...call, return_response: false });
  }

  entityMetadata(state) {
    const registry = this.registry.get(state.entity_id) || {};
    const device = this.devices.get(registry.device_id) || {};
    const areaId = registry.area_id || device.area_id || null;
    const area = this.areas.get(areaId) || {};
    return {
      entityId: state.entity_id,
      name: registry.name || state.attributes.friendly_name || registry.original_name || state.entity_id,
      domain: state.entity_id.split(".")[0],
      state: state.state,
      attributes: state.attributes,
      deviceName: device.name_by_user || device.name || "",
      areaId,
      areaName: area.name || "",
      disabled: Boolean(registry.disabled_by),
      control: controlFor(state.entity_id, state.attributes),
    };
  }

  allEntities() {
    return [...this.states.values()].map((state) => this.entityMetadata(state));
  }
}

class PhotonBridge {
  constructor(config, ha, getExposed) {
    this.config = config;
    this.ha = ha;
    this.getExposed = getExposed;
    this.authenticatedActors = new Set();
    this.passwordHash = sha256(config.remotePassword);
    this.revision = 0;
    this.snapshotTimer = null;
  }

  loadSdk() {
    const sdkPath = path.resolve(ROOT, this.config.photonSdkPath);
    vm.runInThisContext(fs.readFileSync(sdkPath, "utf8"), { filename: sdkPath });
    if (!globalThis.Photon?.LoadBalancing) throw new Error("Photon SDK did not expose LoadBalancing");
  }

  async connect() {
    this.loadSdk();
    const Photon = globalThis.Photon;
    const Client = Photon.LoadBalancing.LoadBalancingClient;
    this.client = new Client(Photon.ConnectionProtocol.Wss, this.config.photonAppId, "photon-ha-1");
    this.client.setUserId(`ha-bridge-${crypto.randomUUID()}`);
    this.client.setLogLevel(this.config.debug ? Photon.LogLevel.DEBUG : Photon.LogLevel.WARN);
    this.client.onStateChange = (state) => {
      if (state === Client.State.JoinedLobby) {
        this.client.joinRoom(this.config.roomName, { createIfNotExists: true }, {
          isVisible: false,
          maxPlayers: 20,
          roomTTL: 60_000,
          playerTTL: 30_000,
        });
      }
      if (state === Client.State.Disconnected) {
        log("Photon disconnected; retrying in five seconds.");
        setTimeout(() => this.client.connectToNameServer({ region: this.config.photonRegion }), 5000);
      }
    };
    let resolveInitialJoin;
    let rejectInitialJoin;
    const initialJoin = new Promise((resolve, reject) => {
      resolveInitialJoin = resolve;
      rejectInitialJoin = reject;
    });
    const joinTimeout = setTimeout(() => rejectInitialJoin(new Error("Photon bridge connection timed out")), 20000);
    this.client.onJoinRoom = () => {
      this.client.myActor().setName("Home Assistant bridge");
      this.client.myActor().setCustomProperty("pha_role", "bridge");
      log(`Photon bridge joined hidden room ${this.config.roomName}.`);
      this.client.raiseEvent(EVENT.BRIDGE_HELLO, { online: true, at: Date.now() }, {
        receivers: Photon.LoadBalancing.Constants.ReceiverGroup.All,
      });
      this.broadcastSnapshot();
      clearTimeout(joinTimeout);
      resolveInitialJoin();
    };
    this.client.onActorJoin = (actor) => {
      if (actor.actorNr === this.client.myActor().actorNr) return;
      this.send(EVENT.BRIDGE_HELLO, { online: true, at: Date.now() }, [actor.actorNr]);
    };
    this.client.onEvent = (code, content, actorNr) => this.onEvent(code, content || {}, actorNr);
    this.client.onActorLeave = (actor) => this.authenticatedActors.delete(actor.actorNr);
    this.client.onError = (_code, message) => {
      log(`Photon error: ${message}`);
      rejectInitialJoin(new Error(message || "Photon connection failed"));
    };
    this.client.onOperationResponse = (errorCode, message) => {
      if (errorCode) log(`Photon operation error ${errorCode}: ${message}`);
    };
    this.client.connectToNameServer({ region: this.config.photonRegion });
    this.ha.stateListeners.add(() => this.scheduleSnapshot());
    this.ha.connectionListeners.add(() => this.scheduleSnapshot());
    setInterval(() => this.broadcastSnapshot(), 15000);
    return initialJoin;
  }

  onEvent(code, content, actorNr) {
    if (code === EVENT.AUTH_REQUEST) {
      const ok = safeEqual(content.passwordHash || "", this.passwordHash);
      if (ok) this.authenticatedActors.add(actorNr);
      this.send(EVENT.AUTH_RESULT, {
        ok,
        message: ok ? "Connected" : "Incorrect password",
        bridgeActor: this.client.myActor().actorNr,
      }, [actorNr]);
      if (ok) this.sendSnapshot([actorNr]);
      return;
    }
    if (code === EVENT.COMMAND_REQUEST) this.executeCommand(content, actorNr);
  }

  async executeCommand(request, actorNr) {
    if (!this.authenticatedActors.has(actorNr)) {
      this.commandResult(actorNr, request.requestId, false, "Not authenticated");
      return;
    }
    const exposure = this.getExposed().entities.find((item) => item.entityId === request.entityId);
    if (!exposure || !exposure.writable) {
      this.commandResult(actorNr, request.requestId, false, "Entity is not exposed for control");
      return;
    }
    try {
      const call = serviceCallFor(request.entityId, request);
      await this.ha.callService(call);
      this.commandResult(actorNr, request.requestId, true, "Command accepted by Home Assistant");
    } catch (error) {
      this.commandResult(actorNr, request.requestId, false, error.message);
    }
  }

  commandResult(actorNr, requestId, ok, message) {
    this.send(EVENT.COMMAND_RESULT, { requestId, ok, message, at: Date.now() }, [actorNr]);
  }

  scheduleSnapshot() {
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => this.broadcastSnapshot(), 120);
  }

  buildSnapshot() {
    const entities = this.getExposed().entities.map((exposure) => {
      const state = this.ha.states.get(exposure.entityId);
      if (!state) return { ...exposure, state: "unavailable", available: false, control: { type: "read_only" } };
      const metadata = this.ha.entityMetadata(state);
      return {
        entityId: exposure.entityId,
        name: exposure.name || metadata.name,
        writable: exposure.writable !== false,
        state: metadata.state,
        available: !["unavailable", "unknown"].includes(metadata.state),
        icon: metadata.attributes.icon || "",
        unit: metadata.attributes.unit_of_measurement || "",
        areaName: metadata.areaName,
        control: metadata.control,
      };
    });
    return { revision: ++this.revision, at: Date.now(), haConnected: this.ha.connected, entities };
  }

  broadcastSnapshot() {
    if (!this.client?.isJoinedToRoom?.()) return;
    const targetActors = [...this.authenticatedActors];
    if (targetActors.length) this.sendSnapshot(targetActors);
  }

  sendSnapshot(targetActors) {
    this.send(EVENT.SNAPSHOT, this.buildSnapshot(), targetActors);
  }

  send(code, content, targetActors) {
    const options = targetActors
      ? { targetActors }
      : { receivers: globalThis.Photon.LoadBalancing.Constants.ReceiverGroup.All };
    this.client.raiseEvent(code, content, options);
  }
}

function startAdminServer(config, ha, getExposed, setExposed, photon) {
  const publicFiles = new Map([
    ["/", ["admin.html", "text/html; charset=utf-8"]],
    ["/admin-app.js", ["admin-app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ]);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && publicFiles.has(request.url)) {
        const [file, type] = publicFiles.get(request.url);
        response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
        response.end(fs.readFileSync(path.join(ROOT, file)));
        return;
      }
      if (request.method === "GET" && request.url === "/api/status") {
        return json(response, 200, {
          haConnected: ha.connected,
          discovered: ha.states.size,
          exposed: getExposed().entities.length,
          photonRoom: config.roomName,
        });
      }
      if (request.method === "GET" && request.url === "/api/entities") {
        return json(response, 200, ha.allEntities());
      }
      if (request.method === "GET" && request.url === "/api/exposed") {
        return json(response, 200, getExposed());
      }
      if (request.method === "PUT" && request.url === "/api/exposed") {
        const body = await readBody(request);
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.entities)) throw new Error("entities must be an array");
        const known = new Set(ha.states.keys());
        const clean = parsed.entities.slice(0, 100).map((item) => {
          if (!known.has(item.entityId)) throw new Error(`Unknown entity: ${item.entityId}`);
          return {
            entityId: item.entityId,
            name: String(item.name || "").slice(0, 80),
            writable: item.writable !== false,
          };
        });
        setExposed({ version: 1, entities: clean });
        photon.scheduleSnapshot();
        return json(response, 200, getExposed());
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
  server.listen(config.adminPort, config.adminHost, () => {
    log(`Local entity picker: http://${config.adminHost}:${config.adminPort}/`);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`Bridge configuration not found: ${CONFIG_PATH}`);
  const config = readJson(CONFIG_PATH);
  for (const key of ["photonAppId", "roomName", "remotePassword", "haWebSocketUrl", "haToken"]) {
    if (!config[key]) throw new Error(`bridge.config.json must define ${key}`);
  }
  config.photonRegion ||= "eu";
  config.photonSdkPath ||= "vendor/photon.min.js";
  config.adminHost ||= "127.0.0.1";
  config.adminPort ||= 8765;
  const exposedPath = path.resolve(ROOT, config.exposedEntitiesFile || "exposed-entities.json");
  let exposed = fs.existsSync(exposedPath)
    ? readJson(exposedPath)
    : readJson(path.join(ROOT, "exposed-entities.example.json"));
  const getExposed = () => exposed;
  const setExposed = (next) => { exposed = next; writeJson(exposedPath, next); };

  const ha = new HomeAssistantClient(config);
  await ha.connect();
  const photon = new PhotonBridge(config, ha, getExposed);
  await photon.connect();
  startAdminServer(config, ha, getExposed, setExposed, photon);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
