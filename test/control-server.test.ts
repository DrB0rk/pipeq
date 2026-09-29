import assert from "node:assert/strict";
import test from "node:test";

import { startControlServer, type ControlState } from "../src/control-server.js";
import { defaultSettings } from "../src/settings.js";

const state: ControlState = {
  nodes: [{ id: 31, name: "pipeq", description: "PipeQ EQ" }],
  sinks: [{ id: 40, name: "speakers", description: "Speakers" }],
  presets: [{ id: "flat", name: "Flat" }],
  selectedNodeId: 31,
  defaultNodeId: 31,
  selectedOutputId: 40,
  selectedPresetId: "flat",
  presetDirty: false,
  enabled: true,
  bands: [{ name: "eq1", freq: 1000, gain: 0, q: 0.7 }],
  bassBoost: 0,
  preamp: 0,
  accent: "#F3B562",
  settings: defaultSettings(),
};

test("local control UI binds to loopback and exposes its live state without CORS", async () => {
  const service = await startControlServer({ getState: () => state, perform: async () => undefined });
  try {
    assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${service.url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), state);
    const script = await fetch(`${service.url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(await script.text(), /responseAtFrequency/);
    const responseModule = await fetch(`${service.url}/eq-response.js`);
    assert.match(await responseModule.text(), /peakingResponseDb/);
  } finally {
    await service.close();
  }
});

test("mutations require the served origin and process token", async () => {
  let actionCount = 0;
  const service = await startControlServer({ getState: () => state, perform: async () => { actionCount += 1; } });
  try {
    const page = await fetch(service.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
    const html = await page.text();
    const token = html.match(/data-token="([^"]+)"/)?.[1];
    assert.ok(token);
    assert.match(html, /Frequency response/);
    assert.match(html, /\/app\.js/);
    assert.match(html, /Preferences/);

    const script = await fetch(`${service.url}/app.js`);
    assert.match(await script.text(), /keyRouteEq/);

    const invalidOrigin = await fetch(`${service.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pipeq-token": token, origin: "http://localhost" },
      body: JSON.stringify({ type: "route", enabled: false }),
    });
    assert.equal(invalidOrigin.status, 403);

    const invalidToken = await fetch(`${service.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pipeq-token": "wrong", origin: service.url },
      body: JSON.stringify({ type: "route", enabled: false }),
    });
    assert.equal(invalidToken.status, 403);

    const accepted = await fetch(`${service.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pipeq-token": token, origin: service.url },
      body: JSON.stringify({ type: "route", enabled: false }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(actionCount, 1);

    const savePreferences = await fetch(`${service.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pipeq-token": token, origin: service.url },
      body: JSON.stringify({ type: "settings", value: { ui: { accent: "#112233" } } }),
    });
    assert.equal(savePreferences.status, 200);
    assert.equal(actionCount, 2);

    const createPreset = await fetch(`${service.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pipeq-token": token, origin: service.url },
      body: JSON.stringify({ type: "createPreset", name: "Late night" }),
    });
    assert.equal(createPreset.status, 200);

    const resetBand = await fetch(`${service.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pipeq-token": token, origin: service.url },
      body: JSON.stringify({ type: "resetBand", name: "eq1" }),
    });
    assert.equal(resetBand.status, 200);
    assert.equal(actionCount, 4);
  } finally {
    await service.close();
  }
});
