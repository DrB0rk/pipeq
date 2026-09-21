import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { BASS_BOOST_FREQUENCY, BASS_BOOST_PORT, BASS_BOOST_MAX, BASS_BOOST_MIN, BASS_BOOST_Q, BASS_FREQUENCY_PORT, BASS_Q_PORT, BASS_TRIM_PORT, PREAMP_ADD_PORT, PREAMP_MAX, PREAMP_MIN, PREAMP_PORT, buildBands, EQ_FREQUENCIES, flattenParams, headroomTrimForBands, preampMultiplierForDb, portName } from "./eq.js";
import type { EqBand, PipeWireNode, PipeWireNodeSummary } from "./types.js";

const execFileAsync = promisify(execFile);

type PipeWireDumpItem = {
  id: number;
  type: string;
  info?: {
    props?: Record<string, unknown>;
    params?: {
      Props?: Array<Record<string, unknown>>;
    };
  };
};

export type VolumeState = {
  volume: number;
  muted: boolean;
};

export type VolumeTarget = "eq" | "physical";

const VOLUME_FADE_STEPS = 8;
const VOLUME_FADE_DELAY_MS = 10;
export const ROUTED_STAGE_VOLUME = 0.99;

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function effectiveVolumeForDefault(eqState: VolumeState, physicalState: VolumeState, currentDefaultId: number | undefined, eqNodeId: number, physicalSinkId: number): number {
  if (currentDefaultId === eqNodeId) return eqState.volume;
  if (currentDefaultId === physicalSinkId) return physicalState.volume;
  return effectiveVolume(eqState.volume, physicalState.volume);
}

function activeMute(eqState: VolumeState, physicalState: VolumeState, currentDefaultId: number | undefined, eqNodeId: number, physicalSinkId: number): boolean {
  if (currentDefaultId === eqNodeId) return eqState.muted;
  if (currentDefaultId === physicalSinkId) return physicalState.muted;
  return eqState.muted || physicalState.muted;
}

export function effectiveVolume(eqVolume: number, physicalVolume: number): number {
  return clampVolume(eqVolume) * clampVolume(physicalVolume);
}

export function volumesForTarget(volume: number, target: VolumeTarget): { eqVolume: number; physicalVolume: number } {
  const effective = clampVolume(volume);
  return target === "eq"
    ? { eqVolume: clampVolume(effective / ROUTED_STAGE_VOLUME), physicalVolume: ROUTED_STAGE_VOLUME }
    : { eqVolume: 1, physicalVolume: Math.min(effective, ROUTED_STAGE_VOLUME) };
}

export function volumeFadeValues(from: number, to: number, steps = VOLUME_FADE_STEPS): number[] {
  const start = clampVolume(from);
  const end = clampVolume(to);
  const count = Math.max(1, Math.floor(steps));
  return Array.from({ length: count }, (_, index) => start + (end - start) * ((index + 1) / count));
}

function defaultAudioSinkNameFromDump(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "PipeWire:Interface:Metadata") continue;
    const metadata = (item as { metadata?: unknown }).metadata;
    if (!Array.isArray(metadata)) continue;
    for (const entry of metadata) {
      if (!entry || typeof entry !== "object" || (entry as { key?: unknown }).key !== "default.audio.sink") continue;
      const raw = (entry as { value?: unknown }).value;
      if (raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string") return (raw as { name: string }).name;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw) as { name?: unknown };
          if (typeof parsed.name === "string") return parsed.name;
        } catch {
          return raw;
        }
      }
    }
  }
  return undefined;
}

export function parseDefaultAudioSinkId(status: string): number | undefined {
  const audio = status.match(/\nAudio\n([\s\S]*?)(?:\nVideo\n|$)/)?.[1] ?? "";
  let section: "sinks" | "filters" | undefined;
  for (const line of audio.split("\n")) {
    if (line.includes("├─ Sinks")) section = "sinks";
    else if (line.includes("├─ Filters")) section = "filters";
    else if (line.includes("├─ Sources") || line.includes("└─ Streams")) section = undefined;

    if (section) {
      const match = /\*\s+(\d+)\./.exec(line);
      if (match) return Number(match[1]);
    }
  }

  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isEqNode(node: PipeWireNode): boolean {
  const controlNames = Object.keys(node.params);
  return controlNames.some((name) => /^eq\d+:(Freq|Gain|Q)$/.test(name));
}

export const DEFAULT_EQ_NODE_NAME = "effect_input.pipeq-default";
export const DEFAULT_EQ_DESCRIPTION = "PipeQ Default Equalizer";
export const DEFAULT_EQ_CONFIG_PATH = "pipeq-default.conf";

function quoteConfigString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildDefaultEqConfig(): string {
  const eqNodes = EQ_FREQUENCIES.map((frequency, index) => {
    const name = `eq${index + 1}`;
    return `{ type = builtin name = ${name} label = bq_peaking control = { Freq = ${frequency} Q = 0.7 Gain = 0.0 } }`;
  }).join("\n        ");
  const nodes = [
    `{ type = builtin name = preamp label = linear control = { Mult = 1.0 Add = 0.0 } }`,
    `{ type = builtin name = bass label = bq_lowshelf control = { Freq = ${BASS_BOOST_FREQUENCY} Q = ${BASS_BOOST_Q} Gain = ${BASS_BOOST_MIN} } }`,
    `{ type = builtin name = bass_trim label = linear control = { Mult = 1.0 Add = 0.0 } }`,
    eqNodes,
  ].join("\n        ");
  const links = [
    `{ output = ${quoteConfigString("preamp:Out")} input = ${quoteConfigString("bass:In")} }`,
    `{ output = ${quoteConfigString("bass:Out")} input = ${quoteConfigString("eq1:In")} }`,
    ...EQ_FREQUENCIES.slice(0, -1).map((_, index) => {
    const from = `eq${index + 1}`;
    const to = `eq${index + 2}`;
    return `{ output = ${quoteConfigString(`${from}:Out`)} input = ${quoteConfigString(`${to}:In`)} }`;
    }),
    `{ output = ${quoteConfigString("eq10:Out")} input = ${quoteConfigString("bass_trim:In")} }`,
  ].join("\n        ");

  return `# Generated by PipeQ. Edit bands from the TUI instead of this file.\n\ncontext.modules = [\n{\n  name = libpipewire-module-filter-chain\n  args = {\n    node.description = ${quoteConfigString(DEFAULT_EQ_DESCRIPTION)}\n    media.name = ${quoteConfigString(DEFAULT_EQ_DESCRIPTION)}\n\n    filter.graph = {\n      nodes = [\n        ${nodes}\n      ]\n\n      links = [\n        ${links}\n      ]\n    }\n\n    capture.props = {\n      node.name = ${quoteConfigString(DEFAULT_EQ_NODE_NAME)}\n      media.class = Audio/Sink\n      audio.channels = 2\n      audio.position = [ FL FR ]\n    }\n\n    playback.props = {\n      node.name = ${quoteConfigString("effect_output.pipeq-default")}\n      node.passive = true\n      audio.channels = 2\n      audio.position = [ FL FR ]\n    }\n  }\n}\n]\n`;
}

function toNode(item: PipeWireDumpItem): PipeWireNode | undefined {
  if (item.type !== "PipeWire:Interface:Node") return undefined;

  const props = item.info?.props ?? {};
  const currentProps = item.info?.params?.Props?.find((candidate) => {
    const values = candidate.params;
    return Array.isArray(values) && values.some((value) => typeof value === "string" && /^eq\d+:(Freq|Gain|Q)$/.test(value));
  }) ?? {};
  const params = flattenParams(currentProps.params);
  const name = text(props["node.name"]);
  const description = text(props["node.description"]) || name;
  if (!name) return undefined;

  return {
    id: item.id,
    name,
    description,
    ...(text(props["media.class"]) ? { mediaClass: text(props["media.class"]) } : {}),
    params,
  };
}

export class PipeWireClient {
  async dumpNodes(): Promise<PipeWireNode[]> {
    const { stdout } = await execFileAsync("pw-dump", [], { maxBuffer: 16 * 1024 * 1024 });
    const dump = JSON.parse(stdout) as PipeWireDumpItem[];
    return dump.flatMap((item) => {
      const node = toNode(item);
      return node ? [node] : [];
    });
  }

  async findEqNodes(): Promise<PipeWireNode[]> {
    const nodes = await this.dumpNodes();
    return nodes.filter(isEqNode);
  }

  async getDefaultAudioSinkId(): Promise<number | undefined> {
    const { stdout } = await execFileAsync("wpctl", ["status"]);
    return parseDefaultAudioSinkId(stdout);
  }

  async setDefaultAudioSink(nodeId: number): Promise<void> {
    await execFileAsync("wpctl", ["set-default", String(nodeId)]);
  }

  async getVolumeState(nodeId: number): Promise<VolumeState> {
    const { stdout } = await execFileAsync("wpctl", ["get-volume", String(nodeId)]);
    const match = /Volume:\s+([0-9]+(?:\.[0-9]+)?)/.exec(stdout);
    if (!match) throw new Error(`Could not read volume for PipeWire node ${nodeId}.`);
    return { volume: clampVolume(Number(match[1])), muted: /\[MUTED\]/.test(stdout) };
  }

  async getVolume(nodeId: number): Promise<number> {
    return (await this.getVolumeState(nodeId)).volume;
  }

  async setVolume(nodeId: number, volume: number): Promise<void> {
    await execFileAsync("wpctl", ["set-volume", String(nodeId), clampVolume(volume).toFixed(4)]);
  }

  async setMute(nodeId: number, muted: boolean): Promise<void> {
    await execFileAsync("wpctl", ["set-mute", String(nodeId), muted ? "1" : "0"]);
  }

  async findPhysicalSinkForFilter(outputNodeName: string): Promise<number | undefined> {
    const { stdout } = await execFileAsync("pw-link", ["-l"]);
    const outputLines = stdout.split("\n");
    const outputIndex = outputLines.findIndex((line) => line.trim() === `${outputNodeName}:output_FL`);
    if (outputIndex < 0) return undefined;
    const targetLine = outputLines.slice(outputIndex + 1).find((line) => line.includes("|-> "));
    const targetName = targetLine?.match(/\|->\s+([^:]+):playback_FL/)?.[1];
    if (!targetName) return undefined;
    const target = (await this.dumpNodes()).find((node) => node.name === targetName && node.mediaClass === "Audio/Sink");
    return target?.id;
  }

  private async physicalSinkForEq(outputNodeName: string): Promise<number> {
    const physicalSinkId = await this.findPhysicalSinkForFilter(outputNodeName);
    if (physicalSinkId === undefined) throw new Error("Could not find the physical sink behind the EQ.");
    return physicalSinkId;
  }

  private async fadeVolume(nodeId: number, from: number, to: number): Promise<void> {
    const values = volumeFadeValues(from, to);
    for (const [index, value] of values.entries()) {
      await this.setVolume(nodeId, value);
      if (index < values.length - 1) await new Promise((resolve) => setTimeout(resolve, VOLUME_FADE_DELAY_MS));
    }
  }

  private async fadeActivePath(eqNodeId: number, physicalSinkId: number, currentDefaultId: number | undefined, eqVolume: number, physicalVolume: number): Promise<void> {
    if (currentDefaultId === eqNodeId) {
      await this.fadeVolume(eqNodeId, eqVolume, 0);
      return;
    }
    if (currentDefaultId === physicalSinkId) {
      await this.fadeVolume(physicalSinkId, physicalVolume, 0);
      return;
    }

    // An unknown default is an exceptional state (for example, a device was
    // removed). Quiet both possible paths before repairing the routing.
    await Promise.all([
      this.fadeVolume(eqNodeId, eqVolume, 0),
      this.fadeVolume(physicalSinkId, physicalVolume, 0),
    ]);
  }

  private async restoreVolumeTransition(eqNodeId: number, physicalSinkId: number, originalDefaultId: number | undefined, eqState: VolumeState, physicalState: VolumeState): Promise<void> {
    await Promise.all([
      this.setMute(eqNodeId, true).catch(() => undefined),
      this.setMute(physicalSinkId, true).catch(() => undefined),
    ]);
    if (originalDefaultId !== undefined) await this.setDefaultAudioSink(originalDefaultId).catch(() => undefined);
    await Promise.all([
      this.setVolume(eqNodeId, eqState.volume).catch(() => undefined),
      this.setVolume(physicalSinkId, Math.min(physicalState.volume, ROUTED_STAGE_VOLUME)).catch(() => undefined),
    ]);
    await Promise.all([
      this.setMute(eqNodeId, eqState.muted).catch(() => undefined),
      this.setMute(physicalSinkId, physicalState.muted).catch(() => undefined),
    ]);
  }

  async switchDefaultToEq(eqNodeId: number, outputNodeName = "effect_output.pipeq-default", sourceDefaultId?: number): Promise<number> {
    const physicalSinkId = await this.physicalSinkForEq(outputNodeName);
    const [eqState, physicalState, currentDefaultId] = await Promise.all([
      this.getVolumeState(eqNodeId),
      this.getVolumeState(physicalSinkId),
      this.getDefaultAudioSinkId().catch(() => undefined),
    ]);
    const effective = effectiveVolumeForDefault(eqState, physicalState, sourceDefaultId ?? currentDefaultId, eqNodeId, physicalSinkId);
    const muted = activeMute(eqState, physicalState, sourceDefaultId ?? currentDefaultId, eqNodeId, physicalSinkId);

    const target = volumesForTarget(effective, "eq");
    await this.fadeActivePath(eqNodeId, physicalSinkId, currentDefaultId, eqState.volume, physicalState.volume);

    try {
      // The fade protects the normal path. Muting both routes after it reaches
      // zero also protects the handoff from PipeWire's asynchronous default
      // sink/stream relink, which can otherwise briefly expose stale volume.
      await Promise.all([
        this.setMute(eqNodeId, true),
        this.setMute(physicalSinkId, true),
      ]);

      // Keep the EQ silent until it is the default. The physical sink is only
      // raised to unity while muted and after it is no longer the audible
      // default, so changing to the EQ cannot expose a sudden 100% level.
      await this.setVolume(eqNodeId, 0);
      await this.setDefaultAudioSink(eqNodeId);
      await this.setVolume(physicalSinkId, target.physicalVolume);
      if (muted) await this.setVolume(eqNodeId, target.eqVolume);
      else await this.fadeVolume(eqNodeId, 0, target.eqVolume);
      await this.setMute(physicalSinkId, false);
      await this.setMute(eqNodeId, muted);
    } catch (cause) {
      await this.restoreVolumeTransition(eqNodeId, physicalSinkId, currentDefaultId, eqState, physicalState);
      throw cause;
    }
    return physicalSinkId;
  }

  async switchDefaultToPhysical(eqNodeId: number, outputNodeName = "effect_output.pipeq-default", sourceDefaultId?: number): Promise<number> {
    const physicalSinkId = await this.physicalSinkForEq(outputNodeName);
    const [eqState, physicalState, currentDefaultId] = await Promise.all([
      this.getVolumeState(eqNodeId),
      this.getVolumeState(physicalSinkId),
      this.getDefaultAudioSinkId().catch(() => undefined),
    ]);
    const effective = effectiveVolumeForDefault(eqState, physicalState, sourceDefaultId ?? currentDefaultId, eqNodeId, physicalSinkId);
    const muted = activeMute(eqState, physicalState, sourceDefaultId ?? currentDefaultId, eqNodeId, physicalSinkId);

    const target = volumesForTarget(effective, "physical");
    await this.fadeActivePath(eqNodeId, physicalSinkId, currentDefaultId, eqState.volume, physicalState.volume);

    try {
      // Keep both routes muted while the physical sink is prepared. This
      // makes the reverse handoff symmetrical and prevents the old 100% sink
      // value from becoming audible during stream relinking.
      await Promise.all([
        this.setMute(eqNodeId, true),
        this.setMute(physicalSinkId, true),
      ]);
      await this.setVolume(physicalSinkId, 0);
      await this.setDefaultAudioSink(physicalSinkId);
      await this.setVolume(eqNodeId, target.eqVolume);
      if (muted) await this.setVolume(physicalSinkId, target.physicalVolume);
      else await this.fadeVolume(physicalSinkId, 0, target.physicalVolume);
      await this.setMute(eqNodeId, false);
      await this.setMute(physicalSinkId, muted);
    } catch (cause) {
      await this.restoreVolumeTransition(eqNodeId, physicalSinkId, currentDefaultId, eqState, physicalState);
      throw cause;
    }
    return physicalSinkId;
  }

  watchDefaultAudioSink(onChange: () => void): () => void {
    const monitor = spawn("pw-dump", ["--monitor", "--no-colors", "--raw"], { stdio: ["ignore", "pipe", "ignore"] });
    const lines = createInterface({ input: monitor.stdout });
    let previousName: string | undefined;
    const handleLine = (line: string) => {
      try {
        const nextName = defaultAudioSinkNameFromDump(JSON.parse(line) as unknown);
        if (!nextName) return;
        if (previousName !== undefined && nextName !== previousName) onChange();
        previousName = nextName;
      } catch {
        // pw-dump can be interrupted while writing a monitor frame; ignore that frame.
      }
    };
    lines.on("line", handleLine);
    const stop = () => {
      lines.close();
      if (!monitor.killed) monitor.kill("SIGTERM");
    };
    monitor.once("error", stop);
    monitor.once("exit", () => lines.close());
    return stop;
  }

  async installDefaultEq(): Promise<PipeWireNodeSummary | undefined> {
    const userHome = homedir();
    const configHome = process.env.XDG_CONFIG_HOME || join(userHome, ".config");
    const configDirectory = join(configHome, "pipewire", "pipewire.conf.d");
    const configPath = join(configDirectory, DEFAULT_EQ_CONFIG_PATH);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, buildDefaultEqConfig(), "utf8");
    await execFileAsync("systemctl", ["--user", "restart", "pipewire"]);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const nodes = await this.findEqNodes();
      const node = nodes.find((candidate) => candidate.name === DEFAULT_EQ_NODE_NAME);
      if (node) {
        await this.switchDefaultToEq(node.id);
        return nodeSummary(node);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return undefined;
  }

  async setNodeControls(node: PipeWireNode, bands: EqBand[], bassBoost?: number, preamp = 0): Promise<void> {
    const params = bands.flatMap((band) => [
      portName(band, "Freq"),
      band.freq,
      portName(band, "Gain"),
      band.enabled === false ? 0 : band.gain,
      portName(band, "Q"),
      band.q,
    ]);
    if (Object.hasOwn(node.params, PREAMP_PORT)) {
      const boundedPreamp = Math.min(PREAMP_MAX, Math.max(PREAMP_MIN, preamp));
      params.push(PREAMP_PORT, preampMultiplierForDb(boundedPreamp));
      if (Object.hasOwn(node.params, PREAMP_ADD_PORT)) params.push(PREAMP_ADD_PORT, 0);
    }
    if (bassBoost !== undefined && Object.hasOwn(node.params, BASS_BOOST_PORT) && Object.hasOwn(node.params, BASS_TRIM_PORT)) {
      const boundedBoost = Math.min(BASS_BOOST_MAX, Math.max(BASS_BOOST_MIN, bassBoost));
      const trim = headroomTrimForBands(bands, boundedBoost, preamp);
      const legacyPreampTrim = Object.hasOwn(node.params, PREAMP_PORT) ? 1 : preampMultiplierForDb(Math.min(0, preamp));
      params.push(BASS_BOOST_PORT, boundedBoost, BASS_TRIM_PORT, trim * legacyPreampTrim);
      if (Object.hasOwn(node.params, BASS_FREQUENCY_PORT)) params.push(BASS_FREQUENCY_PORT, BASS_BOOST_FREQUENCY);
      if (Object.hasOwn(node.params, BASS_Q_PORT)) params.push(BASS_Q_PORT, BASS_BOOST_Q);
    }
    await execFileAsync("pw-cli", ["set-param", String(node.id), "Props", JSON.stringify({ params })]);
  }
}

export function nodeSummary(node: PipeWireNode): PipeWireNodeSummary {
  return { id: node.id, name: node.name, description: node.description };
}

export function findRequestedNode(nodes: PipeWireNode[], requested?: string): PipeWireNode | undefined {
  if (requested) {
    const id = Number(requested);
    if (Number.isInteger(id)) return nodes.find((node) => node.id === id);
    const normalized = requested.toLowerCase();
    return nodes.find((node) => node.name.toLowerCase() === normalized || node.description.toLowerCase() === normalized);
  }

  return nodes[0];
}
