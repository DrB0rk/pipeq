import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PipeqSettings } from "./settings.js";

export type ControlState = {
  nodes: Array<{ id: number; name: string; description: string }>;
  sinks: Array<{ id: number; name: string; description: string }>;
  presets: Array<{ id: string; name: string }>;
  selectedNodeId?: number;
  defaultNodeId?: number;
  selectedOutputId?: number;
  selectedPresetId?: string;
  presetDirty: boolean;
  enabled: boolean;
  bands: Array<{ name: string; freq: number; gain: number; q: number; enabled?: boolean }>;
  bassBoost: number;
  preamp: number;
  accent: string;
  settings: PipeqSettings;
};

export type ControlAction =
  | { type: "preset"; id: string }
  | { type: "createPreset"; name: string }
  | { type: "resetBand"; name: string }
  | { type: "output"; id: number }
  | { type: "route"; enabled: boolean }
  | { type: "savePreset" }
  | { type: "bass"; value: number }
  | { type: "preamp"; value: number }
  | { type: "band"; name: string; parameter: "freq" | "gain" | "q"; value: number }
  | { type: "bandEnabled"; name: string; enabled: boolean }
  | { type: "settings"; value: unknown };

export type ControlServerOptions = {
  getState: () => ControlState;
  perform: (action: ControlAction) => Promise<void>;
  port?: number;
};

export type RunningControlServer = {
  url: string;
  close: () => Promise<void>;
};

const MAX_BODY_BYTES = 16 * 1024;

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validAction(value: unknown): value is ControlAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  if (action.type === "settings") return Boolean(action.value) && typeof action.value === "object" && !Array.isArray(action.value);
  if (action.type === "preset") return typeof action.id === "string" && action.id.length <= 128;
  if (action.type === "createPreset") return typeof action.name === "string" && action.name.trim().length > 0 && action.name.length <= 48;
  if (action.type === "resetBand") return typeof action.name === "string" && /^eq\d+$/.test(action.name);
  if (action.type === "output") return Number.isSafeInteger(action.id) && Number(action.id) >= 0;
  if (action.type === "route") return typeof action.enabled === "boolean";
  if (action.type === "savePreset") return true;
  if (action.type === "bass" || action.type === "preamp") return typeof action.value === "number" && Number.isFinite(action.value);
  if (action.type === "bandEnabled") return typeof action.name === "string" && /^eq\d+$/.test(action.name) && typeof action.enabled === "boolean";
  return action.type === "band" && typeof action.name === "string" && /^eq\d+$/.test(action.name) && ["freq", "gain", "q"].includes(String(action.parameter)) && typeof action.value === "number" && Number.isFinite(action.value);
}

export async function startControlServer(options: ControlServerOptions): Promise<RunningControlServer> {
  const token = randomBytes(32).toString("base64url");
  const nonce = randomBytes(18).toString("base64");
  let boundPort: number | undefined;
  let server: Server;
  const allowedHost = () => `127.0.0.1:${boundPort}`;
  const origin = () => `http://${allowedHost()}`;

  server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("content-security-policy", `default-src 'none'; style-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    if (request.headers.host !== allowedHost()) return json(response, 403, { error: "Invalid host." });

    if (request.method === "GET" && request.url === "/") {
      const accent = options.getState().accent;
      const html = (await readFile(`${WEB_ROOT}index.html`, "utf8"))
        .replaceAll("__ACCENT__", /^#[0-9A-Fa-f]{6}$/.test(accent) ? accent : "#F3B562")
        .replaceAll("__NONCE__", nonce)
        .replaceAll("__TOKEN__", token);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && ["/app.js", "/style.css", "/eq-response.js"].includes(request.url ?? "")) {
      const path = request.url!.slice(1);
      response.writeHead(200, {
        "content-type": path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(await readFile(`${WEB_ROOT}${path}`));
      return;
    }
    if (request.method === "GET" && request.url === "/api/state") return json(response, 200, options.getState());
    if (request.method !== "POST" || request.url !== "/api/action") return json(response, 404, { error: "Not found." });
    if (request.headers.origin !== origin()) return json(response, 403, { error: "Invalid origin." });
    const tokenHeader = request.headers["x-pipeq-token"];
    const supplied = Buffer.from(typeof tokenHeader === "string" ? tokenHeader : "");
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(response, 403, { error: "Invalid control token." });
    if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) return json(response, 415, { error: "JSON is required." });
    try {
      const action = await readBody(request);
      if (!validAction(action)) return json(response, 400, { error: "Invalid action." });
      await options.perform(action);
      return json(response, 200, { ok: true });
    } catch (cause) {
      return json(response, 400, { error: cause instanceof Error ? cause.message : "Could not apply action." });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not determine local UI address."));
      boundPort = address.port;
      resolve();
    });
  });

  const url = origin();
  return {
    url,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
