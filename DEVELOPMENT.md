# Development guide

## Architecture

PipeQ has four deliberately small runtime boundaries:

```text
Ink input + mouse
        |
        v
   cli.tsx  ------ local preset state
        |
        v
   eq.ts  ------ bounded values + headroom model
        |
        v
 pipewire.ts --- pw-dump / pw-cli / wpctl / pw-link
```

The application does not process PCM samples. It discovers PipeWire controls, computes bounded control values, and sends them to the active filter graph.

## Change checklist

For a user-facing change:

1. Define the interaction and failure behavior.
2. Add or update pure tests in `test/`.
3. Keep PipeWire writes queued so rapid UI input converges on the newest state.
4. Preserve current selection and preset state across refreshes.
5. Check compact terminal behavior and mouse hit regions.
6. Update README, controls, and changelog.
7. Run `npm run check`.

For routing changes, also verify that the audible path is faded, both paths are muted during handoff, physical volume stays at or below 99%, and failures attempt restoration.

## Testing without changing live audio

The test suite exercises value bounds, headroom calculations, PipeWire config generation, parsers, volume math, preset merging, and mouse parsing. It does not need a live PipeWire mutation.

Use these commands for local checks:

```sh
npm test
npm run typecheck
npm run build
```

Run the interactive app only when you intend to inspect the local PipeWire graph:

```sh
npm run dev
```

## Compatibility policy

PipeQ supports Node.js 22+ and current PipeWire command-line tools. Existing preset files are sanitized on load and may omit newer optional fields. Existing compatible graphs continue to support their exposed controls; newer controls report unavailable instead of guessing or rebuilding a graph.

## Project hygiene

Do not commit:

- `node_modules/` or generated `dist/` output;
- local preset files or device-specific dumps;
- credentials, tokens, or machine-specific paths;
- editor state or temporary logs.
