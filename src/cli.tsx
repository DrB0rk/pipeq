#!/usr/bin/env node
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, measureElement, render, Spacer, Text, useApp, useInput, useStdin, useStdout } from "ink";
import type { DOMElement, ElementMetrics } from "ink";

import { BASS_BOOST_FREQUENCY, BASS_BOOST_MAX, BASS_BOOST_MIN, BASS_BOOST_STEP, GAIN_STEP, MAX_GAIN, PREAMP_MAX, PREAMP_MIN, PREAMP_PORT, PREAMP_STEP, bassBoostFromParams, buildBands, formatFrequency, formatValue, hasBassBoost, hasPreamp, portName, preampFromParams, preserveBandIndex, stepBand, updateBand } from "./eq.js";
import { SgrMouseParser, type TerminalMouseEvent } from "./mouse.js";
import { loadPresets, savePresets, upsertPreset } from "./presets.js";
import { DEFAULT_EQ_DESCRIPTION, PipeWireClient } from "./pipewire.js";
import type { EqBand, EqParameter, EqPreset, PipeWireNode } from "./types.js";

const PANEL = "#24221F";
const AMBER = "#F3B562";
const PAPER = "#E8E7E4";
const MUTED = "#9B968D";
const DIM = "#625E58";
const RED = "#E07A5F";
const GREEN = "#8FBF9F";
const MIN_TUI_HEIGHT = 18;
const MAX_TUI_HEIGHT = 46;
const HEADER_HEIGHT = 3;
const FOOTER_HEIGHT = 3;

type CliOptions = {
  requestedNode?: string;
};

type View = "editor" | "new-eq" | "save-preset" | "help";
type ControlFocus = "bands" | "bass" | "preamp";

type NodeControlWrite = {
  node: PipeWireNode;
  bands: EqBand[];
  bassBoost: number;
  preamp: number;
};

function useTerminalMouse(enabled: boolean, onEvent: (event: TerminalMouseEvent) => void): void {
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const parserRef = useRef(new SgrMouseParser());

  useEffect(() => {
    if (!enabled || !isRawModeSupported) return;

    const parser = parserRef.current;
    const handleData = (chunk: Buffer | string) => {
      for (const event of parser.feed(chunk.toString())) handlerRef.current(event);
    };

    stdout.write("\u001B[?1000h\u001B[?1002h\u001B[?1006h");
    stdin.on("data", handleData);
    return () => {
      stdin.off("data", handleData);
      stdout.write("\u001B[?1006l\u001B[?1002l\u001B[?1000l");
    };
  }, [enabled, isRawModeSupported, stdin, stdout]);
}

function parseOptions(argv: string[]): CliOptions {
  const nodeIndex = argv.indexOf("--node");
  const requestedNode = nodeIndex >= 0 ? argv[nodeIndex + 1] : undefined;
  return requestedNode ? { requestedNode } : {};
}

function Header({ width, node, isDefault, message }: { width: number; node: PipeWireNode | undefined; isDefault: boolean; message: string }): React.ReactElement {
  const innerWidth = Math.max(1, width - 4);
  const statusWidth = node ? 12 : 14;
  const messageWidth = Math.min(30, Math.max(10, Math.floor(innerWidth * 0.28)));
  const titleWidth = Math.max(1, innerWidth - statusWidth - messageWidth - 5);
  return (
    <Box width={width} height={HEADER_HEIGHT} paddingX={1} alignItems="center" borderStyle="round" borderColor={DIM}>
      <Box width={innerWidth} flexDirection="row" alignItems="center">
        <Box width={titleWidth} flexShrink={1}>
          <Text color={AMBER} bold>PIPEQ</Text>
          <Text color={DIM}>  /  REALTIME EQUALIZER</Text>
        </Box>
        <Spacer />
        <Box width={messageWidth}>
          <Text color={MUTED} wrap="truncate-end">{message}</Text>
        </Box>
        <Text color={DIM}> │ </Text>
        <Box width={statusWidth}>
          <Text color={node ? isDefault ? GREEN : AMBER : RED} bold wrap="truncate-end">{node ? isDefault ? "● IN PATH" : "○ NOT ROUTED" : "○ NO TARGET"}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function PresetRow({ preset, selected, dirty, width, onMetrics }: { preset: EqPreset; selected: boolean; dirty: boolean; width: number; onMetrics: (metrics: ElementMetrics) => void }): React.ReactElement {
  const ref = useRef<DOMElement | null>(null);
  useEffect(() => {
    if (ref.current) onMetrics(measureElement(ref.current));
  }, [onMetrics, width]);
  return (
    <Box ref={ref} width={width} paddingX={1}>
      <Text color={selected ? AMBER : MUTED} bold={selected}>{selected ? "› " : "  "}</Text>
      <Text color={selected ? PAPER : MUTED} wrap="truncate-end">{dirty && selected ? "* " : ""}{preset.name}</Text>
    </Box>
  );
}

function Sidebar({ width, height, nodes, selectedNodeId, presets, selectedPresetId, presetDirty, onPresetMetrics }: { width: number; height: number; nodes: PipeWireNode[]; selectedNodeId: number | undefined; presets: EqPreset[]; selectedPresetId: string | undefined; presetDirty: boolean; onPresetMetrics: (id: string, metrics: ElementMetrics) => void }): React.ReactElement {
  const visiblePresets = presets.slice(0, Math.max(1, height - 20));
  const visibleNodes = nodes.slice(0, Math.max(1, height - visiblePresets.length - 17));
  return (
    <Box width={width} height={height} minWidth={width} flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor={DIM}>
      <Text color={AMBER} bold>PRESETS</Text>
      {presets.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={MUTED}>No saved presets.</Text>
          <Text color={DIM}>Press n to create one</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {visiblePresets.map((preset) => (
            <PresetRow key={preset.id} preset={preset} selected={preset.id === selectedPresetId} dirty={presetDirty} width={Math.max(1, width - 4)} onMetrics={(metrics) => onPresetMetrics(preset.id, metrics)} />
          ))}
          {visiblePresets.length < presets.length && <Text color={DIM}>+{presets.length - visiblePresets.length} more · j/k</Text>}
        </Box>
      )}
      <Text color={DIM}>n new preset</Text>
      <Text color={DIM}>s save selected</Text>
      <Text color={DIM}>click / j k load</Text>
      <Box marginTop={1}>
        <Text color={DIM}>────────────────────</Text>
      </Box>
      <Text color={AMBER} bold>TARGETS</Text>
      <Text color={DIM}>────────────────────</Text>
      {nodes.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={MUTED}>No named EQ chains.</Text>
          <Text color={DIM}>Press n to create</Text>
          <Text color={DIM}>a default EQ.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {visibleNodes.map((candidate) => {
            const selected = candidate.id === selectedNodeId;
            return (
              <Box key={candidate.id} width={Math.max(1, width - 4)} paddingX={1}>
                <Text color={selected ? AMBER : MUTED} bold={selected}>{selected ? "› " : "  "}</Text>
                <Text color={selected ? PAPER : MUTED} wrap="truncate-end">{candidate.description}</Text>
              </Box>
            );
          })}
          {visibleNodes.length < nodes.length && <Text color={DIM}>+{nodes.length - visibleNodes.length} more · Tab</Text>}
        </Box>
      )}
      <Spacer />
      <Box flexDirection="column">
        <Text color={DIM}>NODE</Text>
        <Text color={MUTED}>{selectedNodeId ? String(selectedNodeId) : "none"}</Text>
        <Text color={DIM}>FILTER GRAPH</Text>
        <Text color={MUTED}>builtin biquads</Text>
      </Box>
    </Box>
  );
}

function GainBar({ gain, selected, height, layoutWidth, onMetrics }: { gain: number; selected: boolean; height: number; layoutWidth: number; onMetrics: ((metrics: ElementMetrics) => void) | undefined }): React.ReactElement {
  const ref = useRef<DOMElement | null>(null);
  const levelsPerRow = 8;
  const levels = Math.max(levelsPerRow, height * levelsPerRow);
  const zero = Math.floor(levels / 2);
  const visualRatio = Math.pow(Math.min(1, Math.abs(gain) / MAX_GAIN), 0.7);
  const distance = visualRatio * Math.max(0, zero - 1);
  const fillStart = gain > 0 ? zero - distance : zero;
  const fillEnd = gain > 0 ? zero : zero + distance;
  const partialGlyphs = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
  const cells = Array.from({ length: height }, (_, index) => {
    const rowStart = index * levelsPerRow;
    const rowEnd = rowStart + levelsPerRow;
    const isZero = zero >= rowStart && zero < rowEnd;
    const covered = gain === 0 ? 0 : Math.max(0, Math.min(rowEnd, fillEnd) - Math.max(rowStart, fillStart));
    const glyphIndex = Math.min(partialGlyphs.length - 1, Math.max(1, Math.round(covered)));
    const glyph = covered > 0 ? partialGlyphs[glyphIndex] ?? "█" : isZero ? "┼" : "·";
    return <Text key={index} color={isZero && covered === 0 ? DIM : selected ? AMBER : PAPER}>{glyph}</Text>;
  });
  useEffect(() => {
    if (ref.current && onMetrics) onMetrics(measureElement(ref.current));
  }, [height, layoutWidth, onMetrics]);
  return <Box ref={ref} flexDirection="column" alignItems="center" backgroundColor={PANEL}>{cells}</Box>;
}

function BandStrip({ bands, selectedBand, parameter, width, height, dense, onMetrics, onBarMetrics }: { bands: EqBand[]; selectedBand: number; parameter: EqParameter; width: number; height: number; dense: boolean; onMetrics: (metrics: ElementMetrics) => void; onBarMetrics: (metrics: ElementMetrics) => void }): React.ReactElement {
  const ref = useRef<DOMElement | null>(null);
  const contentWidth = Math.max(1, width - 4);
  const bandWidth = Math.max(1, Math.floor(contentWidth / Math.max(1, bands.length)));
  const showScaleInline = !dense && contentWidth >= 42;
  useEffect(() => {
    if (ref.current) onMetrics(measureElement(ref.current));
  }, [height, onMetrics, width]);
  return (
    <Box ref={ref} width={width} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={selectedBand >= 0 ? AMBER : DIM} paddingX={1} paddingY={dense ? 0 : 1}>
      <Box width={contentWidth} flexDirection={showScaleInline ? "row" : "column"}>
        <Text color={MUTED} bold={!dense} wrap="truncate-end">{dense ? "EQ BANDS" : "BAND RESPONSE"}</Text>
        {!dense && <Text color={DIM} wrap="truncate-end">  -12 dB  ·  0 dB  ·  +12 dB</Text>}
      </Box>
      <Box marginTop={dense ? 0 : 1} width={contentWidth} justifyContent="space-between" alignItems="flex-end">
        {bands.map((band, index) => (
          <Box key={band.name} width={bandWidth} minWidth={bandWidth} flexShrink={0} flexDirection="column" alignItems="center">
            <Box width={bandWidth}><Text color={index === selectedBand ? AMBER : MUTED} bold={index === selectedBand} wrap="truncate-end">{formatFrequency(band.freq).padStart(4, " ")}</Text></Box>
            <GainBar gain={band.gain} selected={index === selectedBand} height={height} layoutWidth={contentWidth} onMetrics={index === 0 ? onBarMetrics : undefined} />
            <Box width={bandWidth}><Text color={index === selectedBand ? AMBER : PAPER} bold={index === selectedBand} wrap="truncate-end">{band.gain >= 0 ? "+" : ""}{band.gain.toFixed(2)}</Text></Box>
            {!dense && <Box width={bandWidth}><Text color={parameter === "Q" && index === selectedBand ? AMBER : DIM} wrap="truncate-end">Q {band.q.toFixed(1)}</Text></Box>}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ControlSlider({ label, value, min, max, step, unit, available, focused, width, onMetrics }: { label: string; value: number; min: number; max: number; step: number; unit: string; available: boolean; focused: boolean; width: number; onMetrics: (metrics: ElementMetrics) => void }): React.ReactElement {
  const ref = useRef<DOMElement | null>(null);
  const segmentCount = Math.max(12, Math.min(34, width - 30));
  const normalized = Math.min(1, Math.max(0, (value - min) / Math.max(step, max - min)));
  const filled = Math.round(normalized * segmentCount);
  const zero = min < 0 ? Math.round((0 - min) / Math.max(step, max - min) * segmentCount) : undefined;
  useEffect(() => {
    if (ref.current) onMetrics(measureElement(ref.current));
  }, [onMetrics, width]);
  return (
    <Box ref={ref} width={width} height={3} flexShrink={0} paddingX={1} borderStyle="round" borderColor={focused ? AMBER : DIM}>
      <Box>
        <Text color={focused ? AMBER : PAPER} bold>{label}</Text>
        <Text color={DIM}>  {unit}  </Text>
        <Text color={DIM}>{min > 0 ? min.toFixed(1) : min} </Text>
        <Text backgroundColor={PANEL} color={available ? focused ? AMBER : PAPER : DIM}>{Array.from({ length: segmentCount }, (_, index) => index < filled ? "━" : index === zero ? "┼" : "·").join("")}</Text>
        <Text color={DIM}> {max >= 0 ? `+${max}` : max}  </Text>
        <Text color={available ? focused ? AMBER : PAPER : RED}>{available ? `${value >= 0 ? "+" : ""}${value.toFixed(2)} dB` : "not available in this graph"}</Text>
      </Box>
    </Box>
  );
}

function ParameterTabs({ parameter, isDefault, width, dense }: { parameter: EqParameter; isDefault: boolean; width: number; dense: boolean }): React.ReactElement {
  const status = isDefault ? "● PLAYBACK PASSES THROUGH THIS EQ" : "○ PLAYBACK BYPASSES THIS EQ · press a to route";
  return (
    <Box width={width} marginBottom={dense ? 0 : 1} flexDirection="column">
      <Box width={width} height={1}>
        <Text color={parameter === "Gain" ? AMBER : DIM} bold={parameter === "Gain"}>[G] GAIN</Text>
        <Text color={DIM}>   </Text>
        <Text color={parameter === "Freq" ? AMBER : DIM} bold={parameter === "Freq"}>[F] FREQ</Text>
        <Text color={DIM}>   </Text>
        <Text color={parameter === "Q" ? AMBER : DIM} bold={parameter === "Q"}>[X] Q</Text>
        {!dense && <><Text color={DIM}>   </Text><Text color={DIM}>[P] PREAMP</Text><Text color={DIM}>   </Text><Text color={DIM}>[B] BASS</Text></>}
      </Box>
      {!dense && <Box width={width} height={1} marginTop={1}><Text color={isDefault ? GREEN : AMBER} bold wrap="truncate-end">{status}</Text></Box>}
    </Box>
  );
}

function SelectedBand({ band, parameter, width }: { band: EqBand | undefined; parameter: EqParameter; width: number }): React.ReactElement {
  if (!band) return <Text color={MUTED}>Select an EQ target to begin.</Text>;
  const contentWidth = Math.max(1, width - 6);
  const compact = contentWidth < 52;
  const details = `${formatValue("Gain", band.gain)}  ·  ${formatValue("Freq", band.freq)}  ·  ${formatValue("Q", band.q)}`;
  return (
    <Box width={width} height={compact ? 4 : 3} borderStyle="round" borderColor={AMBER} paddingX={1} flexDirection="column">
      <Box width={contentWidth} height={1}>
        <Text color={AMBER} bold>{band.name.toUpperCase()}</Text>
        <Text color={DIM}>  /  </Text>
        <Text color={MUTED} wrap="truncate-end">{formatFrequency(band.freq)} Hz peaking</Text>
        {contentWidth >= 46 && <><Text color={DIM}>  ·  </Text><Text color={band.enabled === false ? RED : GREEN}>{band.enabled === false ? "BYPASS" : "ON"}</Text></>}
      </Box>
      {compact ? (
        <Box width={contentWidth} height={1}><Text color={parameter === "Gain" ? AMBER : PAPER} bold={parameter === "Gain"} wrap="truncate-end">{details}</Text></Box>
      ) : (
        <Box width={contentWidth} height={1}>
          <Text color={parameter === "Gain" ? AMBER : PAPER} bold={parameter === "Gain"}>G {formatValue("Gain", band.gain)}</Text>
          <Text color={DIM}>  ·  </Text>
          <Text color={parameter === "Freq" ? AMBER : PAPER} bold={parameter === "Freq"}>F {formatValue("Freq", band.freq)}</Text>
          <Text color={DIM}>  ·  </Text>
          <Text color={parameter === "Q" ? AMBER : PAPER} bold={parameter === "Q"}>{formatValue("Q", band.q)}</Text>
        </Box>
      )}
    </Box>
  );
}

function EmptyState({ error, loading, width, canCreateEq }: { error: string | undefined; loading: boolean; width: number; canCreateEq: boolean }): React.ReactElement {
  if (loading) {
    return (
      <Box width={Math.max(1, width - 4)} flexGrow={1} alignItems="center" justifyContent="center" borderStyle="round" borderColor={DIM}>
        <Text color={AMBER}>Scanning PipeWire targets...</Text>
      </Box>
    );
  }
  const targetError = error?.startsWith("No EQ filter matched");
  const title = targetError ? "TARGET NOT FOUND" : error ? "PIPEWIRE UNAVAILABLE" : "NO EQ TARGETS";
  return (
    <Box width={Math.max(1, width - 4)} flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" borderStyle="round" borderColor={error ? RED : DIM} paddingX={3}>
      <Text color={error ? RED : AMBER} bold>{title}</Text>
      <Box marginTop={1}><Text color={PAPER}>{error ?? "Create a default PipeWire EQ and make it the system output."}</Text></Box>
      {canCreateEq ? (
        <Box marginTop={2} flexDirection="column" alignItems="center">
          <Text color={AMBER}>n  create default EQ</Text>
          <Text color={MUTED}>Writes ~/.config/pipewire/pipewire.conf.d/pipeq-default.conf</Text>
          <Text color={MUTED}>and restarts the user PipeWire service.</Text>
        </Box>
      ) : (
        <Box marginTop={2} alignItems="center">
          <Text color={MUTED}>Select an EQ target with Tab or h/l.</Text>
        </Box>
      )}
    </Box>
  );
}

function NewEqDialog({ width, busy, onCancel, onConfirm }: { width: number; busy: boolean; onCancel: () => void; onConfirm: () => void }): React.ReactElement {
  return (
    <Box width={width} height="100%" alignItems="center" justifyContent="center">
      <Box width={Math.min(72, Math.max(44, width - 8))} borderStyle="round" borderColor={AMBER} paddingX={3} paddingY={2} flexDirection="column">
        <Text color={AMBER} bold>NEW DEFAULT EQ</Text>
        <Text color={DIM}>────────────────────────────────</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={PAPER}>Create a ten-band PipeWire equalizer.</Text>
          <Text color={PAPER}>It will become the default audio sink.</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={MUTED}>This writes:</Text>
          <Text color={AMBER}>  {DEFAULT_EQ_DESCRIPTION}</Text>
          <Text color={MUTED}>and restarts PipeWire to load it.</Text>
        </Box>
        {busy && <Box marginTop={2}><Text color={AMBER}>Applying configuration…</Text></Box>}
        {!busy && <Box marginTop={2}><Text color={AMBER}>Enter</Text><Text color={MUTED}> create   </Text><Text color={AMBER}>Esc</Text><Text color={MUTED}> cancel</Text></Box>}
      </Box>
    </Box>
  );
}

function SavePresetDialog({ width, name, busy }: { width: number; name: string; busy: boolean }): React.ReactElement {
  return (
    <Box width={width} height="100%" alignItems="center" justifyContent="center">
      <Box width={Math.min(72, Math.max(44, width - 8))} borderStyle="round" borderColor={AMBER} paddingX={3} paddingY={2} flexDirection="column">
        <Text color={AMBER} bold>NEW EQ PRESET</Text>
        <Text color={DIM}>────────────────────────────────</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={PAPER}>Create a preset from the current EQ settings.</Text>
          <Text color={MUTED}>An existing name will be updated.</Text>
        </Box>
        <Box marginTop={2} borderStyle="round" borderColor={AMBER} paddingX={1}>
          <Text color={PAPER}>{name || " "}</Text>
          <Text color={AMBER}>▌</Text>
        </Box>
        {busy ? <Box marginTop={2}><Text color={AMBER}>Saving preset…</Text></Box> : (
          <Box marginTop={2}>
            <Text color={AMBER}>Enter</Text><Text color={MUTED}> save   </Text>
            <Text color={AMBER}>Esc</Text><Text color={MUTED}> cancel</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function HelpView({ width, height }: { width: number; height: number }): React.ReactElement {
  const compact = width < 92 || height < 30;
  const panelWidth = Math.min(80, Math.max(30, width - 8));
  return (
    <Box width={width} height={height} alignItems="center" justifyContent="center">
      <Box width={panelWidth} borderStyle="round" borderColor={AMBER} paddingX={compact ? 1 : 3} paddingY={compact ? 1 : 2} flexDirection="column">
        <Text color={AMBER} bold>PIPEQ CONTROLS</Text>
        <Text color={DIM} wrap="truncate-end">────────────────────────────────────────────────</Text>
        {compact ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={PAPER} wrap="truncate-end">←→ / h l   select band / target</Text>
            <Text color={PAPER} wrap="truncate-end">↑↓         adjust active value</Text>
            <Text color={PAPER} wrap="truncate-end">mouse      drag inside a bar</Text>
            <Text color={PAPER} wrap="truncate-end">g f x      gain / frequency / Q</Text>
            <Text color={PAPER} wrap="truncate-end">p b , .    preamp / bass / step</Text>
            <Text color={PAPER} wrap="truncate-end">e r / R    bypass / reset selected / all</Text>
            <Text color={PAPER} wrap="truncate-end">a / d      route EQ / physical</Text>
            <Text color={PAPER} wrap="truncate-end">s           save selected preset</Text>
            <Text color={PAPER} wrap="truncate-end">n j k       new / switch preset</Text>
          </Box>
        ) : (
          <Box marginTop={1} flexDirection="column">
            <Text color={PAPER}>← →   select band                 ↑ ↓   adjust value</Text>
            <Text color={PAPER}>mouse drag a handle              set active parameter</Text>
            <Text color={PAPER}>g     gain                       f     frequency</Text>
            <Text color={PAPER}>x     Q                          r     reset selected gain</Text>
            <Text color={PAPER}>e     bypass selected band       R     reset all gains</Text>
            <Text color={PAPER}>p     focus preamp               , .   preamp ±0.1 dB</Text>
            <Text color={PAPER}>b     focus bass boost            [ ]   bass ±0.1 dB</Text>
            <Text color={PAPER}>tab   next EQ target              h/l   previous / next target</Text>
            <Text color={PAPER}>a     route selected EQ            d     return to physical device</Text>
            <Text color={PAPER}>n     new preset (or create EQ if none exists)</Text>
            <Text color={PAPER}>s     save selected preset            j/k   switch preset</Text>
            <Text color={PAPER}>c     rescan PipeWire              ?     close help</Text>
            <Text color={PAPER}>q     quit</Text>
          </Box>
        )}
        {!compact && <Box marginTop={2} flexDirection="column"><Text color={MUTED}>Drag a band handle vertically to change the active parameter.</Text><Text color={MUTED}>Bass Boost is a bounded {BASS_BOOST_FREQUENCY} Hz low shelf with output headroom trim.</Text></Box>}
        <Box marginTop={compact ? 1 : 2}><Text color={AMBER}>Press any key to return.</Text></Box>
      </Box>
    </Box>
  );
}

function Footer({ width, node, compact }: { width: number; node: PipeWireNode | undefined; compact: boolean }): React.ReactElement {
  const innerWidth = Math.max(1, width - 4);
  const nodeWidth = compact ? 0 : Math.min(28, Math.max(14, Math.floor(innerWidth * 0.24)));
  const hintWidth = Math.max(1, innerWidth - nodeWidth - (nodeWidth ? 2 : 0));
  const hint = compact
    ? "←→ band  ↑↓ adjust  r reset  a EQ  d out  ? help  q quit"
    : "drag bars  ←→ band  ↑↓ adjust  r reset  g/f/x  b  a EQ  d  ? help  q quit";
  return (
    <Box width={width} height={FOOTER_HEIGHT} paddingX={1} alignItems="center" borderStyle="round" borderColor={DIM}>
      <Box width={hintWidth}>
        <Text color={MUTED} wrap="truncate-end">{hint}</Text>
      </Box>
      {nodeWidth > 0 && <>
        <Text color={DIM}> │ </Text>
        <Box width={nodeWidth}><Text color={node ? GREEN : DIM} wrap="truncate-end">{node ? node.name : "waiting for PipeWire"}</Text></Box>
      </>}
    </Box>
  );
}

function App({ options }: { options: CliOptions }): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const client = useMemo(() => new PipeWireClient(), []);
  const [nodes, setNodes] = useState<PipeWireNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<number>();
  const selectedNodeIdRef = useRef<number | undefined>(undefined);
  const defaultNodeIdRef = useRef<number | undefined>(undefined);
  const volumeTransitionRef = useRef(false);
  const [bands, setBands] = useState<EqBand[]>([]);
  const bandsRef = useRef<EqBand[]>([]);
  const [selectedBand, setSelectedBand] = useState(0);
  const selectedBandRef = useRef(0);
  const hydratedNodeIdRef = useRef<number | undefined>(undefined);
  const [parameter, setParameter] = useState<EqParameter>("Gain");
  const [controlFocus, setControlFocus] = useState<ControlFocus>("bands");
  const [bassBoost, setBassBoost] = useState(BASS_BOOST_MIN);
  const bassBoostRef = useRef(BASS_BOOST_MIN);
  const [preamp, setPreamp] = useState(0);
  const preampRef = useRef(0);
  const [defaultNodeId, setDefaultNodeId] = useState<number>();
  const [presets, setPresets] = useState<EqPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>();
  const [presetDirty, setPresetDirty] = useState(false);
  const [presetMetrics, setPresetMetrics] = useState<Record<string, ElementMetrics>>({});
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [chartMetrics, setChartMetrics] = useState<ElementMetrics>();
  const [barMetrics, setBarMetrics] = useState<ElementMetrics>();
  const [bassMetrics, setBassMetrics] = useState<ElementMetrics>();
  const [preampMetrics, setPreampMetrics] = useState<ElementMetrics>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("ready");
  const [view, setView] = useState<View>("editor");
  const [creating, setCreating] = useState(false);
  const draggingRef = useRef<number | undefined>(undefined);
  const dragLastYRef = useRef<number | undefined>(undefined);
  const bassDraggingRef = useRef(false);
  const preampDraggingRef = useRef(false);
  const pendingWritesRef = useRef(new Map<number, NodeControlWrite>());
  const activeWritesRef = useRef(new Set<number>());

  const node = nodes.find((candidate) => candidate.id === selectedNodeId);

  const reconcileExternalDefault = useCallback(async (previousDefaultId: number, nextDefaultId: number, discovered: PipeWireNode[]) => {
    if (volumeTransitionRef.current || previousDefaultId === nextDefaultId) return;
    const previousEq = discovered.find((candidate) => candidate.id === previousDefaultId && buildBands(candidate.params).length > 0);
    const nextEq = discovered.find((candidate) => candidate.id === nextDefaultId && buildBands(candidate.params).length > 0);
    if (!previousEq && !nextEq) return;

    volumeTransitionRef.current = true;
    try {
      const bridgeEq = nextEq ?? previousEq;
      const physicalSinkId = bridgeEq ? await client.findPhysicalSinkForFilter("effect_output.pipeq-default") : undefined;
      if (physicalSinkId === undefined) return;
      if (nextEq && previousDefaultId !== physicalSinkId) return;
      if (previousEq && nextDefaultId !== physicalSinkId) return;
      if (nextEq) {
        await client.switchDefaultToEq(nextEq.id, "effect_output.pipeq-default", previousDefaultId);
        setMessage("EQ volume restored safely");
      } else if (previousEq) {
        await client.switchDefaultToPhysical(previousEq.id, "effect_output.pipeq-default", previousDefaultId);
        setMessage("physical volume restored safely");
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not reconcile the output volume.");
    } finally {
      volumeTransitionRef.current = false;
    }
  }, [client]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [discovered, defaultId] = await Promise.all([
        client.findEqNodes(),
        client.getDefaultAudioSinkId().catch(() => undefined),
      ]);
      const previousDefaultId = defaultNodeIdRef.current;
      defaultNodeIdRef.current = defaultId;
      if (previousDefaultId !== undefined && defaultId !== undefined && previousDefaultId !== defaultId) {
        void reconcileExternalDefault(previousDefaultId, defaultId, discovered);
      }
      setNodes(discovered);
      setDefaultNodeId(defaultId);
      const requested = options.requestedNode ? discovered.find((candidate) => String(candidate.id) === options.requestedNode || candidate.name.toLowerCase() === options.requestedNode?.toLowerCase() || candidate.description.toLowerCase() === options.requestedNode?.toLowerCase()) : undefined;
      const next = requested ?? discovered.find((candidate) => candidate.id === selectedNodeIdRef.current) ?? discovered[0];
      selectedNodeIdRef.current = next?.id;
      setSelectedNodeId(next?.id);
      setError(next || !options.requestedNode ? undefined : `No EQ filter matched “${options.requestedNode}”.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read PipeWire.");
    } finally {
      setLoading(false);
    }
  }, [client, options.requestedNode, reconcileExternalDefault]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => client.watchDefaultAudioSink(() => void refresh()), [client, refresh]);

  useEffect(() => {
    let active = true;
    void loadPresets().then((stored) => {
      if (active) setPresets(stored);
    }).catch((cause) => {
      if (active) setMessage(cause instanceof Error ? cause.message : "Could not load EQ presets.");
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!node) {
      setBands([]);
      return;
    }
    const discoveredBands = buildBands(node.params);
    const enabledByName = new Map(bandsRef.current.map((band) => [band.name, band.enabled !== false]));
    const nodeChanged = hydratedNodeIdRef.current !== node.id;
    const nextBands = discoveredBands.map((band) => ({
      ...band,
      enabled: nodeChanged ? true : enabledByName.get(band.name) ?? band.enabled ?? true,
    }));
    const previousBand = bandsRef.current[selectedBandRef.current];
    bandsRef.current = nextBands;
    setBands(nextBands);
    const nextBassBoost = bassBoostFromParams(node.params);
    bassBoostRef.current = nextBassBoost;
    setBassBoost(nextBassBoost);
    const nextPreamp = hasPreamp(node.params) && !nodeChanged && !Object.hasOwn(node.params, PREAMP_PORT) ? preampRef.current : preampFromParams(node.params);
    preampRef.current = nextPreamp;
    setPreamp(nextPreamp);
    const nextSelectedBand = preserveBandIndex(nextBands, selectedBandRef.current, previousBand?.name, nodeChanged);
    hydratedNodeIdRef.current = node.id;
    selectedBandRef.current = nextSelectedBand;
    setSelectedBand(nextSelectedBand);
    if (nodeChanged && (hasBassBoost(node.params) || hasPreamp(node.params))) {
      void client.setNodeControls(node, nextBands, nextBassBoost, nextPreamp).catch((cause) => {
        setMessage(cause instanceof Error ? cause.message : "Could not synchronize EQ headroom.");
      });
    }
  }, [client, node?.id, node?.params]);

  const chooseNode = useCallback((id: number) => {
    selectedNodeIdRef.current = id;
    setSelectedNodeId(id);
    setMessage("target selected");
  }, []);

  const chooseBand = useCallback((index: number) => {
    selectedBandRef.current = index;
    setSelectedBand(index);
  }, []);

  const chooseNextNode = useCallback((direction: 1 | -1) => {
    if (!nodes.length) return;
    const currentIndex = Math.max(0, nodes.findIndex((candidate) => candidate.id === selectedNodeId));
    const nextIndex = (currentIndex + direction + nodes.length) % nodes.length;
    chooseNode(nodes[nextIndex]!.id);
  }, [chooseNode, nodes, selectedNodeId]);

  const queueControls = useCallback((control: NodeControlWrite) => {
    const key = control.node.id;
    pendingWritesRef.current.set(key, control);
    if (activeWritesRef.current.has(key)) return;

    activeWritesRef.current.add(key);
    void (async () => {
      while (pendingWritesRef.current.has(key)) {
        const next = pendingWritesRef.current.get(key);
        pendingWritesRef.current.delete(key);
        if (!next) continue;
        try {
          await client.setNodeControls(next.node, next.bands, next.bassBoost, next.preamp);
        } catch (cause) {
          setMessage(cause instanceof Error ? cause.message : "PipeWire rejected the update.");
        }
      }
      activeWritesRef.current.delete(key);
    })();
  }, [client]);

  const applyBand = useCallback((bandIndex: number, nextBand: EqBand) => {
    if (!node) return;
    const current = bandsRef.current[bandIndex];
    if (!current) return;
    const nextBands = bandsRef.current.map((band, index) => index === bandIndex ? nextBand : band);
    bandsRef.current = nextBands;
    setBands(nextBands);
    setPresetDirty(true);
    queueControls({ node, bands: nextBands, bassBoost: bassBoostRef.current, preamp: preampRef.current });
    setMessage(`${portName(nextBand, parameter)} updating with headroom protection`);
  }, [node, parameter, queueControls]);

  const applyBassBoost = useCallback((value: number) => {
    if (!node || !hasBassBoost(node.params)) return;
    const nextValue = Math.min(BASS_BOOST_MAX, Math.max(BASS_BOOST_MIN, Math.round(value / BASS_BOOST_STEP) * BASS_BOOST_STEP));
    bassBoostRef.current = nextValue;
    setBassBoost(nextValue);
    setPresetDirty(true);
    queueControls({ node, bands: bandsRef.current, bassBoost: nextValue, preamp: preampRef.current });
    setMessage(`bass boost +${nextValue.toFixed(2)} dB updating`);
  }, [node, queueControls]);

  const applyPreamp = useCallback((value: number) => {
    if (!node || !hasPreamp(node.params)) return;
    const nextValue = Math.min(PREAMP_MAX, Math.max(PREAMP_MIN, Math.round(value / PREAMP_STEP) * PREAMP_STEP));
    preampRef.current = nextValue;
    setPreamp(nextValue);
    setPresetDirty(true);
    queueControls({ node, bands: bandsRef.current, bassBoost: bassBoostRef.current, preamp: nextValue });
    setMessage(`preamp ${nextValue >= 0 ? "+" : ""}${nextValue.toFixed(2)} dB updating`);
  }, [node, queueControls]);

  const applyPreset = useCallback((preset: EqPreset) => {
    if (!node || !bandsRef.current.length) return;
    const storedBands = new Map(preset.bands.map((band) => [band.name, band]));
    const nextBands = bandsRef.current.map((band) => storedBands.get(band.name) ?? band);
    const nextBassBoost = hasBassBoost(node.params) ? preset.bassBoost : bassBoostRef.current;
    const nextPreamp = hasPreamp(node.params) ? preset.preamp ?? 0 : preampRef.current;
    bandsRef.current = nextBands;
    setBands(nextBands);
    bassBoostRef.current = nextBassBoost;
    setBassBoost(nextBassBoost);
    preampRef.current = nextPreamp;
    setPreamp(nextPreamp);
    setSelectedPresetId(preset.id);
    setPresetDirty(false);
    queueControls({ node, bands: nextBands, bassBoost: nextBassBoost, preamp: nextPreamp });
    setMessage(`${preset.name} loaded`);
  }, [node, queueControls]);

  const toggleBand = useCallback((bandIndex: number) => {
    if (!node) return;
    const current = bandsRef.current[bandIndex];
    if (!current) return;
    const enabled = current.enabled === false;
    const nextBand = { ...current, enabled };
    const nextBands = bandsRef.current.map((band, index) => index === bandIndex ? nextBand : band);
    bandsRef.current = nextBands;
    setBands(nextBands);
    setPresetDirty(true);
    queueControls({ node, bands: nextBands, bassBoost: bassBoostRef.current, preamp: preampRef.current });
    setMessage(`${current.name} ${enabled ? "enabled" : "bypassed"}`);
  }, [node, queueControls]);

  const selectPreset = useCallback((presetId: string) => {
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (preset) applyPreset(preset);
  }, [applyPreset, presets]);

  const beginSavePreset = useCallback(() => {
    if (!node || !bandsRef.current.length) return;
    setPresetName(`Preset ${presets.length + 1}`);
    setView("save-preset");
  }, [node, presets.length]);

  const saveNewPreset = useCallback(async () => {
    if (savingPreset || !node || !bandsRef.current.length) return;
    const name = presetName.trim() || `Preset ${presets.length + 1}`;
    const next: EqPreset = {
      id: `preset-${Date.now()}`,
      name,
      bands: bandsRef.current.map((band) => ({ ...band })),
      bassBoost: bassBoostRef.current,
      preamp: preampRef.current,
    };
    setSavingPreset(true);
    try {
      const merged = upsertPreset(presets, next);
      await savePresets(merged);
      const saved = merged.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
      setPresets(merged);
      setSelectedPresetId(saved?.id);
      setPresetDirty(false);
      setView("editor");
      setMessage(`${name} saved`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not save the EQ preset.");
    } finally {
      setSavingPreset(false);
    }
  }, [node, presetName, presets, savingPreset]);

  const saveSelectedPreset = useCallback(async () => {
    if (savingPreset || !node || !bandsRef.current.length) return;
    const selected = presets.find((preset) => preset.id === selectedPresetId);
    if (!selected) {
      setMessage("No preset selected; press n to create a new preset");
      return;
    }

    const next: EqPreset = {
      ...selected,
      bands: bandsRef.current.map((band) => ({ ...band })),
      bassBoost: bassBoostRef.current,
      preamp: preampRef.current,
    };
    setSavingPreset(true);
    try {
      const merged = upsertPreset(presets, next);
      await savePresets(merged);
      setPresets(merged);
      setSelectedPresetId(selected.id);
      setPresetDirty(false);
      setMessage(`${selected.name} saved`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not save the selected EQ preset.");
    } finally {
      setSavingPreset(false);
    }
  }, [node, presets, savingPreset, selectedPresetId]);

  const beginPresetAction = useCallback(() => {
    if (nodes.length === 0) {
      setView("new-eq");
      return;
    }
    beginSavePreset();
  }, [beginSavePreset, nodes.length]);

  const routeSelectedEq = useCallback(async () => {
    if (!node || volumeTransitionRef.current) return;
    setMessage("routing EQ and preserving volume");
    volumeTransitionRef.current = true;
    try {
      await client.switchDefaultToEq(node.id);
      defaultNodeIdRef.current = node.id;
      setDefaultNodeId(node.id);
      setMessage("EQ active; volume preserved");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not route the EQ.");
    } finally {
      volumeTransitionRef.current = false;
    }
  }, [client, node]);

  const routePhysicalSink = useCallback(async () => {
    if (!node || volumeTransitionRef.current) return;
    setMessage("returning volume to the physical device");
    volumeTransitionRef.current = true;
    try {
      const physicalSinkId = await client.switchDefaultToPhysical(node.id);
      defaultNodeIdRef.current = physicalSinkId;
      setDefaultNodeId(physicalSinkId);
      setMessage("physical device active; volume preserved");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not restore the physical device.");
    } finally {
      volumeTransitionRef.current = false;
    }
  }, [client, node]);

  const updateChartMetrics = useCallback((metrics: ElementMetrics) => {
    setChartMetrics((previous) => {
      if (previous && previous.x === metrics.x && previous.y === metrics.y && previous.width === metrics.width && previous.height === metrics.height) return previous;
      return metrics;
    });
  }, []);

  const updateBarMetrics = useCallback((metrics: ElementMetrics) => {
    setBarMetrics((previous) => {
      if (previous && previous.x === metrics.x && previous.y === metrics.y && previous.width === metrics.width && previous.height === metrics.height) return previous;
      return metrics;
    });
  }, []);

  const updatePresetMetrics = useCallback((id: string, metrics: ElementMetrics) => {
    setPresetMetrics((previous) => {
      const current = previous[id];
      if (current && current.x === metrics.x && current.y === metrics.y && current.width === metrics.width && current.height === metrics.height) return previous;
      return { ...previous, [id]: metrics };
    });
  }, []);

  const dragBand = useCallback((event: TerminalMouseEvent) => {
    if (!node || view !== "editor") return;

    if (event.action === "press" && event.button === 0) {
      const hit = Object.entries(presetMetrics).find(([, metrics]) => event.x >= metrics.x && event.x < metrics.x + metrics.width && event.y >= metrics.y && event.y < metrics.y + metrics.height);
      if (hit) {
        selectPreset(hit[0]);
        return;
      }
    }

    if (event.action === "press" && (event.button === 64 || event.button === 65)) {
      const direction = event.button === 64 ? 1 : -1;
      if (preampMetrics && hasPreamp(node.params) && event.x >= preampMetrics.x && event.x < preampMetrics.x + preampMetrics.width && event.y >= preampMetrics.y && event.y < preampMetrics.y + preampMetrics.height) {
        setControlFocus("preamp");
        applyPreamp(preampRef.current + direction * PREAMP_STEP);
        return;
      }
      if (bassMetrics && hasBassBoost(node.params) && event.x >= bassMetrics.x && event.x < bassMetrics.x + bassMetrics.width && event.y >= bassMetrics.y && event.y < bassMetrics.y + bassMetrics.height) {
        setControlFocus("bass");
        applyBassBoost(bassBoostRef.current + direction * BASS_BOOST_STEP);
        return;
      }
      if (chartMetrics && barMetrics && event.x >= chartMetrics.x + 2 && event.x < chartMetrics.x + chartMetrics.width - 2 && event.y >= barMetrics.y && event.y < barMetrics.y + barMetrics.height) {
        const innerLeft = chartMetrics.x + 2;
        const innerWidth = Math.max(1, chartMetrics.width - 4);
        const bandIndex = Math.min(bandsRef.current.length - 1, Math.max(0, Math.floor((event.x - innerLeft) / innerWidth * bandsRef.current.length)));
        const current = bandsRef.current[bandIndex];
        if (current) {
          chooseBand(bandIndex);
          applyBand(bandIndex, stepBand(current, parameter, direction));
        }
      }
      return;
    }

    if (event.button !== 0) return;

    if (preampDraggingRef.current) {
      if (event.action === "release") {
        preampDraggingRef.current = false;
        return;
      }
      if (preampMetrics && hasPreamp(node.params)) {
        const left = preampMetrics.x + 2;
        const width = Math.max(1, preampMetrics.width - 4);
        const normalized = Math.min(1, Math.max(0, (event.x - left) / Math.max(1, width - 1)));
        applyPreamp(PREAMP_MIN + normalized * (PREAMP_MAX - PREAMP_MIN));
      }
      return;
    }

    if (preampMetrics && hasPreamp(node.params)) {
      const inside = event.x >= preampMetrics.x && event.x < preampMetrics.x + preampMetrics.width && event.y >= preampMetrics.y && event.y < preampMetrics.y + preampMetrics.height;
      if (inside) {
        setControlFocus("preamp");
        if (event.action === "press") {
          preampDraggingRef.current = true;
          const left = preampMetrics.x + 2;
          const width = Math.max(1, preampMetrics.width - 4);
          const normalized = Math.min(1, Math.max(0, (event.x - left) / Math.max(1, width - 1)));
          applyPreamp(PREAMP_MIN + normalized * (PREAMP_MAX - PREAMP_MIN));
        }
        return;
      }
    }

    if (bassDraggingRef.current) {
      if (event.action === "release") {
        bassDraggingRef.current = false;
        return;
      }
      if (bassMetrics && hasBassBoost(node.params)) {
        const left = bassMetrics.x + 2;
        const width = Math.max(1, bassMetrics.width - 4);
        const normalized = Math.min(1, Math.max(0, (event.x - left) / Math.max(1, width - 1)));
        applyBassBoost(normalized * BASS_BOOST_MAX);
      }
      return;
    }

    if (bassMetrics && hasBassBoost(node.params)) {
      const inside = event.x >= bassMetrics.x && event.x < bassMetrics.x + bassMetrics.width && event.y >= bassMetrics.y && event.y < bassMetrics.y + bassMetrics.height;
      if (inside) {
        setControlFocus("bass");
        if (event.action === "press") {
          bassDraggingRef.current = true;
          const left = bassMetrics.x + 2;
          const width = Math.max(1, bassMetrics.width - 4);
          const normalized = Math.min(1, Math.max(0, (event.x - left) / Math.max(1, width - 1)));
          applyBassBoost(normalized * BASS_BOOST_MAX);
        }
        return;
      }
    }

    if (!chartMetrics || !barMetrics || !bandsRef.current.length) {
      if (event.action === "release") {
        draggingRef.current = undefined;
        dragLastYRef.current = undefined;
      }
      return;
    }

    const innerLeft = chartMetrics.x + 2;
    const innerWidth = Math.max(1, chartMetrics.width - 4);
    const insideBar = event.x >= innerLeft && event.x < innerLeft + innerWidth && event.y >= barMetrics.y && event.y < barMetrics.y + barMetrics.height;
    if (!insideBar) {
      if (event.action === "release") {
        draggingRef.current = undefined;
        dragLastYRef.current = undefined;
      }
      return;
    }
    const relativeX = event.x - innerLeft;

    const bandIndex = Math.min(bandsRef.current.length - 1, Math.max(0, Math.floor(relativeX / innerWidth * bandsRef.current.length)));
    if (event.action === "press") {
      chooseBand(bandIndex);
      draggingRef.current = bandIndex;
      dragLastYRef.current = event.y;
      return;
    }
    if (event.action === "release") {
      draggingRef.current = undefined;
      dragLastYRef.current = undefined;
      return;
    }

    const activeBand = draggingRef.current;
    if (activeBand === undefined) return;
    const current = bandsRef.current[activeBand];
    if (!current) return;
    if (parameter === "Gain") {
      const previousY = dragLastYRef.current ?? event.y;
      const deltaY = event.y - previousY;
      if (deltaY === 0) return;
      dragLastYRef.current = event.y;
      const nextValue = Math.round((current.gain - deltaY * GAIN_STEP) / GAIN_STEP) * GAIN_STEP;
      applyBand(activeBand, updateBand(current, parameter, nextValue));
      return;
    }
    const relativeY = Math.min(barMetrics.height - 1, Math.max(0, event.y - barMetrics.y));
    const normalized = 1 - relativeY / Math.max(1, barMetrics.height - 1);
    const nextValue = parameter === "Q" ? 10 - normalized * 9.9 : 20 * Math.pow(1000, normalized);
    applyBand(activeBand, updateBand(current, parameter, nextValue));
  }, [applyBand, applyBassBoost, applyPreamp, barMetrics, bassMetrics, chartMetrics, chooseBand, node, parameter, preampMetrics, presetMetrics, selectPreset, view]);

  useTerminalMouse(view === "editor", dragBand);

  const createDefaultEq = useCallback(async () => {
    if (creating) return;
    if (nodes.length > 0) {
      setView("editor");
      setMessage("An EQ already exists; press n to create a new preset");
      return;
    }
    setCreating(true);
    setMessage("installing default EQ");
    try {
      const created = await client.installDefaultEq();
      if (!created) throw new Error("PipeWire restarted, but the new EQ target did not appear.");
      setView("editor");
      setMessage("default EQ active");
      await refresh();
      setSelectedNodeId(created.id);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not create the default EQ.");
    } finally {
      setCreating(false);
    }
  }, [client, creating, nodes.length, refresh]);

  useInput((input, key) => {
    if (view === "save-preset") {
      if (key.escape) {
        setView("editor");
        return;
      }
      if (key.return) {
        void saveNewPreset();
        return;
      }
      if (key.backspace || key.delete) {
        setPresetName((current) => current.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setPresetName((current) => `${current}${input}`.slice(0, 48));
      }
      return;
    }
    if (view === "new-eq") {
      if (key.escape) setView("editor");
      if (key.return && !creating) void createDefaultEq();
      return;
    }
    if (view === "help") {
      setView("editor");
      return;
    }
    if (key.escape || input === "q") {
      exit();
      return;
    }
    if (input === "?") {
      setView("help");
      return;
    }
    if (input === "n") {
      beginPresetAction();
      return;
    }
    if (input === "s") {
      void saveSelectedPreset();
      return;
    }
    if (input === "a") {
      void routeSelectedEq();
      return;
    }
    if (input === "d") {
      void routePhysicalSink();
      return;
    }
    if (input === "b") {
      setControlFocus("bass");
      return;
    }
    if (input === "p") {
      setControlFocus("preamp");
      return;
    }
    if (input === "[" || input === "]") {
      applyBassBoost(bassBoostRef.current + (input === "]" ? BASS_BOOST_STEP : -BASS_BOOST_STEP));
      return;
    }
    if (input === "," || input === ".") {
      applyPreamp(preampRef.current + (input === "." ? PREAMP_STEP : -PREAMP_STEP));
      return;
    }
    if (input === "c") {
      setMessage("scanning PipeWire");
      void refresh();
      return;
    }
    if (key.tab) {
      chooseNextNode(1);
      return;
    }
    if (input === "g" || input === "f" || input === "x") {
      setControlFocus("bands");
      setParameter(input === "g" ? "Gain" : input === "f" ? "Freq" : "Q");
      return;
    }
    if (input === "h" || key.leftArrow) {
      if (input === "h") chooseNextNode(-1);
      else chooseBand((selectedBandRef.current - 1 + bands.length) % Math.max(1, bands.length));
      return;
    }
    if (input === "l" || key.rightArrow) {
      if (input === "l") chooseNextNode(1);
      else chooseBand((selectedBandRef.current + 1) % Math.max(1, bands.length));
      return;
    }
    if ((input === "j" || input === "k") && presets.length) {
      const currentIndex = Math.max(0, presets.findIndex((preset) => preset.id === selectedPresetId));
      const direction = input === "j" ? 1 : -1;
      const nextIndex = (currentIndex + direction + presets.length) % presets.length;
      selectPreset(presets[nextIndex]!.id);
      return;
    }
    if (!bands.length) return;
    if (key.upArrow || key.downArrow) {
      if (controlFocus === "bass") {
        applyBassBoost(bassBoostRef.current + (key.upArrow ? BASS_BOOST_STEP : -BASS_BOOST_STEP));
        return;
      }
      if (controlFocus === "preamp") {
        applyPreamp(preampRef.current + (key.upArrow ? PREAMP_STEP : -PREAMP_STEP));
        return;
      }
      const current = bands[selectedBand];
      if (current) applyBand(selectedBand, stepBand(current, parameter, key.upArrow ? 1 : -1));
      return;
    }
    if (input === "r") {
      const selectedIndex = selectedBandRef.current;
      const current = bandsRef.current[selectedIndex];
      if (current) {
        applyBand(selectedIndex, updateBand(current, "Gain", 0));
        setMessage(`${current.name}:Gain reset to 0.00 dB`);
      }
      return;
    }
    if (input === "e") {
      toggleBand(selectedBandRef.current);
      return;
    }
    if (input === "R" && node) {
      const reset = bands.map((band) => updateBand(band, "Gain", 0));
      bandsRef.current = reset;
      setBands(reset);
      queueControls({ node, bands: reset, bassBoost: bassBoostRef.current, preamp: preampRef.current });
      setMessage("all gains updating");
    }
  });

  const width = Math.max(1, stdout.columns ?? 100);
  const terminalRows = Math.max(1, stdout.rows ?? 30);
  const height = Math.min(MAX_TUI_HEIGHT, Math.max(MIN_TUI_HEIGHT, terminalRows));
  // The sidebar needs a tall frame to show presets, targets, and metadata
  // without stealing rows from the editor. On shorter terminals the editor
  // gets the full width instead of allowing either column to overflow.
  const compact = width < 96 || height < 40;
  const dense = height < 30;
  const showNodeTitle = !dense;
  const showDetails = height >= 34;
  const editorPaddingY = height < 22 ? 0 : 1;
  const mainHeight = Math.max(1, height - HEADER_HEIGHT - FOOTER_HEIGHT);
  const sidebarWidth = compact ? 0 : width >= 112 ? 28 : 24;
  const editorWidth = Math.max(1, width - sidebarWidth);
  const contentWidth = Math.max(1, editorWidth - 4);
  const detailsHeight = showDetails ? (contentWidth - 6 < 52 ? 5 : 4) : 0;
  const fixedEditorHeight = editorPaddingY * 2 + (showNodeTitle ? 2 : 0) + (dense ? 1 : 3) + 6 + (dense ? 5 : 9) + detailsHeight;
  const chartReserve = height < 22 ? 2 : 0;
  const chartHeight = Math.max(dense ? 2 : 4, Math.min(dense ? 6 : 16, mainHeight - fixedEditorHeight - chartReserve));
  const compactFooter = compact || width < 100;

  if (view === "new-eq") return <NewEqDialog width={width} busy={creating} onCancel={() => setView("editor")} onConfirm={() => void createDefaultEq()} />;
  if (view === "save-preset") return <SavePresetDialog width={width} name={presetName} busy={savingPreset} />;
  if (view === "help") return <HelpView width={width} height={height} />;

  return (
    <Box width={width} height={terminalRows} flexDirection="column" justifyContent="flex-start">
      <Box width={width} height={height} flexDirection="column">
        <Header width={width} node={node} isDefault={node?.id === defaultNodeId} message={message} />
        <Box width={width} height={mainHeight} flexShrink={0} flexDirection="row">
          {!compact && <Sidebar width={sidebarWidth} height={mainHeight} nodes={nodes} selectedNodeId={selectedNodeId} presets={presets} selectedPresetId={selectedPresetId} presetDirty={presetDirty} onPresetMetrics={updatePresetMetrics} />}
          <Box width={editorWidth} height={mainHeight} flexDirection="column" paddingX={2} paddingY={editorPaddingY}>
            {bands.length && node ? (
              <>
                {showNodeTitle && <Box height={1} marginBottom={1} width={contentWidth}>
                  <Text color={PAPER} bold wrap="truncate-end">{node.description}</Text>
                  <Text color={DIM}>  /  </Text>
                  <Text color={DIM} wrap="truncate-end">{node.name}</Text>
                </Box>}
                <ParameterTabs parameter={parameter} isDefault={node.id === defaultNodeId} width={contentWidth} dense={dense} />
                <ControlSlider label="PREAMP" value={preamp} min={PREAMP_MIN} max={PREAMP_MAX} step={PREAMP_STEP} unit="linear" available={hasPreamp(node.params)} focused={controlFocus === "preamp"} width={editorWidth - 4} onMetrics={setPreampMetrics} />
                <ControlSlider label="BASS BOOST" value={bassBoost} min={BASS_BOOST_MIN} max={BASS_BOOST_MAX} step={BASS_BOOST_STEP} unit={`${BASS_BOOST_FREQUENCY} Hz`} available={hasBassBoost(node.params)} focused={controlFocus === "bass"} width={editorWidth - 4} onMetrics={setBassMetrics} />
                <BandStrip bands={bands} selectedBand={selectedBand} parameter={parameter} width={editorWidth - 4} height={chartHeight} dense={dense} onMetrics={updateChartMetrics} onBarMetrics={updateBarMetrics} />
                {showDetails && (
                  <Box marginTop={1} height={detailsHeight} flexShrink={0}>
                    <SelectedBand band={bands[selectedBand]} parameter={parameter} width={editorWidth - 4} />
                  </Box>
                )}
              </>
            ) : <EmptyState error={error} loading={loading} width={editorWidth} canCreateEq={nodes.length === 0} />}
          </Box>
        </Box>
        <Footer width={width} node={node} compact={compactFooter} />
      </Box>
    </Box>
  );
}

const options = parseOptions(process.argv.slice(2));
render(<App options={options} />, { alternateScreen: true, incrementalRendering: true, maxFps: 30 });
