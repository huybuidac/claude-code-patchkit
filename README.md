# claude-patch

Community-contributed binary patches for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — unlock hard-coded limitations without waiting for upstream changes.

> **Disclaimer**: This is unofficial and not supported by Anthropic. It modifies the Claude Code binary. Use at your own risk. Keep backups and know how to reinstall Claude Code.

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

**macOS / Linux:**
- macOS arm64 (tested) or x86_64 (expected to work); Linux (untested)
- Python 3
- `codesign` (macOS only — ships with macOS)

**Windows 10/11:**
- arm64 (tested) or x64 (expected to work)
- PowerShell 5.1+
- Node.js (LTS) on PATH — required for the bundled binary scanner

**Both:**
- Claude Code installed as native binary
- Write permission to the Claude binary

## Usage

Inside a Claude Code session:

```
/claude-patch                          # Interactive mode
/claude-patch apply subagent-model     # Apply specific patch
/claude-patch revert subagent-model    # Revert to backup
/claude-patch status                   # Show all patch states
```

## Available Patches

| Patch | Description | Risk |
|-------|-------------|------|
| [subagent-model](skills/claude-patch/patches/subagent-model.md) | Unlock `model` param on Agent tool — use any model id per-call | Low |

## How It Works

Claude Code is distributed as a bun-compiled binary with embedded JS bundles. Some behaviors are locked behind hard-coded Zod schemas. This is an Agent Skill — Claude reads the patch definitions and executes the procedure interactively with your confirmation at each step. It applies **safe, length-preserving binary patches** with:

1. **Fingerprint detection** — locate exact byte patterns
2. **Context guard** — verify surrounding stable strings (not minified variables)
3. **State detection** — determine unpatched / patched / abnormal before acting
4. **Backup** — always saves `<binary>.bak.<timestamp>`
5. **Length-preserving swap** — no offset shifts or blob corruption
6. **Re-sign / signature handling** — ad-hoc codesign on macOS; on Windows the Authenticode signature becomes `HashMismatch` (binary still runs)
7. **Self-verify** — confirm marker count post-patch

> Note: the bun-compiled binary embeds the JS bundle 1 or 2 times depending on platform/version (macOS ≤ 2.1.132 = 2, macOS ≥ 2.1.133 = 1, Windows = 1). Patch definitions detect the count dynamically rather than asserting a fixed number.

### Windows specifics

`claude.exe` is locked while running, so apply/revert use a **rename-swap** pattern:
1. Copy → patch a `.patching` sidecar at the known offset
2. `Rename-Item` the live `claude.exe` to `.replacing.<ts>` (same-volume rename works on a running .exe)
3. `Move-Item` the patched copy into place
4. Restart Claude Code to pick up the new binary; clean up `*.replacing.*` after exit

## Safety

- Never patches without explicit user confirmation
- Aborts if fingerprint doesn't match (schema changed in new version)
- Always creates backup before modifying
- Re-applies required per Claude Code update (new binary = clean slate)

## Contributing

1. Copy [`skills/claude-patch/patches/TEMPLATE.md`](skills/claude-patch/patches/TEMPLATE.md)
2. Fill in all sections (fingerprint, context guard, replacement, detection, script)
3. Test on at least 2 Claude Code versions
4. Submit a PR

### Requirements

- Length-preserving replacement (old bytes == new bytes in length)
- Unique marker string embedded in replacement for state detection
- Context guard using stable strings (`.describe()` text, not minified variable names)
- Tested version list

## Platform Support

- macOS arm64 (Apple Silicon) — tested
- macOS x86_64 — should work (untested)
- Windows 11 arm64 — tested
- Windows 10/11 x64 — should work (untested)
- Linux — binary layout may differ, contributions welcome

## Recovery

- Backups are saved as `<binary>.bak.<timestamp>` next to the original
- **macOS / Linux**: `cp <binary>.bak.<timestamp> <binary> && codesign --force --sign - <binary>` (skip `codesign` on Linux)
- **Windows**: stop Claude Code, then use rename-swap — `Rename-Item claude.exe claude.exe.broken; Move-Item claude.exe.bak.<ts> claude.exe`. The backup retains the original Authenticode signature.
- Clean up Windows `*.replacing.*` files after Claude Code has exited (they may stay on disk while the old process is still mapped)
- **If your `.bak` size doesn't match the current binary** (Claude Code re-bundled within the same version), don't restore — the `/claude-patch revert` flow will detect this and offer in-place reverse-patch instead.
- To reinstall Claude Code: delete the install dir (`~/.local/share/claude/` on Unix, `%USERPROFILE%\.local\bin\claude.exe` on Windows) and re-run the installer

## License

MIT
