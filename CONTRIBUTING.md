# Contributing to PipeQ

Thanks for helping improve PipeQ. Contributions should keep the realtime path predictable, the terminal UI usable, and user audio safe.

## Before you start

1. Search existing issues and pull requests.
2. For behavior changes, describe the user problem and the expected result.
3. For audio-path changes, explain how clipping, routing transitions, and rollback are protected.
4. Keep unrelated refactors out of the same pull request.

## Development workflow

```sh
npm install
npm run check
npm run dev
```

`npm run check` is the required local gate. It runs tests, TypeScript checking, and the production build.

## Pull requests

- Use a focused branch and a focused commit series.
- Add regression coverage for new logic or bug fixes.
- Update the README and changelog when user-visible behavior changes.
- Include terminal size, PipeWire version, Node version, and reproduction steps for UI or audio bugs.
- Never include personal preset files, device dumps containing private names, or credentials.

## Commit style

Use a Conventional Commit-style subject when possible:

```text
feat(ui): add preamp control
fix(routing): preserve mute state during handoff
docs: clarify preset workflow
test(eq): cover disabled-band headroom
```

Keep the subject imperative and under roughly 72 characters. Rebase or squash only when the project maintainer asks for it.

## Design boundaries

- `src/cli.tsx` owns interaction and presentation.
- `src/eq.ts` owns ranges, stepping, and DSP safety calculations.
- `src/pipewire.ts` owns discovery, control writes, and route transitions.
- `src/presets.ts` owns local persistence and migration-safe sanitization.
- PipeWire graph changes must be explicit; ordinary slider edits must remain realtime control updates.
- New dependencies require a clear maintenance and security justification.

## Reporting security issues

Do not open a public issue for a credential leak, command-injection path, or unsafe audio-routing behavior. Follow [SECURITY.md](SECURITY.md) instead.
