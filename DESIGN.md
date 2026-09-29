# Design

## Source of truth

**Status:** Active · **Date:** 2026-09-28
**Surfaces:** PipeQ Linux terminal interface and its local web control dashboard.
**Evidence reviewed:** Current web assets, control API, settings model, README, architecture notes, and the user-provided dark analytics dashboard reference. The reference guides density, hierarchy, and the unified shell; its analytics metrics and navigation do not belong in PipeQ.

## Brand

PipeQ is a precise, quiet instrument for shaping Linux desktop audio. Trust comes from showing the actual PipeWire route, selected output, live filter values, and saved-versus-unsaved state. Avoid invented telemetry, decorative activity, and controls that imply an audio change without confirming it.

## Product goals

- Let listeners confirm where playback is routed and choose an output quickly.
- Make the active preset and filter chain easy to understand and tune.
- Keep the response graph tied to real PipeQ values and make every edit reversible.
- Keep common audio controls visible while allowing detailed preferences to stay secondary.

**Non-goals:** analytics, usage history, accounts, cloud sync, or a general-purpose settings portal.

**Success signals:** users can identify route, output, and active preset at a glance; select/bypass a filter without ambiguity; tune by graph or exact control; understand connection and save failures; use the dashboard at desktop and narrow widths without losing controls.

## Personas and jobs

- **Desktop listener:** verify or restore PipeQ in the playback path after an output change; choose a device or saved sound quickly.
- **EQ tweaker:** understand the combined response, select one filter, adjust frequency/gain/Q, bypass it, and save the resulting preset.
- **PipeQ operator:** keep routing and TUI preferences consistent and diagnose when the local controller is unavailable.

## Information architecture

One dashboard, no route navigation. The shared header holds PipeQ identity, live/offline state, route state, save status, and refresh. The sidebar holds playback output and route action, preset selection/creation, master tone, and collapsible preferences. The workspace holds the current PipeQ target and active preset, the response graph, the filter chain, and controls for the selected filter.

## Design principles

1. **Audio state first:** route, target, output, preset, and edits are the content; the shell stays quiet.
2. **One action, one result:** selecting a filter does not bypass it; route and bypass states use explicit labels.
3. **Graph plus precision:** direct manipulation is useful for discovery, while labeled controls provide exact values and keyboard access.
4. **Dense but legible:** use the wide desktop canvas for the response curve; keep the sidebar compact and preferences secondary.
5. **Honest state:** no simulated metrics; loading, empty, offline, saving, and error states state what happened and the next action.

## Visual language

- **Color:** charcoal surfaces with readable neutral text; teal marks the combined response and live/active audio state; magenta distinguishes the selected filter. Error uses red with explanatory text. Light theme remains supported.
- **Typography:** system sans-serif, compact labels, tabular values, and clear title/control hierarchy. Avoid tiny low-contrast helper text.
- **Spacing:** 4px base increments; tighter within controls and more space between the graph and editing area.
- **Shape/elevation:** thin dividers define the sidebar; one rounded outer shell and a rounded workspace entrance establish the shared frame. Use borders for controls, minimal shadows.
- **Motion:** brief hover/focus feedback only; no ambient animation.
- **Imagery/iconography:** no decorative imagery. Use text labels and simple geometric icons only where they improve recognition.

## Components

- **Header:** live connection, route state, save state, refresh, save preset.
- **Playback block:** output selector and explicit route/bypass action.
- **Preset list:** selected/dirty states, direct load, separate create action.
- **Response graph:** logarithmic frequency axis, gain scale, combined response, selected filter response, keyboard-operable handles, and direct manipulation.
- **Filter chain:** one select action and one explicit bypass action per filter; selected filter exposes frequency, gain, Q, reset, and enable state.
- **Master tone:** preamp and bass shelf controls.
- **Preferences:** theme/accent, TUI layout/keybindings, auto-route behavior, and defaults for new EQs.
- **Feedback:** persistent live/offline state and a concise action result/error message.

## Accessibility

Target WCAG 2.2 AA for text and controls. Preserve semantic buttons, selects, and sliders; associate visible labels and values; keep focus visible in both themes; ensure graph handles expose slider values and do not lose keyboard focus when selecting or editing. Never use color alone for route, bypass, save, or error status. Respect reduced motion and allow text resizing. Narrow views may use independently scrollable panes while the page frame remains fixed.

## Responsive behavior

- **Wide desktop:** persistent header/sidebar; graph owns the remaining workspace height; filter chain and selected-filter controls share a row.
- **Compact desktop:** reduce graph and shell spacing before hiding controls; sidebar can scroll independently if preferences are expanded.
- **Narrow screens:** stack header, a bounded sidebar pane, and workspace. Sidebar and workspace scroll independently inside the fixed viewport; no horizontal page overflow.
- **Touch:** use explicit buttons for selection and bypass; graph dragging is optional because sliders remain available.

## Interaction states

- **Loading:** explain that PipeQ audio state is loading; do not present an empty graph as a completed state.
- **Live:** show current output, route, selected preset, active target, and actual response.
- **No target/filters/devices/presets:** explain what is absent and how to create or restore it; disable only dependent actions.
- **Offline/error:** retain a visible retry action and explain that PipeQ must be running for changes to apply.
- **Unsaved/saving/saved:** show the active preset dirty state and clear save feedback; prevent duplicate submissions while a write is in flight.
- **Disabled filter:** label it bypassed and distinguish its response without relying on color alone.

## Content voice

Use concise audio terms consistently: “Output device”, “Route through PipeQ”, “Bypass PipeQ”, “Enabled”, “Bypassed”, “Frequency”, “Gain”, “Q”, and “Unsaved changes”. Describe results directly and give an actionable next step on errors. Do not use vague labels such as “Apply” when the destination or effect is known.

## Implementation constraints

- Linux PipeWire; local same-origin web server and existing `ControlAction` API.
- Static HTML, CSS, and browser JavaScript; no added frontend framework or runtime dependency.
- Preserve dark/light themes, accent selection, output routing, preset persistence, auto-route settings, and TUI preferences.
- Browser assets are served from `web/` with no-store headers and shipped in the package.
- Verify targeted behavior with existing tests, typecheck/build, static asset checks, and browser viewport/state review when available.

## Open questions

- [ ] Confirm desired minimum browser viewport and whether phone support is a core use case; owner: product; impact: narrow-screen pane sizing.
- [ ] Confirm whether custom browser-only shortcuts are desired; owner: product; impact: avoid implying TUI keybindings operate in the web dashboard.
