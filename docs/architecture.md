# Architecture notes

## Runtime data flow

```text
PipeWire graph
    |
    | pw-dump / wpctl / pw-link
    v
PipeWireClient
    |
    | bounded control writes through pw-cli
    v
PipeQ process state
    |
    +-- Ink TUI
    +-- localhost HTTP control page (127.0.0.1 only)
    +-- optional StatusNotifierItem/dbusmenu tray
    +-- local preset and settings persistence
```

PipeQ keeps the audio graph in PipeWire. Node.js is a control plane only: it reads metadata and sends parameter updates. This avoids an extra PCM processing hop and keeps PipeWire’s negotiated format intact.

## Refresh and selection

Discovery runs periodically and reacts to default-sink monitor events. The TUI, browser, and tray dispatch actions into the same React-owned process state and PipeWire client. The browser server binds explicitly to loopback, checks Host and Origin, requires a process-scoped token for mutations, and sends no CORS headers. Selection is stored in refs as well as React state so refreshes do not move the user’s band or target unexpectedly. Pending writes are coalesced per node; the newest state wins while an earlier PipeWire command is in flight.

When an external default change moves playback from the EQ to a physical sink, the process treats it as a device change while automatic routing is enabled and safely restores the EQ as default after the physical link is available. In-app bypass transitions mark the route as intentional and are not undone by their own PipeWire monitor events. If PipeWire has not connected a newly selected sink yet, PipeQ keeps a pending route and retries during discovery.

The optional tray exports a freedesktop StatusNotifierItem and dbusmenu on the user session bus. Missing desktop tray support does not affect PipeWire, TUI, or web controls.

The web page and its scripts/styles live in `web/` and are served from disk with cache disabled so local edits appear after a browser refresh. Set `PIPEQ_WEB_PORT` when running `npm run dev` to keep a stable preview URL; otherwise PipeQ chooses an available local port.

## Safety model

- EQ controls are clamped before writes.
- Headroom trim is calculated from enabled peaking bands, bass boost, and positive preamp gain.
- Route switches fade, mute, switch, configure, and fade back up.
- Physical output volume is capped below 100%.
- Failed route transitions attempt to restore the original default and volume state.

## Graph-definition boundary

PipeWire builtin filter labels are selected when the filter-chain graph is created. They are not ordinary live `Freq`, `Gain`, or `Q` controls. PipeQ keeps realtime editing limited to exposed control ports and treats graph creation as an explicit setup operation.
