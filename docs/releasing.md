# Release policy

PipeQ follows Semantic Versioning: `MAJOR.MINOR.PATCH`.

- `PATCH`: bug fixes, docs, tests, and backwards-compatible safety fixes.
- `MINOR`: backwards-compatible features or new controls, including installer and CLI entry-point additions.
- `MAJOR`: breaking configuration, runtime, or support changes.

## Release requirements

Before a release:

1. Update `package.json` and `package-lock.json` to the same version.
2. Move the relevant entries from `Unreleased` in `CHANGELOG.md` into a versioned section.
3. Run `npm run check`.
4. Review the generated README and package contents.
5. Commit the release metadata with `chore(release): prepare vX.Y.Z`.
6. Create an annotated tag named `vX.Y.Z` and push the tag.

The GitHub release workflow validates the tag with CI and creates a GitHub release with generated notes.

## Changelog rules

Use Keep a Changelog sections where useful: Added, Changed, Fixed, Removed, and Security. Describe user-visible outcomes, not internal implementation trivia.

## Pre-1.0 policy

While the major version is `0`, minor releases may contain carefully documented behavior changes. The project still avoids silent audio migrations and destructive config changes.
