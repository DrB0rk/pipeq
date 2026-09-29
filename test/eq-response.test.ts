import assert from "node:assert/strict";
import test from "node:test";

import { lowShelfResponseDb, peakingResponseDb, responseAtFrequency } from "../web/eq-response.js";

test("peaking response reaches the configured gain at its center and returns to zero away from it", () => {
  const band = { freq: 1000, gain: 6, q: 0.7, enabled: true };
  assert.ok(Math.abs(peakingResponseDb(band, 1000) - 6) < 0.01);
  assert.ok(Math.abs(peakingResponseDb(band, 10000)) < 0.1);
  assert.equal(peakingResponseDb({ ...band, enabled: false }, 1000), 0);
});

test("combined response includes preamp, bass shelf, and enabled peaking bands", () => {
  const state = {
    preamp: 2,
    bassBoost: 8,
    bands: [
      { freq: 1000, gain: 3, q: 0.7, enabled: true },
      { freq: 4000, gain: -5, q: 1, enabled: false },
    ],
  };
  const low = responseAtFrequency(state, 20);
  const high = responseAtFrequency(state, 18000);
  assert.ok(low > high + 7);
  assert.ok(Math.abs(high - 2) < 0.1);
  assert.ok(Math.abs(lowShelfResponseDb(8, 18000)) < 0.1);
});
