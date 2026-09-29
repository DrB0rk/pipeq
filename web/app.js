import { peakingResponseDb, responseAtFrequency } from "/eq-response.js";

const root = document.documentElement;
const token = root.dataset.token;
const $ = (id) => document.getElementById(id);
const svgNS = "http://www.w3.org/2000/svg";
const keys = {
  previousBand: "keyPreviousBand", nextBand: "keyNextBand", decrease: "keyDecrease", increase: "keyIncrease",
  toggleBypass: "keyToggleBypass", routeEq: "keyRouteEq", routePhysical: "keyRoutePhysical", savePreset: "keySavePreset", help: "keyHelp",
};
let current;
let selectedBandIndex = 0;
let dragging;
let writing = false;
let refreshing = false;
let refreshTask;
let connectionError = false;

function svgElement(name, attrs = {}, text) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function setMessage(message, isError = false) {
  $("message").textContent = message || "";
  $("message").classList.toggle("error", isError);
}

async function act(action, success = "Updated") {
  if (writing) return;
  const focused = document.activeElement;
  const focus = focused?.matches("[data-band-index]")
    ? { bandIndex: Number(focused.dataset.bandIndex) }
    : focused?.matches("[data-band-toggle]") ? { bandToggle: focused.dataset.bandToggle }
      : focused?.matches("[data-preset-id]") ? { presetId: focused.dataset.presetId }
    : focused?.id ? { id: focused.id } : undefined;
  writing = true;
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pipeq-token": token },
      body: JSON.stringify(action),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Action failed.");
    await refresh(true);
    setMessage(success);
    if (focus?.bandIndex !== undefined) document.querySelector(`[data-band-index="${focus.bandIndex}"]`)?.focus({ preventScroll: true });
    else if (focus?.bandToggle !== undefined) [...document.querySelectorAll("[data-band-toggle]")].find((item) => item.dataset.bandToggle === focus.bandToggle)?.focus({ preventScroll: true });
    else if (focus?.presetId !== undefined) [...document.querySelectorAll("[data-preset-id]")].find((item) => item.dataset.presetId === focus.presetId)?.focus({ preventScroll: true });
    else if (focus?.id) $(focus.id)?.focus({ preventScroll: true });
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not update PipeQ.", true);
  } finally {
    writing = false;
  }
}

function addOption(select, item, label, selected) {
  const option = document.createElement("option");
  option.value = String(item.id);
  option.textContent = label(item);
  option.selected = item.id === selected;
  select.append(option);
}

function themeFromSettings(settings) {
  const light = settings.ui.theme === "light" || (settings.ui.theme === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  root.dataset.theme = light ? "light" : "dark";
  root.style.setProperty("--accent", settings.ui.accent || root.dataset.accent || "#58cbd6");
}

function renderPresets(state) {
  const list = $("presetList");
  list.replaceChildren();
  $("presetCount").textContent = String(state.presets.length).padStart(2, "0");
  for (const preset of state.presets) {
    const active = preset.id === state.selectedPresetId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `preset-item${active ? " selected" : ""}`;
    button.dataset.presetId = preset.id;
    button.setAttribute("aria-pressed", String(active));
    button.title = active ? `${preset.name} · active preset` : `Load ${preset.name}`;
    const marker = document.createElement("span");
    marker.className = "preset-marker";
    const label = document.createElement("span");
    label.textContent = preset.name;
    button.append(marker, label);
    button.addEventListener("click", () => act({ type: "preset", id: preset.id }, `${preset.name} loaded`));
    list.append(button);
  }
  if (!state.presets.length) {
    const empty = document.createElement("div");
    empty.className = "subtitle";
    empty.textContent = "No saved presets yet.";
    list.append(empty);
  }
  $("activePreset").textContent = state.presets.find((item) => item.id === state.selectedPresetId)?.name || "No preset selected";
  $("dirtyTag").hidden = !state.presetDirty;
  $("savePreset").disabled = !state.selectedPresetId || !state.presetDirty;
  $("saveState").textContent = !state.selectedPresetId ? "No preset" : state.presetDirty ? "Unsaved" : "Saved";
}

function drawGrid(svg) {
  const { left, right, top, bottom, xFor, yFor } = graphGeometry();
  const yValues = [18, 12, 6, 0, -6, -12, -18];
  const freqValues = [20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (const value of yValues) {
    const y = yFor(value);
    svg.append(svgElement("line", { x1: left, x2: right, y1: y, y2: y, class: value === 0 ? "chart-grid zero" : "chart-grid" }));
    svg.append(svgElement("text", { x: left - 12, y: y + 3, "text-anchor": "end", class: "chart-label" }, `${value > 0 ? "+" : ""}${value} dB`));
  }
  for (const freq of freqValues) {
    const x = xFor(freq);
    svg.append(svgElement("line", { x1: x, x2: x, y1: top, y2: bottom, class: "chart-grid" }));
  }
  return { left, right, top, bottom, xFor, yFor };
}

function graphGeometry() {
  const left = 62;
  const right = 1188;
  const top = 18;
  const bottom = 396;
  const logMin = Math.log10(20);
  const logMax = Math.log10(20000);
  return {
    left, right, top, bottom,
    xFor: (freq) => left + (Math.log10(Math.min(20000, Math.max(20, freq))) - logMin) / (logMax - logMin) * (right - left),
    yFor: (gain) => top + (18 - Math.max(-18, Math.min(18, gain))) / 36 * (bottom - top),
  };
}

function curvePath(bands, geometry, onlyBand, state) {
  const points = [];
  const steps = 320;
  const minLog = Math.log10(20);
  const maxLog = Math.log10(20000);
  for (let i = 0; i <= steps; i += 1) {
    const frequency = 10 ** (minLog + i / steps * (maxLog - minLog));
    const gain = onlyBand ? peakingResponseDb(onlyBand, frequency) : responseAtFrequency(state, frequency);
    points.push(`${i === 0 ? "M" : "L"}${geometry.xFor(frequency).toFixed(2)},${geometry.yFor(gain).toFixed(2)}`);
  }
  return points.join(" ");
}

function drawGraph(state) {
  const svg = $("eqGraph");
  svg.replaceChildren();
  const geometry = drawGrid(svg);
  if (!state.bands.length) return;
  const selected = state.bands[selectedBandIndex];
  if (selected) {
    svg.append(svgElement("path", { d: curvePath(state.bands, geometry, selected, state), class: `band-curve${selected.enabled === false ? " disabled" : ""}` }));
  }
  svg.append(svgElement("path", { d: curvePath(state.bands, geometry, undefined, state), class: "total-curve" }));
  state.bands.forEach((band, index) => {
    const cx = geometry.xFor(band.freq);
    const cy = geometry.yFor(band.gain);
    const selectedBand = index === selectedBandIndex;
    const circle = svgElement("circle", {
      cx, cy, r: selectedBand ? 7 : 5,
      class: `band-handle${selectedBand ? " selected" : ""}${band.enabled === false ? " disabled" : ""}`,
      tabindex: "0", role: "slider", "data-band-index": index,
      "aria-label": `${band.name} gain`, "aria-valuetext": `${band.gain.toFixed(1)} decibels at ${Math.round(band.freq)} hertz`,
      "aria-valuemin": -12, "aria-valuemax": 12, "aria-valuenow": band.gain,
    });
    circle.addEventListener("focus", () => selectBand(index, false));
    circle.addEventListener("click", () => selectBand(index, false));
    circle.addEventListener("keydown", (event) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      selectBand(index, false);
      const value = event.key === "Home" ? -12 : event.key === "End" ? 12 : band.gain + (["ArrowUp", "ArrowRight"].includes(event.key) ? 0.1 : -0.1);
      sendBand(index, "gain", Math.max(-12, Math.min(12, value)));
    });
    circle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      selectBand(index, false);
      dragging = { index, pointerId: event.pointerId, initialFreq: band.freq, initialGain: band.gain };
      svg.setPointerCapture(event.pointerId);
      showTooltip(event.clientX, event.clientY, band);
    });
    svg.append(circle);
    if (selectedBand) svg.append(svgElement("text", { x: cx, y: cy - 13, class: "band-number" }, String(index + 1)));
  });
}

function showTooltip(x, y, band) {
  const tip = $("graphTooltip");
  const frame = $("graphWrap").getBoundingClientRect();
  tip.hidden = false;
  tip.textContent = `${Math.round(band.freq)} Hz · ${band.gain >= 0 ? "+" : ""}${band.gain.toFixed(1)} dB`;
  tip.style.left = `${Math.max(0, Math.min(frame.width - 150, x - frame.left + 12))}px`;
  tip.style.top = `${Math.max(0, y - frame.top - 22)}px`;
}

function selectBand(index, redraw = true) {
  if (!current?.bands.length) return;
  selectedBandIndex = (index + current.bands.length) % current.bands.length;
  if (redraw) drawGraph(current);
  else {
    const geometry = graphGeometry();
    const svg = $("eqGraph");
    svg.querySelectorAll(".band-handle").forEach((handle, bandIndex) => {
      handle.classList.toggle("selected", bandIndex === selectedBandIndex);
      handle.setAttribute("r", bandIndex === selectedBandIndex ? "7" : "5");
    });
    const selected = current.bands[selectedBandIndex];
    const selectedCurve = svg.querySelector(".band-curve");
    if (selectedCurve && selected) {
      selectedCurve.setAttribute("d", curvePath(current.bands, geometry, selected, current));
      selectedCurve.classList.toggle("disabled", selected.enabled === false);
    }
    const number = svg.querySelector(".band-number");
    if (number) number.remove();
    if (selected) svg.append(svgElement("text", { x: geometry.xFor(selected.freq), y: geometry.yFor(selected.gain) - 13, class: "band-number" }, String(selectedBandIndex + 1)));
    $("bandStrip").querySelectorAll(".band-chip").forEach((chip, bandIndex) => {
      chip.classList.toggle("selected", bandIndex === selectedBandIndex);
      chip.querySelector(".band-select")?.setAttribute("aria-pressed", String(bandIndex === selectedBandIndex));
    });
  }
  drawFilterControls(current);
}

function drawBandStrip(state) {
  const strip = $("bandStrip");
  strip.replaceChildren();
  $("bandCount").textContent = `${state.bands.length} bands`;
  state.bands.forEach((band, index) => {
    const chip = document.createElement("div");
    chip.className = `band-chip${index === selectedBandIndex ? " selected" : ""}`;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "band-select";
    select.setAttribute("aria-pressed", String(index === selectedBandIndex));
    select.setAttribute("aria-label", `Select EQ ${index + 1}, ${Math.round(band.freq)} hertz, ${band.gain.toFixed(1)} decibels, ${band.enabled === false ? "bypassed" : "enabled"}`);
    const name = document.createElement("strong");
    name.textContent = `EQ ${String(index + 1).padStart(2, "0")}`;
    const gain = document.createElement("small");
    gain.textContent = `${band.gain >= 0 ? "+" : ""}${band.gain.toFixed(1)} dB`;
    select.append(name, gain);
    select.addEventListener("click", () => selectBand(index, false));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "band-toggle";
    toggle.dataset.bandToggle = String(index);
    toggle.textContent = band.enabled === false ? "○" : "●";
    toggle.setAttribute("aria-pressed", String(band.enabled !== false));
    toggle.setAttribute("aria-label", `${band.enabled === false ? "Enable" : "Bypass"} EQ ${index + 1}`);
    toggle.title = band.enabled === false ? "Enable filter" : "Bypass filter";
    toggle.addEventListener("click", () => act({ type: "bandEnabled", name: band.name, enabled: band.enabled === false }, band.enabled === false ? "Filter enabled" : "Filter bypassed"));
    chip.append(select, toggle);
    strip.append(chip);
  });
}

function controlValue(parameter, value) {
  return parameter === "freq" ? 1000 * Math.log(Math.max(20, value) / 20) / Math.log(1000) : value;
}

function bandValue(parameter, value) {
  return parameter === "freq" ? Math.round(20 * 1000 ** (value / 1000)) : value;
}

function controlRow(band, label, parameter, min, max, step, display, className = "") {
  const wrap = document.createElement("div");
  wrap.className = `filter-control ${className}`;
  const title = document.createElement("label");
  const titleText = document.createElement("span");
  titleText.textContent = label;
  const value = document.createElement("output");
  value.textContent = display(band[parameter]);
  title.append(titleText, value);
  const input = document.createElement("input");
  input.type = "range";
  input.id = `control-${parameter}-${band.name}`;
  title.htmlFor = input.id;
  input.min = String(parameter === "freq" ? 0 : min);
  input.max = String(parameter === "freq" ? 1000 : max);
  input.step = String(parameter === "freq" ? 1 : step);
  input.value = String(controlValue(parameter, band[parameter]));
  input.setAttribute("aria-label", `${label} for ${band.name}`);
  if (parameter === "freq") {
    input.setAttribute("aria-valuemin", String(min));
    input.setAttribute("aria-valuemax", String(max));
    input.setAttribute("aria-valuenow", String(band.freq));
    input.setAttribute("aria-valuetext", `${Math.round(band.freq)} hertz`);
  }
  input.addEventListener("input", () => {
    const nextValue = bandValue(parameter, Number(input.value));
    value.textContent = display(nextValue);
    if (parameter === "freq") {
      input.setAttribute("aria-valuenow", String(nextValue));
      input.setAttribute("aria-valuetext", `${nextValue} hertz`);
    }
    const copy = { ...current.bands[selectedBandIndex], [parameter]: nextValue };
    current.bands[selectedBandIndex] = copy;
    drawGraph(current);
  });
  input.addEventListener("change", () => sendBand(selectedBandIndex, parameter, bandValue(parameter, Number(input.value))));
  wrap.append(title, input);
  return wrap;
}

function drawFilterControls(state) {
  const band = state.bands[selectedBandIndex];
  const controls = $("filterControls");
  controls.replaceChildren();
  if (!band) {
    controls.innerHTML = '<div class="empty-panel"><strong>No EQ target found</strong><span>Start PipeQ’s default graph with <kbd>n</kbd> in the TUI.</span></div>';
    $("selectedBandName").textContent = "NO FILTER";
    $("toggleBand").disabled = true;
    $("resetBand").disabled = true;
    return;
  }
  $("selectedBandName").textContent = `FILTER ${String(selectedBandIndex + 1).padStart(2, "0")} · ${band.name.toUpperCase()}`;
  $("toggleBand").disabled = false;
  $("resetBand").disabled = false;
  $("toggleBand").classList.toggle("off", band.enabled === false);
  $("toggleBand").setAttribute("aria-pressed", String(band.enabled !== false));
  $("toggleBand").textContent = band.enabled === false ? "Bypassed" : "Enabled";
  controls.append(
    controlRow(band, "Frequency", "freq", 20, 20000, 1, (value) => `${Math.round(value)} Hz`, "frequency-control"),
    controlRow(band, "Gain", "gain", -12, 12, 0.1, (value) => `${value >= 0 ? "+" : ""}${Number(value).toFixed(1)} dB`, "gain-control"),
    controlRow(band, "Q", "q", 0.1, 10, 0.01, (value) => Number(value).toFixed(2), "q-control"),
  );
}

function renderPreferences(settings) {
  themeFromSettings(settings);
  $("theme").value = settings.ui.theme;
  $("accentSetting").value = settings.ui.accent;
  $("compactSetting").value = settings.ui.compactLayout;
  for (const [action, id] of Object.entries(keys)) $(id).value = settings.ui.keybindings[action];
  $("autoRouteSetting").checked = settings.audio.autoRouteOnDeviceChange;
  $("defaultPreamp").value = settings.audio.defaultPreamp;
  $("defaultBass").value = settings.audio.defaultBassBoost;
}

function render(state) {
  current = state;
  const target = state.nodes.find((node) => node.id === state.selectedNodeId);
  $("targetTitle").textContent = target?.description || "PipeQ Equalizer";
  $("targetSubtitle").textContent = target ? `${target.name} · PipeWire target ${target.id}` : "No equalizer target is available";
  $("connectionState").textContent = "Live";
  $("liveDot").classList.remove("offline");
  $("liveDot").classList.remove("connecting");
  $("routeState").classList.remove("offline");
  $("routeState").textContent = state.enabled ? "PipeQ in playback path" : "Playback bypasses PipeQ";
  $("route").textContent = state.enabled ? "Bypass PipeQ" : "Route through PipeQ";
  $("route").classList.toggle("bypassed", !state.enabled);
  $("route").disabled = !state.nodes.length || !state.sinks.length;
  $("newPreset").disabled = !state.bands.length;
  $("newPreset").title = state.bands.length ? "Create preset from current EQ" : "Load an EQ graph before creating a preset";
  const output = $("output");
  output.replaceChildren();
  const activeOutputExists = state.sinks.some((sink) => sink.id === state.selectedOutputId);
  if (!state.sinks.length) {
    addOption(output, { id: "" }, () => "No output devices found", "");
    output.disabled = true;
  } else {
    if (!activeOutputExists) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No active output selected";
      option.disabled = true;
      option.selected = true;
      output.append(option);
    }
    for (const sink of state.sinks) addOption(output, sink, (value) => value.description || value.name, state.selectedOutputId);
    output.disabled = false;
  }
  renderPresets(state);
  if (state.bands.length) selectedBandIndex = Math.min(selectedBandIndex, state.bands.length - 1);
  $("preamp").value = state.preamp;
  $("preampValue").textContent = `${state.preamp >= 0 ? "+" : ""}${Number(state.preamp).toFixed(1)} dB`;
  $("bass").value = state.bassBoost;
  $("bassValue").textContent = `${Number(state.bassBoost).toFixed(1)} dB`;
  renderPreferences(state.settings);
  drawGraph(state);
  const graphEmpty = $("graphEmpty");
  graphEmpty.hidden = state.bands.length > 0;
  if (!state.bands.length) {
    graphEmpty.querySelector("strong").textContent = target ? "No filters detected" : "No PipeQ target found";
    graphEmpty.querySelector("span").textContent = target ? "Load an EQ graph in PipeQ to see its live frequency response." : "Start PipeQ’s EQ graph in the terminal, then refresh this view.";
  }
  drawBandStrip(state);
  drawFilterControls(state);
  if (!state.bands.length) {
    $("filterControls").classList.add("empty-controls");
    $("filterControls").innerHTML = '<div class="empty-panel"><strong>No filters detected</strong><span>Load an EQ graph in PipeQ to edit frequency response here.</span></div>';
  } else $("filterControls").classList.remove("empty-controls");
}

async function refresh(force = false) {
  if (refreshing) {
    if (!force) return refreshTask;
    await refreshTask;
    return refresh(true);
  }
  refreshing = true;
  refreshTask = (async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error("PipeQ did not return its audio state.");
      render(await response.json());
      if (connectionError) setMessage("");
      connectionError = false;
    } catch (error) {
      $("connectionState").textContent = "Offline";
      $("liveDot").classList.remove("connecting");
      $("liveDot").classList.add("offline");
      $("routeState").textContent = "PipeQ unavailable · use refresh to retry";
      $("routeState").classList.add("offline");
      setMessage(error instanceof Error ? error.message : "Cannot reach PipeQ. Keep PipeQ running in its terminal, then refresh.", true);
      connectionError = true;
    }
  })();
  try { await refreshTask; }
  finally { refreshing = false; refreshTask = undefined; }
}

function sendBand(index, parameter, value) {
  const band = current.bands[index];
  if (band) return act({ type: "band", name: band.name, parameter, value });
}

$("eqGraph").addEventListener("pointermove", (event) => {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  const svg = $("eqGraph");
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const location = point.matrixTransform(svg.getScreenCTM().inverse());
  const band = current.bands[dragging.index];
  if (!band) return;
  band.freq = Math.round(20 * 1000 ** (Math.min(1, Math.max(0, (location.x - 62) / (1188 - 62)))));
  band.gain = Math.max(-12, Math.min(12, Math.round((18 - (location.y - 18) / (396 - 18) * 36) * 10) / 10));
  showTooltip(event.clientX, event.clientY, band);
  drawGraph(current);
  drawBandStrip(current);
  drawFilterControls(current);
});
$("eqGraph").addEventListener("pointerup", async (event) => {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  const { index, initialFreq, initialGain } = dragging;
  dragging = undefined;
  $("graphTooltip").hidden = true;
  const band = current.bands[index];
  if (band) {
    if (band.freq !== initialFreq) await sendBand(index, "freq", band.freq);
    if (band.gain !== initialGain) await sendBand(index, "gain", band.gain);
  }
});
$("eqGraph").addEventListener("pointercancel", () => { dragging = undefined; $("graphTooltip").hidden = true; });
$("output").addEventListener("change", (event) => act({ type: "output", id: Number(event.target.value) }, "Output device changed"));
$("route").addEventListener("click", () => act({ type: "route", enabled: !current?.enabled }));
$("savePreset").addEventListener("click", () => act({ type: "savePreset" }, "Preset saved"));
$("refresh").addEventListener("click", refresh);
$("newPreset").addEventListener("click", () => {
  if (!current?.bands.length) return setMessage("Load a PipeWire EQ graph before creating a preset.", true);
  $("newPresetName").value = "";
  $("newPresetDialog").showModal();
  $("newPresetName").focus();
});
$("cancelNewPreset").addEventListener("click", () => $("newPresetDialog").close());
$("newPresetForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("newPresetName").value.trim();
  if (!name) return $("newPresetName").focus();
  $("newPresetDialog").close();
  act({ type: "createPreset", name }, "Preset created");
});
$("toggleBand").addEventListener("click", () => {
  const band = current?.bands[selectedBandIndex];
  if (band) act({ type: "bandEnabled", name: band.name, enabled: band.enabled === false });
});
$("resetBand").addEventListener("click", () => {
  const band = current?.bands[selectedBandIndex];
  if (band) act({ type: "resetBand", name: band.name }, "Filter reset");
});
$("preamp").addEventListener("input", (event) => { $("preampValue").textContent = `${Number(event.target.value).toFixed(1)} dB`; });
$("preamp").addEventListener("change", (event) => act({ type: "preamp", value: Number(event.target.value) }));
$("bass").addEventListener("input", (event) => { $("bassValue").textContent = `${Number(event.target.value).toFixed(1)} dB`; });
$("bass").addEventListener("change", (event) => act({ type: "bass", value: Number(event.target.value) }));
$("saveSettings").addEventListener("click", () => {
  const keybindings = {};
  for (const [action, id] of Object.entries(keys)) keybindings[action] = $(id).value;
  act({
    type: "settings",
    value: {
      ...current.settings,
      ui: { ...current.settings.ui, theme: $("theme").value, accent: $("accentSetting").value, compactLayout: $("compactSetting").value, keybindings },
      audio: { ...current.settings.audio, autoRouteOnDeviceChange: $("autoRouteSetting").checked, defaultPreamp: Number($("defaultPreamp").value), defaultBassBoost: Number($("defaultBass").value) },
    },
  }, "Preferences saved");
});
for (const id of ["theme", "accentSetting"]) $(id).addEventListener("change", () => themeFromSettings({ ...current.settings, ui: { ...current.settings.ui, theme: $("theme").value, accent: $("accentSetting").value } }));
setInterval(() => { if (!dragging && !writing && !refreshing && !document.activeElement.matches("a,input,select,button,summary,[data-band-index]")) refresh(); }, 1600);
await refresh();
