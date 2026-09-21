import test from "node:test";
import assert from "node:assert/strict";

import { BASS_BOOST_FREQUENCY, BASS_BOOST_MAX, BASS_BOOST_PORT, BASS_TRIM_PORT, GAIN_STEP, PREAMP_MAX, PREAMP_PORT, bassBoostFromParams, bassTrimForBoost, buildBands, flattenParams, formatFrequency, formatValue, hasPreamp, headroomTrimForBands, preampFromParams, preampMultiplierForDb, preserveBandIndex, stepBand } from "../src/eq.js";
import { SgrMouseParser } from "../src/mouse.js";
import { ROUTED_STAGE_VOLUME, buildDefaultEqConfig, effectiveVolume, effectiveVolumeForDefault, parseDefaultAudioSinkId, volumeFadeValues, volumesForTarget } from "../src/pipewire.js";
import { upsertPreset } from "../src/presets.js";

test("flattenParams converts PipeWire's alternating params struct", () => {
  assert.deepEqual(flattenParams(["eq1:Gain", -2.5, "eq1:Q", 0.8]), {
    "eq1:Gain": -2.5,
    "eq1:Q": 0.8,
  });
});

test("buildBands sorts and clamps named filter controls", () => {
  const bands = buildBands({
    "eq2:Freq": 64,
    "eq2:Gain": 20,
    "eq2:Q": 0.8,
    "eq1:Freq": 32,
    "eq1:Gain": -2,
    "eq1:Q": 0.7,
  });

  assert.deepEqual(bands.map(({ name, freq, gain, q }) => ({ name, freq, gain, q })), [
    { name: "eq1", freq: 32, gain: -2, q: 0.7 },
    { name: "eq2", freq: 64, gain: 12, q: 0.8 },
  ]);
});

test("frequency steps are logarithmic and gain steps are one tenth of a decibel", () => {
  const band = { index: 1, name: "eq1", freq: 1000, gain: 0, q: 0.7 };
  assert.equal(stepBand(band, "Gain", 1).gain, GAIN_STEP);
  assert.equal(stepBand(stepBand(band, "Gain", 1), "Gain", 1).gain, 0.2);
  assert.equal(formatValue("Gain", GAIN_STEP), "+0.10 dB");
  assert.equal(Math.round(stepBand(band, "Freq", 1).freq), 1120);
});

test("frequency labels stay compact", () => {
  assert.equal(formatFrequency(1000), "1.0k");
  assert.equal(formatFrequency(16000), "16k");
  assert.equal(formatFrequency(250), "250");
});

test("band selection survives refreshes and follows the same named band", () => {
  const bands = buildBands({
    "eq1:Freq": 32, "eq1:Gain": 0, "eq1:Q": 0.7,
    "eq2:Freq": 64, "eq2:Gain": 0, "eq2:Q": 0.7,
    "eq3:Freq": 125, "eq3:Gain": 0, "eq3:Q": 0.7,
  });
  assert.equal(preserveBandIndex(bands, 1, "eq2", false), 1);
  assert.equal(preserveBandIndex(bands, 1, "eq2", true), 0);
  assert.equal(preserveBandIndex(bands, 8, undefined, false), 2);
});

test("default EQ config contains a linked ten-band filter chain", () => {
  const config = buildDefaultEqConfig();
  assert.equal((config.match(/name = eq\d+/g) ?? []).length, 10);
  assert.equal((config.match(/label = bq_peaking/g) ?? []).length, 10);
  assert.equal((config.match(/label = bq_lowshelf/g) ?? []).length, 1);
  assert.equal((config.match(/label = linear/g) ?? []).length, 2);
  assert.equal((config.match(/output = "eq\d+:Out"/g) ?? []).length, 10);
  assert.match(config, /output = "bass:Out" input = "eq1:In"/);
  assert.match(config, /output = "preamp:Out" input = "bass:In"/);
  assert.match(config, /name = preamp label = linear/);
  assert.match(config, /output = "eq10:Out" input = "bass_trim:In"/);
  assert.match(config, /node\.name = "effect_input\.pipeq-default"/);
});

test("bass boost is bounded and keeps output headroom in sync", () => {
  assert.equal(BASS_BOOST_FREQUENCY, 120);
  assert.equal(bassBoostFromParams({ [BASS_BOOST_PORT]: 12, [BASS_TRIM_PORT]: 1 }), BASS_BOOST_MAX);
  assert.equal(bassBoostFromParams({ [BASS_BOOST_PORT]: -2, [BASS_TRIM_PORT]: 1 }), 0);
  assert.equal(Number(bassTrimForBoost(6).toFixed(6)), 0.501187);
});

test("preamp stays bounded and converts cleanly between dB and linear control", () => {
  assert.equal(preampFromParams({ [PREAMP_PORT]: 2 }), PREAMP_MAX);
  assert.equal(Number(preampFromParams({ [PREAMP_PORT]: 0.5 }).toFixed(4)), -6.0206);
  assert.equal(Number(preampMultiplierForDb(-6).toFixed(6)), 0.501187);
  assert.equal(hasPreamp({ [PREAMP_PORT]: 1, [BASS_TRIM_PORT]: 1 }), true);
  assert.equal(hasPreamp({ [BASS_BOOST_PORT]: 0, [BASS_TRIM_PORT]: 1 }), true);
  assert.equal(hasPreamp({ [PREAMP_PORT]: 1 }), false);
});

test("headroom trim stays unity when flat and follows positive EQ peaks", () => {
  const flat = [{ index: 1, name: "eq1", freq: 1000, gain: 0, q: 0.7 }];
  const boosted = [{ ...flat[0], gain: 6 }];
  assert.equal(headroomTrimForBands(flat, 0), 1);
  assert.ok(headroomTrimForBands(boosted, 0) > 0.49 && headroomTrimForBands(boosted, 0) < 0.51);
  assert.ok(headroomTrimForBands(boosted, 6) < 0.26);
  assert.ok(headroomTrimForBands(flat, 0, 6) < 0.51);
  assert.equal(headroomTrimForBands([{ ...flat[0], enabled: false }], 0), 1);
});

test("default audio sink parser recognizes physical and filter sinks", () => {
  assert.equal(parseDefaultAudioSinkId("\nAudio\n ├─ Sinks\n │  *  120. ARGON ALTO\n ├─ Sources\n"), 120);
  assert.equal(parseDefaultAudioSinkId("\nAudio\n ├─ Sinks\n │    120. ARGON ALTO\n ├─ Sources\n ├─ Filters\n │  *   43. effect_input.pipeq-default\n └─ Streams\n"), 43);
});

test("volume handoff preserves effective attenuation in either direction", () => {
  assert.equal(effectiveVolume(0.42, 1), 0.42);
  assert.equal(effectiveVolume(0.8, 0.5), 0.4);
  assert.equal(ROUTED_STAGE_VOLUME, 0.99);
  assert.deepEqual(volumesForTarget(0.42, "eq"), { eqVolume: 0.42424242424242425, physicalVolume: 0.99 });
  assert.deepEqual(volumesForTarget(0.42, "physical"), { eqVolume: 1, physicalVolume: 0.42 });
  assert.deepEqual(volumesForTarget(2, "physical"), { eqVolume: 1, physicalVolume: 0.99 });
  assert.equal(effectiveVolumeForDefault({ volume: 0.42, muted: false }, { volume: 1, muted: false }, 42, 42, 59), 0.42);
  assert.equal(effectiveVolumeForDefault({ volume: 0.42, muted: false }, { volume: 0.31, muted: false }, 59, 42, 59), 0.31);
});

test("volume fade reaches the target in small monotonic steps", () => {
  assert.deepEqual(volumeFadeValues(0.31, 0, 4).map((value) => Number(value.toFixed(4))), [0.2325, 0.155, 0.0775, 0]);
  assert.deepEqual(volumeFadeValues(0, 0.31, 4).map((value) => Number(value.toFixed(4))), [0.0775, 0.155, 0.2325, 0.31]);
});

test("preset names update existing entries without duplicating them", () => {
  const band = { index: 1, name: "eq1", freq: 32, gain: 2, q: 0.7 };
  const original = { id: "one", name: "Warm", bands: [band], bassBoost: 1 };
  const updated = { id: "new-id", name: "warm", bands: [{ ...band, gain: 4 }], bassBoost: 2 };
  const presets = upsertPreset([original], updated);
  assert.equal(presets.length, 1);
  assert.equal(presets[0]?.id, "one");
  assert.equal(presets[0]?.bands[0]?.gain, 4);
});

test("SGR mouse parser handles chunked drag events", () => {
  const parser = new SgrMouseParser();
  assert.deepEqual(parser.feed("\u001B[<0;12;5"), []);
  assert.deepEqual(parser.feed("M\u001B[<32;14;8M\u001B[<0;14;8m"), [
    { action: "press", button: 0, x: 11, y: 4, shift: false, alt: false, ctrl: false },
    { action: "move", button: 0, x: 13, y: 7, shift: false, alt: false, ctrl: false },
    { action: "release", button: 0, x: 13, y: 7, shift: false, alt: false, ctrl: false },
  ]);
});
