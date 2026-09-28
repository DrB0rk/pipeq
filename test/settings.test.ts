import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_SETTINGS, SETTINGS_FILE_NAME, SETTINGS_VERSION, defaultSettings, loadSettings, sanitizeSettings, saveSettings } from "../src/settings.js";

test("default settings are independent and enable automatic routing", () => {
  const first = defaultSettings();
  const second = defaultSettings();
  first.ui.keybindings.help = "h";

  assert.equal(second.ui.keybindings.help, "?");
  assert.equal(first.audio.autoRouteOnDeviceChange, true);
  assert.equal(first.version, SETTINGS_VERSION);
});

test("settings sanitization accepts supported customization and bounds audio defaults", () => {
  const settings = sanitizeSettings({
    version: 0,
    ui: {
      theme: "dark",
      accent: "#00aaFF",
      compactLayout: "always",
      keybindings: { help: "h", routeEq: "r", nextBand: "down" },
    },
    audio: { autoRouteOnDeviceChange: false, defaultPreamp: 100, defaultBassBoost: -4 },
  });

  assert.equal(settings.version, SETTINGS_VERSION);
  assert.equal(settings.ui.theme, "dark");
  assert.equal(settings.ui.accent, "#00AAFF");
  assert.equal(settings.ui.compactLayout, "always");
  assert.equal(settings.ui.keybindings.help, "h");
  assert.equal(settings.ui.keybindings.routeEq, "r");
  assert.equal(settings.ui.keybindings.nextBand, DEFAULT_SETTINGS.ui.keybindings.nextBand);
  assert.equal(settings.audio.autoRouteOnDeviceChange, false);
  assert.equal(settings.audio.defaultPreamp, 6);
  assert.equal(settings.audio.defaultBassBoost, 0);
});

test("loading legacy, malformed, and absent config files leaves them untouched and returns safe settings", async () => {
  const previous = process.env.XDG_CONFIG_HOME;
  const directory = await mkdtemp(join(tmpdir(), "pipeq-settings-"));
  process.env.XDG_CONFIG_HOME = directory;
  const path = join(directory, "pipeq", SETTINGS_FILE_NAME);
  try {
    assert.deepEqual(await loadSettings(), defaultSettings());

    await mkdir(join(directory, "pipeq"), { recursive: true });
    await writeFile(path, '{"ui":{"theme":"light"},"audio":{"defaultPreamp":-5}}', "utf8");
    const legacy = await loadSettings();
    assert.equal(legacy.ui.theme, "light");
    assert.equal(legacy.audio.defaultPreamp, -5);
    assert.equal(await readFile(path, "utf8"), '{"ui":{"theme":"light"},"audio":{"defaultPreamp":-5}}');

    await writeFile(path, "{ invalid", "utf8");
    assert.deepEqual(await loadSettings(), defaultSettings());
    assert.equal(await readFile(path, "utf8"), "{ invalid");
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("saving writes only validated versioned settings to the XDG config path", async () => {
  const previous = process.env.XDG_CONFIG_HOME;
  const directory = await mkdtemp(join(tmpdir(), "pipeq-settings-"));
  process.env.XDG_CONFIG_HOME = directory;
  try {
    const saved = await saveSettings({ ui: { accent: "#123456" }, audio: { defaultBassBoost: 2.5 } });
    const path = join(directory, "pipeq", SETTINGS_FILE_NAME);
    assert.equal(saved.ui.accent, "#123456");
    assert.equal(saved.audio.defaultBassBoost, 2.5);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), saved);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
