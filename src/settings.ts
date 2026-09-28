import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { BASS_BOOST_MAX, BASS_BOOST_MIN, PREAMP_MAX, PREAMP_MIN } from "./eq.js";

export const SETTINGS_FILE_NAME = "settings.json";
export const SETTINGS_VERSION = 1;

export type Theme = "system" | "dark" | "light";
export type CompactLayout = "auto" | "always" | "never";
export type KeybindingAction =
  | "previousBand"
  | "nextBand"
  | "decrease"
  | "increase"
  | "toggleBypass"
  | "routeEq"
  | "routePhysical"
  | "savePreset"
  | "help";

export type Keybindings = Record<KeybindingAction, string>;

export type PipeqSettings = {
  version: typeof SETTINGS_VERSION;
  ui: {
    theme: Theme;
    accent: string;
    compactLayout: CompactLayout;
    keybindings: Keybindings;
  };
  audio: {
    autoRouteOnDeviceChange: boolean;
    defaultPreamp: number;
    defaultBassBoost: number;
  };
};

const DEFAULT_KEYBINDINGS: Keybindings = {
  previousBand: "H",
  nextBand: "L",
  decrease: "-",
  increase: "+",
  toggleBypass: "e",
  routeEq: "a",
  routePhysical: "d",
  savePreset: "s",
  help: "?",
};

export const DEFAULT_SETTINGS: PipeqSettings = {
  version: SETTINGS_VERSION,
  ui: {
    theme: "system",
    accent: "#F3B562",
    compactLayout: "auto",
    keybindings: DEFAULT_KEYBINDINGS,
  },
  audio: {
    autoRouteOnDeviceChange: true,
    defaultPreamp: 0,
    defaultBassBoost: 0,
  },
};

function configPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "pipeq", SETTINGS_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stringOption<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && (choices as readonly string[]).includes(value) ? value as T : fallback;
}

function accent(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : DEFAULT_SETTINGS.ui.accent;
}

function keybindings(value: unknown): Keybindings {
  const source = isRecord(value) ? value : {};
  const result = { ...DEFAULT_KEYBINDINGS };
  for (const action of Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[]) {
    const binding = source[action];
    if (typeof binding === "string" && binding.length === 1 && !/\s/.test(binding)) result[action] = binding;
  }
  return result;
}

/** Returns a fresh settings value so callers can safely modify it. */
export function defaultSettings(): PipeqSettings {
  return {
    version: SETTINGS_VERSION,
    ui: { ...DEFAULT_SETTINGS.ui, keybindings: { ...DEFAULT_KEYBINDINGS } },
    audio: { ...DEFAULT_SETTINGS.audio },
  };
}

/** Validates persisted settings, filling in values absent from older config files. */
export function sanitizeSettings(value: unknown): PipeqSettings {
  const defaults = defaultSettings();
  if (!isRecord(value)) return defaults;

  const ui = isRecord(value.ui) ? value.ui : {};
  const audio = isRecord(value.audio) ? value.audio : {};
  return {
    version: SETTINGS_VERSION,
    ui: {
      theme: stringOption(ui.theme, ["system", "dark", "light"], defaults.ui.theme),
      accent: accent(ui.accent),
      compactLayout: stringOption(ui.compactLayout, ["auto", "always", "never"], defaults.ui.compactLayout),
      keybindings: keybindings(ui.keybindings),
    },
    audio: {
      autoRouteOnDeviceChange: typeof audio.autoRouteOnDeviceChange === "boolean" ? audio.autoRouteOnDeviceChange : defaults.audio.autoRouteOnDeviceChange,
      defaultPreamp: clamp(finite(audio.defaultPreamp, defaults.audio.defaultPreamp), PREAMP_MIN, PREAMP_MAX),
      defaultBassBoost: clamp(finite(audio.defaultBassBoost, defaults.audio.defaultBassBoost), BASS_BOOST_MIN, BASS_BOOST_MAX),
    },
  };
}

/** Loads settings from $XDG_CONFIG_HOME/pipeq/settings.json without changing the file. */
export async function loadSettings(): Promise<PipeqSettings> {
  try {
    return sanitizeSettings(JSON.parse(await readFile(configPath(), "utf8")) as unknown);
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && (cause as { code?: unknown }).code === "ENOENT") return defaultSettings();
    if (cause instanceof SyntaxError) return defaultSettings();
    throw cause;
  }
}

/** Saves a sanitized, versioned config atomically in the user's XDG config directory. */
export async function saveSettings(settings: unknown): Promise<PipeqSettings> {
  const path = configPath();
  const next = sanitizeSettings(settings);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
  return next;
}
