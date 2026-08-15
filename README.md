# claude-patch

Community-contributed binary patches for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — unlock hard-coded limitations without waiting for upstream changes.

> **Disclaimer**: This is unofficial and not supported by Anthropic. It modifies the Claude Code binary. Use at your own risk. Keep backups and know how to reinstall Claude Code.

<img width="1264" height="516" alt="image" src="https://github.com/user-attachments/assets/dbcb6e46-e1d4-4f9e-9708-1afbedae3efe" />


## Install

### Option A: Agent Skills CLI (works with Claude Code, Cursor, Copilot, etc.)

```bash
npx skills add huybuidac/claude-code-patchkit -g
```

> The `-g` flag installs globally (user-level) so the skill is available in all projects. Without it, the skill is only available in the current project.

### Option B: Claude Code plugin system

```
/plugin marketplace add huybuidac/claude-code-patchkit
/plugin install claude-patch
```

## Prerequisites

- **Node.js (LTS) on PATH** — all platforms; scanning and patching run through one Node tool
- `codesign` on macOS (ships with Xcode Command Line Tools)
- Claude Code installed as a native binary, and write permission to it

Platforms: macOS arm64 (tested) / x86_64 (expected), Windows 11 arm64 (tested) / 10-11 x64 (expected), Linux (untested).

## Usage

Inside a Claude Code session:

```
/claude-patch                               # Interactive mode
/claude-patch apply subagent-model          # Apply specific patch
/claude-patch apply auto-compact-by-model   # Claude ≈400K, GPT ≈300K
/claude-patch revert subagent-model         # Revert to backup
/claude-patch status                        # Show all patch states
```

## Available Patches

| Patch | Description | Risk |
|-------|-------------|------|
| [subagent-model](skills/claude-patch/patches/subagent-model.md) | Unlock `model` param on Agent tool — use any model id per-call | Low |
| [auto-compact-by-model](skills/claude-patch/patches/auto-compact-by-model.md) | Model-aware extended-context compact targets: Claude ≈400K, GPT ≈300K | Medium |

### Model-aware auto-compaction

The `auto-compact-by-model` patch targets Claude Code’s central compaction resolver (functionally tested on 2.1.208; derivation verified through 2.1.233). For models whose resolved context ceiling is above 200K, it sets internal windows that normally trigger at approximately:

- `claude-*`: **400K actual context tokens**
- `gpt-*`: **300K actual context tokens**

A numeric `CLAUDE_CODE_AUTO_COMPACT_WINDOW` remains the fallback for other models. Matched extended-context Claude/GPT rules take precedence, so an existing global value can stay configured for standard or unknown model families. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` may still compact earlier.

The patch creates a backup plus a revert sidecar, and requires a Claude Code restart because running processes keep the old executable mapped.

## How It Works

Claude Code is distributed as a bun-compiled binary with embedded JS bundles. Some behaviors are locked behind hard-coded Zod schemas. This is an Agent Skill — Claude reads the patch definitions and runs the procedure with your confirmation before any write. Each apply is a **length-preserving byte swap**:

1. **Derive the anchor** — see below
2. **Context guards** — stable strings before and after must match, and any variable binding the replacement depends on must be proven, not assumed
3. **State detection** — unpatched / patched / abnormal, before acting
4. **Backup** — `<binary>.bak.<timestamp>`, plus a `<binary>.rtk-<patch>.json` sidecar recording the original bytes
5. **Verified write** — each offset is checked against its expected bytes before being overwritten, so a stale offset aborts instead of corrupting the binary
6. **Signature** — ad-hoc codesign on macOS; on Windows Authenticode becomes `HashMismatch` (binary still runs)
7. **Self-verify** — re-scan and confirm the marker count

### Anchors are derived, not hardcoded

The bundler renames minified identifiers every few builds. A hardcoded anchor then matches 0 times — indistinguishable from "the feature was removed" — so routine drift looks like a broken fingerprint. Real examples from `subagent-model`: `.enum([...])` → `xr([...])` → `Mr([...])`, three rewrites in four months.

So each patch derives its anchor at scan time from landmarks that don't move: string literals the product ships (`.describe()` text, `source:"…"` labels) and positional locals the bundler assigns by position rather than name. The patch definitions document the derivation rule instead of the bytes.

This also covers **bundle multiplicity** — the JS bundle is embedded 1 or 2 times depending on platform/version (macOS ≤ 2.1.132 = 2, ≥ 2.1.133 = 1, Windows = 1). Landmarks are counted, never asserted.

### Windows specifics

`claude.exe` is locked while running, so writes go to a copy that then takes the original's path — renaming a running image only updates the directory entry. Restart Claude Code afterwards, and clean up any `*.replacing.*` file once the old process has exited.

## Safety

- Never patches without explicit user confirmation
- Aborts if fingerprint doesn't match (schema changed in new version)
- Always creates backup before modifying
- Re-applies required per Claude Code update (new binary = clean slate)

## Contributing

1. Copy [`skills/claude-patch/patches/TEMPLATE.md`](skills/claude-patch/patches/TEMPLATE.md)
2. Register the derivation in [`patch-bin.js`](skills/claude-patch/patches/patch-bin.js) and document the rule in your `.md`
3. Test on at least 2 Claude Code versions
4. Submit a PR

### Requirements

- Anchor **derived** from a stable landmark — not a pasted byte sequence containing minified names
- Length-preserving replacement, ideally referencing only positional locals (they survive renames)
- A guard that *proves* whatever the replacement assumes about the surrounding code
- Unique, permanently stable marker string for state detection
- Tested version list, distinguishing functionally tested from structurally verified

## Platform Support

- macOS arm64 (Apple Silicon) — tested
- macOS x86_64 — should work (untested)
- Windows 11 arm64 — tested
- Windows 10/11 x64 — should work (untested)
- Linux — binary layout may differ, contributions welcome

## Recovery

- Normal route: `/claude-patch revert <patch>`, or `node patch-bin.js revert --patch <patch>`. It prefers the `<binary>.rtk-<patch>.json` sidecar (exact reverse-patch), falls back to a content-validated `<binary>.bak.<timestamp>`, and snapshots `<binary>.preRevert.<ts>` first.
- **Keep the sidecar.** A patched binary alone cannot reconstruct a drifted minified alias — only its length survives.
- **Don't restore a backup by size or filename.** On macOS the backup is Apple-signed while the patched binary is ad-hoc signed, so sizes legitimately differ; and Claude Code re-bundles within a dot-version, so same name ≠ same build. Let `revert` validate it by content.
- Clean up Windows `*.replacing.*` files after Claude Code has exited (they may stay on disk while the old process is still mapped)
- To reinstall Claude Code: delete the install dir (`~/.local/share/claude/` on Unix, `%USERPROFILE%\.local\bin\claude.exe` on Windows) and re-run the installer

## License

MIT
