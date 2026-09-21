import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BASS_BOOST_MAX, BASS_BOOST_MIN, PREAMP_MAX, PREAMP_MIN } from "./eq.js";
import type { EqBand, EqPreset } from "./types.js";

export const PRESET_FILE_NAME = "presets.json";

function presetPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "pipeq", PRESET_FILE_NAME);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeBand(value: unknown): EqBand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<EqBand>;
  if (typeof candidate.name !== "string" || !/^eq\d+$/.test(candidate.name)) return undefined;
  return {
    index: Math.max(1, Math.round(finite(candidate.index, 1))),
    name: candidate.name,
    freq: Math.min(20000, Math.max(20, finite(candidate.freq, 1000))),
    gain: Math.min(12, Math.max(-12, finite(candidate.gain, 0))),
    q: Math.min(10, Math.max(0.1, finite(candidate.q, 0.7))),
    enabled: candidate.enabled !== false,
  };
}

function sanitizePreset(value: unknown): EqPreset | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<EqPreset>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || !Array.isArray(candidate.bands)) return undefined;
  const bands = candidate.bands.map(sanitizeBand).filter((band): band is EqBand => band !== undefined);
  if (!bands.length) return undefined;
  return {
    id: candidate.id,
    name: candidate.name.trim() || "Unnamed preset",
    bands,
    bassBoost: Math.min(BASS_BOOST_MAX, Math.max(BASS_BOOST_MIN, finite(candidate.bassBoost, BASS_BOOST_MIN))),
    preamp: Math.min(PREAMP_MAX, Math.max(PREAMP_MIN, finite(candidate.preamp, 0))),
  };
}

export async function loadPresets(): Promise<EqPreset[]> {
  try {
    const raw = JSON.parse(await readFile(presetPath(), "utf8")) as unknown;
    const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { presets?: unknown }).presets) ? (raw as { presets: unknown[] }).presets : [];
    return values.map(sanitizePreset).filter((preset): preset is EqPreset => preset !== undefined);
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && (cause as { code?: unknown }).code === "ENOENT") return [];
    throw cause;
  }
}

export async function savePresets(presets: EqPreset[]): Promise<void> {
  const path = presetPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, presets }, null, 2)}\n`, "utf8");
}

export function upsertPreset(presets: EqPreset[], next: EqPreset): EqPreset[] {
  const existingIndex = presets.findIndex((preset) => preset.name.toLowerCase() === next.name.toLowerCase());
  if (existingIndex < 0) return [...presets, next];
  return presets.map((preset, index) => index === existingIndex ? { ...next, id: preset.id } : preset);
}
