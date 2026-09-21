import type { EqBand, EqParameter } from "./types.js";

export const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const MIN_GAIN = -12;
export const MAX_GAIN = 12;
export const GAIN_STEP = 0.1;
export const MIN_FREQ = 20;
export const MAX_FREQ = 20000;
export const MIN_Q = 0.1;
export const MAX_Q = 10;

export const DEFAULT_Q = 0.7;
export const PREAMP_PORT = "preamp:Mult";
export const PREAMP_ADD_PORT = "preamp:Add";
export const PREAMP_MIN = -24;
export const PREAMP_MAX = 6;
export const PREAMP_STEP = 0.1;
export const BASS_BOOST_PORT = "bass:Gain";
export const BASS_FREQUENCY_PORT = "bass:Freq";
export const BASS_Q_PORT = "bass:Q";
export const BASS_TRIM_PORT = "bass_trim:Mult";
export const BASS_BOOST_MIN = 0;
export const BASS_BOOST_MAX = 9;
export const BASS_BOOST_STEP = 0.1;
export const BASS_BOOST_FREQUENCY = 120;
export const BASS_BOOST_Q = 0.7;

const HEADROOM_SAMPLE_RATES = [44100, 48000, 96000, 192000];
const HEADROOM_RESPONSE_POINTS = 512;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function flattenParams(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};

  const params: Record<string, unknown> = {};
  for (let index = 0; index + 1 < value.length; index += 2) {
    const key = value[index];
    if (typeof key === "string") params[key] = value[index + 1];
  }
  return params;
}

export function buildBands(params: Record<string, unknown>): EqBand[] {
  const indexes = new Set<number>();
  for (const key of Object.keys(params)) {
    const match = /^eq(\d+):(Freq|Gain|Q)$/.exec(key);
    if (match) indexes.add(Number(match[1]));
  }

  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => ({
      index,
      name: `eq${index}`,
      freq: clamp(finiteOr(params[`eq${index}:Freq`], EQ_FREQUENCIES[index - 1] ?? 1000), MIN_FREQ, MAX_FREQ),
      gain: clamp(finiteOr(params[`eq${index}:Gain`], 0), MIN_GAIN, MAX_GAIN),
      q: clamp(finiteOr(params[`eq${index}:Q`], DEFAULT_Q), MIN_Q, MAX_Q),
      enabled: true,
    }));
}

export function preserveBandIndex(bands: EqBand[], previousIndex: number, previousName: string | undefined, nodeChanged: boolean): number {
  if (!bands.length || nodeChanged) return 0;
  const matchingIndex = previousName ? bands.findIndex((band) => band.name === previousName) : -1;
  return Math.max(0, Math.min(bands.length - 1, matchingIndex >= 0 ? matchingIndex : previousIndex));
}

export function updateBand(band: EqBand, parameter: EqParameter, value: number): EqBand {
  if (parameter === "Gain") return { ...band, gain: clamp(value, MIN_GAIN, MAX_GAIN) };
  if (parameter === "Freq") return { ...band, freq: clamp(value, MIN_FREQ, MAX_FREQ) };
  return { ...band, q: clamp(value, MIN_Q, MAX_Q) };
}

export function stepBand(band: EqBand, parameter: EqParameter, direction: 1 | -1): EqBand {
  if (parameter === "Gain") {
    const nextGain = Math.round((band.gain + direction * GAIN_STEP) / GAIN_STEP) * GAIN_STEP;
    return updateBand(band, parameter, nextGain);
  }
  if (parameter === "Q") return updateBand(band, parameter, band.q + direction * 0.1);

  const multiplier = direction > 0 ? 1.12 : 1 / 1.12;
  return updateBand(band, parameter, band.freq * multiplier);
}

export function formatFrequency(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return `${Math.round(value)}`;
}

export function formatValue(parameter: EqParameter, value: number): string {
  if (parameter === "Gain") return `${value >= 0 ? "+" : ""}${value.toFixed(2)} dB`;
  if (parameter === "Freq") return `${formatFrequency(value)} Hz`;
  return `Q ${value.toFixed(1)}`;
}

export function portName(band: EqBand, parameter: EqParameter): string {
  return `${band.name}:${parameter}`;
}

export function bassBoostFromParams(params: Record<string, unknown>): number {
  return clamp(finiteOr(params[BASS_BOOST_PORT], BASS_BOOST_MIN), BASS_BOOST_MIN, BASS_BOOST_MAX);
}

export function preampFromParams(params: Record<string, unknown>): number {
  const multiplier = finiteOr(params[PREAMP_PORT], 1);
  if (multiplier <= 0) return PREAMP_MIN;
  return clamp(20 * Math.log10(multiplier), PREAMP_MIN, PREAMP_MAX);
}

export function preampMultiplierForDb(value: number): number {
  return 10 ** (clamp(value, PREAMP_MIN, PREAMP_MAX) / 20);
}

export function hasPreamp(params: Record<string, unknown>): boolean {
  return typeof params[BASS_TRIM_PORT] === "number" && (typeof params[PREAMP_PORT] === "number" || typeof params[BASS_BOOST_PORT] === "number");
}

export function hasBassBoost(params: Record<string, unknown>): boolean {
  return typeof params[BASS_BOOST_PORT] === "number" && typeof params[BASS_TRIM_PORT] === "number";
}

export function bassTrimForBoost(boost: number): number {
  return 10 ** (-clamp(boost, BASS_BOOST_MIN, BASS_BOOST_MAX) / 20);
}

function peakingMagnitude(band: EqBand, frequency: number, sampleRate: number): number {
  if (band.gain === 0) return 1;

  const amplitude = 10 ** (band.gain / 40);
  const omega = 2 * Math.PI * frequency / sampleRate;
  const alpha = Math.sin(omega) / (2 * Math.max(MIN_Q, band.q));
  const cosine = Math.cos(omega);
  const b0 = 1 + alpha * amplitude;
  const b1 = -2 * cosine;
  const b2 = 1 - alpha * amplitude;
  const a0 = 1 + alpha / amplitude;
  const a1 = -2 * cosine;
  const a2 = 1 - alpha / amplitude;
  const cosine2 = Math.cos(2 * omega);
  const sine = Math.sin(omega);
  const sine2 = Math.sin(2 * omega);
  const numerator = Math.hypot(b0 + b1 * cosine + b2 * cosine2, b1 * sine + b2 * sine2);
  const denominator = Math.hypot(a0 + a1 * cosine + a2 * cosine2, a1 * sine + a2 * sine2);
  return numerator / Math.max(Number.EPSILON, denominator);
}

export function headroomTrimForBands(bands: EqBand[], bassBoost = BASS_BOOST_MIN, preamp = 0): number {
  let peakAmplitude = 1;

  for (const sampleRate of HEADROOM_SAMPLE_RATES) {
    const maximumFrequency = Math.min(MAX_FREQ, sampleRate * 0.49);
    const frequencies = new Set<number>();
    for (let index = 0; index < HEADROOM_RESPONSE_POINTS; index += 1) {
      const progress = index / (HEADROOM_RESPONSE_POINTS - 1);
      frequencies.add(MIN_FREQ * (maximumFrequency / MIN_FREQ) ** progress);
    }
    for (const band of bands) {
      for (const multiplier of [0.98, 1, 1.02]) {
        frequencies.add(Math.min(maximumFrequency, Math.max(MIN_FREQ, band.freq * multiplier)));
      }
    }

    for (const frequency of frequencies) {
      const amplitude = bands.reduce((total, band) => band.enabled === false ? total : total * peakingMagnitude(band, frequency, sampleRate), 1);
      peakAmplitude = Math.max(peakAmplitude, amplitude);
    }
  }

  return bassTrimForBoost(bassBoost) / (peakAmplitude * preampMultiplierForDb(Math.max(0, preamp)));
}
