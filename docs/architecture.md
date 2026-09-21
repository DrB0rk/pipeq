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
Ink App state
    |
    +-- custom sliders, band bars, dialogs, help
    +-- local preset persistence
```

PipeQ keeps the audio graph in PipeWire. Node.js is a control plane only: it reads metadata and sends parameter updates. This avoids an extra PCM processing hop and keeps PipeWire’s negotiated format intact.

## Refresh and selection

Discovery runs periodically and reacts to default-sink monitor events. Selection is stored in refs as well as React state so refreshes do not move the user’s band or target unexpectedly. Pending writes are coalesced per node; the newest state wins while an earlier PipeWire command is in flight.

## Safety model

- EQ controls are clamped before writes.
- Headroom trim is calculated from enabled peaking bands, bass boost, and positive preamp gain.
- Route switches fade, mute, switch, configure, and fade back up.
- Physical output volume is capped below 100%.
- Failed route transitions attempt to restore the original default and volume state.

## Graph-definition boundary

PipeWire builtin filter labels are selected when the filter-chain graph is created. They are not ordinary live `Freq`, `Gain`, or `Q` controls. PipeQ keeps realtime editing limited to exposed control ports and treats graph creation as an explicit setup operation.
