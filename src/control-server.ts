import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
  | { type: "output"; id: number }
  | { type: "route"; enabled: boolean }
  | { type: "bass"; value: number }
  | { type: "preamp"; value: number }
  | { type: "band"; name: string; parameter: "freq" | "gain" | "q"; value: number }
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

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PipeQ</title>
<style>
:root{color-scheme:dark;--accent:__ACCENT__;--page:#171613;--fg:#e8e7e4;--panel:#24221f;--border:#625e58} :root[data-theme=light]{color-scheme:light;--page:#f5f3ee;--fg:#292722;--panel:#fff;--border:#b9b3a8}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--fg);font:15px system-ui,sans-serif}main{max-width:980px;margin:0 auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h1{font-size:22px;color:var(--accent);margin:0}small,.muted{color:#9b968d}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px}h2{font-size:13px;letter-spacing:.08em;color:var(--accent);margin:0 0 14px}label{display:block;margin:12px 0 6px}select,button,input{font:inherit;color:inherit;background:var(--page);border:1px solid var(--border);border-radius:7px;padding:9px}select,button{width:100%}button{cursor:pointer}button:hover{border-color:var(--accent)}button.primary{background:var(--accent);color:#171613;font-weight:700;border:0}.row{display:flex;gap:8px}.row>*{flex:1}.status{margin:8px 0 16px;padding:10px 12px;background:var(--panel);border-radius:8px}.bands{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.band{font-size:13px;color:#c8c4bd}.band input{width:100%;padding:4px}.message{min-height:1.4em;color:var(--accent);margin-top:10px}@media(max-width:600px){main{padding:14px}.bands{grid-template-columns:1fr}}</style></head>
<body><main><header><h1>PIPEQ</h1><small>Local audio controls</small></header><div id="status" class="status">Connecting to PipeQ…</div><div class="grid">
<section class="card"><h2>PLAYBACK</h2><label for="output">Output device</label><select id="output"></select><div class="row" style="margin-top:10px"><button id="route" class="primary">Loading…</button><button id="refresh">Refresh</button></div></section>
<section class="card"><h2>PRESET</h2><label for="preset">Selected preset</label><select id="preset"></select><label for="preamp">Preamp: <span id="preampValue"></span> dB</label><input id="preamp" type="range" min="-24" max="6" step="0.1"><label for="bass">Bass boost: <span id="bassValue"></span> dB</label><input id="bass" type="range" min="0" max="9" step="0.1"></section>
<section class="card"><h2>PREFERENCES</h2><label for="theme">Theme</label><select id="theme"><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select><label for="accentSetting">Accent color</label><input id="accentSetting" type="color"><label for="compactSetting">TUI layout</label><select id="compactSetting"><option value="auto">Automatic</option><option value="always">Compact</option><option value="never">Full</option></select><h2 style="margin-top:20px">TUI KEYS</h2><div class="bands"><label class="band">Previous band<input id="keyPreviousBand" maxlength="1"></label><label class="band">Next band<input id="keyNextBand" maxlength="1"></label><label class="band">Decrease value<input id="keyDecrease" maxlength="1"></label><label class="band">Increase value<input id="keyIncrease" maxlength="1"></label><label class="band">Toggle band<input id="keyToggleBypass" maxlength="1"></label><label class="band">Route PipeQ<input id="keyRouteEq" maxlength="1"></label><label class="band">Route physical<input id="keyRoutePhysical" maxlength="1"></label><label class="band">Save preset<input id="keySavePreset" maxlength="1"></label><label class="band">Help<input id="keyHelp" maxlength="1"></label></div><label><input id="autoRouteSetting" type="checkbox"> Keep PipeQ active across device changes</label><label for="defaultPreamp">New EQ preamp (dB)</label><input id="defaultPreamp" type="number" min="-24" max="6" step="0.1"><label for="defaultBass">New EQ bass boost (dB)</label><input id="defaultBass" type="number" min="0" max="9" step="0.1"><button id="saveSettings" class="primary">Save preferences</button></section>
<section class="card" style="grid-column:1/-1"><h2>EQ BANDS</h2><div id="bands" class="bands"></div></section></div><div id="message" class="message" role="status"></div></main>
<script nonce="__NONCE__">const token='__TOKEN__';let current;const $=id=>document.getElementById(id);const msg=text=>{$('message').textContent=text||''};const keys={previousBand:'keyPreviousBand',nextBand:'keyNextBand',decrease:'keyDecrease',increase:'keyIncrease',toggleBypass:'keyToggleBypass',routeEq:'keyRouteEq',routePhysical:'keyRoutePhysical',savePreset:'keySavePreset',help:'keyHelp'};async function act(action){try{const r=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-pipeq-token':token},body:JSON.stringify(action)});if(!r.ok)throw Error((await r.json()).error||'Action failed');msg('Updated');await refresh()}catch(e){msg(e.message)}}function option(select,item,label,selected){const o=document.createElement('option');o.value=String(item.id);o.textContent=label(item);o.selected=item.id===selected;select.append(o)}function render(s){current=s;$('status').textContent=(s.enabled?'● IN PIPEQ PATH':'○ BYPASSED')+' · '+(s.nodes.find(n=>n.id===s.selectedNodeId)?.description||'No EQ target')+' · '+(s.presets.find(p=>p.id===s.selectedPresetId)?.name||'No preset')+(s.presetDirty?' · unsaved changes':'');const output=$('output');output.replaceChildren();s.sinks.forEach(x=>option(output,x,x=>x.description||x.name,s.selectedOutputId));$('route').textContent=s.enabled?'Bypass PipeQ':'Route through PipeQ';const preset=$('preset');preset.replaceChildren();s.presets.forEach(x=>option(preset,x,x=>x.name,s.selectedPresetId));$('preamp').value=s.preamp;$('preampValue').textContent=Number(s.preamp).toFixed(1);$('bass').value=s.bassBoost;$('bassValue').textContent=Number(s.bassBoost).toFixed(1);document.documentElement.style.setProperty('--accent',s.accent);document.documentElement.dataset.theme=s.settings.ui.theme==='light'||(s.settings.ui.theme==='system'&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';$('theme').value=s.settings.ui.theme;$('accentSetting').value=s.settings.ui.accent;$('compactSetting').value=s.settings.ui.compactLayout;for(const [action,id] of Object.entries(keys))$(id).value=s.settings.ui.keybindings[action];$('autoRouteSetting').checked=s.settings.audio.autoRouteOnDeviceChange;$('defaultPreamp').value=s.settings.audio.defaultPreamp;$('defaultBass').value=s.settings.audio.defaultBassBoost;const bands=$('bands');bands.replaceChildren();for(const b of s.bands){const wrap=document.createElement('label');wrap.className='band';wrap.textContent=b.name+' · '+Math.round(b.freq)+' Hz · Gain dB';const input=document.createElement('input');input.type='range';input.min='-12';input.max='12';input.step='0.1';input.value=String(b.gain);input.setAttribute('aria-label',b.name+' gain in dB');input.onchange=()=>act({type:'band',name:b.name,parameter:'gain',value:Number(input.value)});wrap.append(input);bands.append(wrap)}}async function refresh(){const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw Error('PipeQ is unavailable');render(await r.json())}$('refresh').onclick=()=>refresh().catch(e=>msg(e.message));$('route').onclick=()=>act({type:'route',enabled:!current.enabled});$('preset').onchange=e=>act({type:'preset',id:e.target.value});$('output').onchange=e=>act({type:'output',id:Number(e.target.value)});$('preamp').onchange=e=>act({type:'preamp',value:Number(e.target.value)});$('bass').onchange=e=>act({type:'bass',value:Number(e.target.value)});$('saveSettings').onclick=()=>{const keybindings={};for(const [action,id] of Object.entries(keys))keybindings[action]=$(id).value;return act({type:'settings',value:{...current.settings,ui:{...current.settings.ui,theme:$('theme').value,accent:$('accentSetting').value,compactLayout:$('compactSetting').value,keybindings},audio:{...current.settings.audio,autoRouteOnDeviceChange:$('autoRouteSetting').checked,defaultPreamp:Number($('defaultPreamp').value),defaultBassBoost:Number($('defaultBass').value)}}})};refresh().catch(e=>msg(e.message));setInterval(()=>refresh().catch(()=>{}),2000);</script></body></html>`;

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
  if (action.type === "output") return Number.isSafeInteger(action.id) && Number(action.id) >= 0;
  if (action.type === "route") return typeof action.enabled === "boolean";
  if (action.type === "bass" || action.type === "preamp") return typeof action.value === "number" && Number.isFinite(action.value);
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
    response.setHeader("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    if (request.headers.host !== allowedHost()) return json(response, 403, { error: "Invalid host." });

    if (request.method === "GET" && request.url === "/") {
      const accent = options.getState().accent;
      const html = PAGE.replaceAll("__ACCENT__", /^#[0-9A-Fa-f]{6}$/.test(accent) ? accent : "#F3B562").replace("__NONCE__", nonce).replace("__TOKEN__", token);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
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
