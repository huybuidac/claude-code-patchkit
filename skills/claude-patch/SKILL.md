---
name: claude-patch
description: "Patch Claude Code CLI binary to unlock hard-coded limitations. Use when the user wants to apply, revert, or check status of binary patches after upgrading Claude Code. Community-contributed patches for model restrictions, feature flags, and schema unlocks."
disable-model-invocation: true
argument-hint: "apply|revert|status|list [patch-name]"
metadata:
  author: huybuidac
  version: "1.8.0"
  compatibility: "macOS, Linux, and Windows 10/11 (arm64/x86_64). Requires Node.js on PATH; macOS additionally needs codesign (ships with Xcode CLT)."
---

# claude-patch

Binary patches for Claude Code CLI — unlock hard-coded limitations without waiting for upstream changes.

All scanning and patching runs through one cross-platform tool, [patches/patch-bin.js](patches/patch-bin.js). It handles ad-hoc re-signing on macOS and the rename-swap a locked `claude.exe` needs on Windows, so there are no per-platform scripts to choose between.

```bash
node patches/patch-bin.js scan   --patch <name> [--bin <path>]   # state + derived anchor + guards
node patches/patch-bin.js apply  --patch <name> [--bin <path>]
node patches/patch-bin.js revert --patch <name> [--bin <path>]
```

`--bin` defaults to the resolved `claude` on PATH. `scan` exits 1 when the state is abnormal.

## Workflow

1. **Identify the binary** — run `scan`; it prints the resolved path, size, and state. Show the user the path and `claude --version` before proposing any write.
2. **Select the patch** — from the user's argument, or ask. Read `patches/<name>.md` for what it does and what it is tested on.
3. **Confirm** — never write without explicit user confirmation for this specific binary.
4. **Apply or revert** — `apply` handles guard checks, backup, the write, the sidecar, re-signing, and self-verification in one step, and refuses rather than guessing if anything is off.
5. **Report** — state the resulting marker count and whether a restart is needed (patch-dependent; `subagent-model` needs none, `auto-compact-by-model` and `free-opus` do).

## Available patches

| Patch | Description |
|-------|-------------|
| [subagent-model](patches/subagent-model.md) | Unlock `model` param on Agent tool — use any model id per-call |
| [auto-compact-by-model](patches/auto-compact-by-model.md) | Model-aware extended-context compact targets (Claude ≈400K, GPT ≈300K) |
| [free-opus](patches/free-opus.md) | Drop the Opus-5-only `heron_brook` section that forbids spawning subagents/workflows |

Commands: `apply <patch>`, `revert <patch>`, `status` (scan every patch), `list`.

## Safety rules

- **NEVER** patch without explicit user confirmation.
- **NEVER** patch if a context guard fails — `apply` enforces this, so do not work around it.
- If state is `abnormal`, abort and report. Both-zero (no anchor, no marker) means the fingerprint changed: re-derive it before doing anything else, never patch blind.
- Every write is length-preserving and verified against the expected bytes at that offset first, so a stale offset aborts instead of corrupting the binary.
- Backups (`<binary>.bak.<ts>`) are ~290 MB each. Mention rotation after a version is confirmed working.

## Why anchors are derived, not hardcoded

Every literal anchor in this skill's history eventually matched 0 times, because the bundler renames minified identifiers every few builds. A count of 0 is indistinguishable from "the feature was removed", so a hardcoded anchor turns routine drift into a false abort.

Each patch therefore derives its anchor at scan time from landmarks that do not move — string literals the product ships (`.describe()` text, `source:"…"` labels) and positional locals the bundler assigns by position. Patch definitions document the derivation rule rather than the bytes. When adding a patch, find a landmark first; if the only stable thing you can find is a minified name, expect it to rot.

## Bundle multiplicity

The bun-compiled binary may embed the JS bundle more than once:

- macOS ≤ 2.1.132: **2 instances**; macOS ≥ 2.1.133: **1**
- Windows: **1** (all observed versions)

Never hard-assert a count — derivation counts landmarks and patches all of them.

## Revert

`revert` prefers the **sidecar** `<binary>.rtk-<patch>.json` that `apply` writes: it records the original bytes for each offset, so the reverse-patch is exact and immune to build mismatch. This matters because a patched binary alone cannot reconstruct a drifted alias — only its length survives.

Without a sidecar (patched before they existed) it falls back to a **content-validated backup**: the candidate must itself scan as unpatched with matching landmarks and guards. Do **not** gate on file size — on macOS the backup is Apple-signed while the patched binary is ad-hoc signed, so their sizes legitimately differ. A `<binary>.preRevert.<ts>` snapshot is taken before any write, so the revert itself is undoable.

## Platform notes

- **macOS** — patching invalidates Anthropic's signature; `apply`/`revert` re-sign ad-hoc and verify. Gatekeeper may prompt on first launch.
- **Windows** — a running `claude.exe` is locked, so writes go to a copy that then takes the original's path (renaming a running image only updates the directory entry). Authenticode becomes `HashMismatch`; the binary still runs, though SmartScreen/AppLocker policy may object. A displaced `*.replacing.*` file may linger until the old process exits.
- **Auto-update** — each new Claude Code version ships a fresh, unpatched binary. Re-apply per version.

## Contributing

To add a new patch, create `${CLAUDE_SKILL_DIR}/patches/<name>.md` following [patches/TEMPLATE.md](patches/TEMPLATE.md), and register its derivation in `patch-bin.js`.
