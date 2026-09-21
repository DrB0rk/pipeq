# PipeQ

PipeQ is a realtime PipeWire parametric equalizer for Linux. It gives you a focused terminal UI for shaping music while it is playing, with small, precise changes and a strong bias toward preserving audio quality.

The UI is built with React and [Ink](https://github.com/vadimdemedes/ink). Audio samples never pass through Node.js: PipeQ only updates PipeWire filter controls.

## What you get

- Ten realtime peaking bands with logarithmic frequency control, 0.1 dB gain steps, and Q control.
- Protected preamp control from -24 dB to +6 dB.
- 120 Hz bass shelf from 0 dB to +9 dB with automatic headroom trim.
- Per-band bypass with `e`; bypass keeps the band’s settings intact.
- Keyboard, mouse drag, and mouse wheel interaction.
- Saved presets for bands, bypass state, bass boost, and preamp.
- Safe EQ/device routing with fades, mute protection, volume preservation, and a 99% physical-output ceiling.
- Responsive, top-anchored Ink layout that stays usable in smaller terminals.

PipeQ does not resample audio or force a sample format. PipeWire negotiates the active graph format.

## Requirements

- Linux with a running PipeWire session
- PipeWire tools on `PATH`: `pw-dump`, `pw-cli`, `pw-link`, and `wpctl`
- Node.js 22 or newer
- A terminal with mouse-reporting support for mouse interaction

## Install and run

### One-command user install

The recommended install is user-local and does not require `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/DrB0rk/pipeq/main/install.sh | bash
pq
```

The installer downloads the latest stable GitHub release, builds PipeQ locally, and links the `pq` command at `~/.local/bin/pq`. It never changes system files or PipeWire settings during installation. If `pq` is not found afterward, add the user bin directory to your shell path:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Pin an exact release when reproducibility matters:

```sh
curl -fsSL https://raw.githubusercontent.com/DrB0rk/pipeq/main/install.sh \
  | PIPEQ_VERSION=v0.2.0 bash
```

To upgrade, run the installer again. To remove the user-local install:

```sh
rm -f "$HOME/.local/bin/pq"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/pipeq"
```

The `pipeq` npm package alias is also available when developing from a checkout:

```sh
npm install
npm run build
npm link
pq
```

Clone the repository, install dependencies, build, and start:

```sh
git clone https://github.com/DrB0rk/pipeq.git
cd pipeq
npm install
npm run build
npm start
```

If you already have a PipeQ-compatible filter-chain sink, PipeQ will discover it automatically. To target one exact EQ when several are available:

```sh
npm start -- --node 123
npm start -- --node effect_input.pipeq-default
```

### First-time EQ setup

If PipeQ finds no EQ target, press `n`, review the confirmation screen, and press Enter. PipeQ writes a default filter-chain fragment to:

```text
~/.config/pipewire/pipewire.conf.d/pipeq-default.conf
```

It then restarts the user PipeWire service and routes the new EQ safely. Once an EQ exists, `n` creates a new preset instead; it never replaces an existing graph.

You can also load the checked-in example manually:

```sh
mkdir -p ~/.config/pipewire/pipewire.conf.d
cp examples/pipeq.conf ~/.config/pipewire/pipewire.conf.d/
systemctl --user restart pipewire
npm start
```

## Controls

| Key | Action |
| --- | --- |
| `←` / `→` | Select a band |
| `↑` / `↓` | Adjust the focused value |
| `g` | Focus band gain |
| `f` | Focus band frequency |
| `x` | Focus band Q |
| `e` | Bypass or re-enable the selected band |
| `r` | Reset selected band gain to 0 dB |
| `R` | Reset all band gains |
| `p` | Focus preamp |
| `,` / `.` | Adjust preamp by 0.1 dB |
| `b` | Focus bass boost |
| `[` / `]` | Adjust bass boost by 0.1 dB |
| `n` | New preset, or create the default EQ when no EQ exists |
| `s` | Save the selected preset immediately |
| `j` / `k` | Load the next or previous preset |
| `a` | Route the selected EQ into playback |
| `d` | Return playback to the physical device |
| `Tab` | Select the next EQ target |
| `h` / `l` | Select the previous or next EQ target |
| `c` | Rescan PipeWire |
| `?` | Open help |
| `q` / `Esc` | Quit |

Mouse dragging is intentionally constrained to the visible control or bar. Click a band to select it; drag inside a band bar to adjust its active parameter. Wheel events change the control under the pointer by one 0.1 dB step where applicable.

## Presets

Presets are stored locally at:

```text
~/.config/pipeq/presets.json
```

Press `n` with an EQ loaded to create a named preset. Select a preset in the sidebar, change the sound, and press `s` to save that preset immediately. Presets are intentionally local and are not written into the repository.

## Audio safety and routing

PipeQ separates DSP controls from device volume. When routing with `a` or `d`, it:

1. Fades the currently audible path down.
2. Mutes both paths before changing the PipeWire default.
3. Configures the destination while muted.
4. Fades the new path back up.

The physical sink is never commanded above 99%, preventing hardware chimes caused by crossing 100%. The effective listening level is preserved as closely as PipeWire’s volume model allows. A routing failure attempts to restore the original route and volume state.

EQ boosts are protected inside the graph. The bass shelf and positive preamp gain are paired with linear trim, while negative preamp remains audible attenuation. The trim does not change the physical device volume.

PipeWire’s builtin filter type (`bq_peaking`, `bq_lowshelf`, `bq_highshelf`, and others) is selected by the filter-chain graph definition, not exposed as a live control. PipeQ therefore keeps filter-type changes out of the realtime path.

## Troubleshooting

### PipeQ says “no EQ targets”

Check that PipeWire is running and that the tools are available:

```sh
command -v pw-dump pw-cli pw-link wpctl
systemctl --user is-active pipewire
```

Then press `c` in PipeQ to rescan.

### I changed a band but hear no difference

The header must show `● IN PATH`. If it shows `○ NOT ROUTED`, press `a`. This is especially important with Bluetooth sinks such as Argon Alto: changing an EQ that is not the current default does not change the sound you hear.

### The bass or preamp control is unavailable

The selected graph may be an older or custom filter chain without the required exposed controls. The band controls remain usable. The checked-in example and PipeQ-created default graph include the current bass, trim, and preamp controls.

### PipeWire reconnects audio after first-time setup

That is expected when the default graph is created: PipeWire must restart to load a filter-chain configuration fragment. Realtime band edits do not restart PipeWire.

## Development

```sh
npm install
npm run dev       # run directly from TypeScript
npm test          # unit and parser tests
npm run typecheck
npm run build
npm run check     # test + typecheck + build
```

### Repository layout

```text
src/                Runtime and Ink UI
  cli.tsx           App, layout, input, mouse interaction
  eq.ts             DSP ranges, steps, headroom calculations
  mouse.ts          SGR mouse parser
  pipewire.ts       PipeWire discovery and control writes
  presets.ts        Local preset persistence
  types.ts          Shared domain types
test/               Node test-runner regression tests
examples/           A compatible PipeWire filter-chain fragment
docs/               Architecture and project policy
.github/            CI, release automation, and contribution templates
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. In short:

- Keep realtime audio writes explicit, bounded, and testable.
- Do not add a sample-processing path to Node.js.
- Preserve existing user configuration and avoid destructive migrations.
- Add or update regression tests with behavior changes.
- Run `npm run check` before submitting.
- Use Conventional Commit-style subjects where practical.

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture boundaries and [docs/releasing.md](docs/releasing.md) for version and release rules.

## License

PipeQ is released under the [MIT License](LICENSE).
