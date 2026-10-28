---
name: release
description: Prepare Wincode binary releases; use before tagging, checking draft assets, or recovering a failed tag run.
---

# Releasing Wincode

Run release commands from the repository root.

## Preflight

1. Read the release version from `packages/coding-agent/package.json`. The release tag must be exactly `v<version>`; the tag workflow enforces this.
2. Require green CI for the exact commit: type checks, Default tests, E2E, and all five binary targets. Run `bun run test` and `bun run test:e2e` locally when preparing a release; the source-mode faux TUI smoke is optional locally, not a CI gate. Linux/macOS binary jobs still smoke-test compiled TUI startup and clean exit.
3. For a local binary check, run `bash scripts/release-binary-smoke.sh /absolute/path/to/wincode` and `bun run test:tui --binary /absolute/path/to/wincode`. The latter verifies TUI startup and clean exit, not a real Provider request.
4. A real Provider smoke is a separate, manual check and can incur charges. Ask for explicit approval before running it, then follow `.wincode/skills/interactive-testing/SKILL.md` against the actual release executable for the current host:

   ```bash
   bun run test:tui --live --approve-billable \
     --model 'openai/<model-id>' \
     --binary /absolute/path/to/wincode
   ```

   Count it as passed only when the prompt returns `smoke-live-ok` and the process exits cleanly. Without approval, do not run it; report it as not verified. A source run is not proof for a release binary.

## Draft verification and publication

1. Push the matching `v<version>` tag. The release workflow reuses CI, validates all five archives and their `.sha256` files, then creates or updates a GitHub draft. It never publishes.
2. Confirm the tagged workflow passed, then inspect and verify the draft assets:

   ```bash
   tag=vX.Y.Z
   gh release view "$tag" --json isDraft,assets
   tmp="$(mktemp -d)"
   gh release download "$tag" --dir "$tmp"
   (cd "$tmp" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c *.sha256; else shasum -a 256 -c *.sha256; fi)
   ```

   Confirm the release is still a draft and contains Linux x64/ARM64, macOS x64/ARM64, and Windows x64 archives with checksums.
3. A person reviews the notes and assets, then publishes the draft. The workflow refuses to replace an already-published release.
4. Recover transient tag-run failures by rerunning that GitHub Actions run. Release workflow dispatch is intentionally disabled; a manual CI run creates test artifacts, not a Release.

## Platform boundary

Windows x64 receives binary CLI checks, but native Windows ConPTY behavior is not verified. Do not report interactive Windows coverage as passing based on headless CI.
