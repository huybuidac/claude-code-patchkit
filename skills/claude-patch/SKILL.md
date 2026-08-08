---
name: claude-patch
description: "Patch Claude Code CLI binary to unlock hard-coded limitations. Use when the user wants to apply, revert, or check status of binary patches after upgrading Claude Code. Community-contributed patches for model restrictions, feature flags, and schema unlocks."
disable-model-invocation: true
argument-hint: "apply|revert|status|list [patch-name]"
metadata:
  author: huybuidac
  version: "1.6.0"
  compatibility: "macOS/Linux (arm64/x86_64) with codesign (macOS) + python3, OR Windows 10/11 (arm64/x64) with PowerShell 5.1+ and Node.js (required for binary scanner)."
---

# claude-patch

Binary patches for Claude Code CLI — unlock hard-coded limitations without waiting for upstream changes.

## Workflow

1. Detect platform (macOS/Linux vs Windows) and Claude Code binary
2. Ask user which patch to apply (or accept from argument)
3. Load patch definition from `patches/` directory
4. Detect state (unpatched / patched / abnormal)
5. Confirm with user before any modification
6. Backup → Patch → Re-sign (macOS) / strip-or-skip-sig (Windows) → Verify

## Step 0: Detect platform (do this FIRST, exactly once)

Set `$PLATFORM` to either `unix` or `windows`. **For every subsequent step in this skill, execute ONLY the block matching `$PLATFORM` — do not run both Unix and Windows blocks for the same step.**

Pick the snippet matching the shell you have:

- **Bash available** (macOS/Linux):
  ```bash
  case "$(uname -s 2>/dev/null)" in Darwin|Linux) PLATFORM=unix ;; *) PLATFORM=windows ;; esac
  ```
- **PowerShell available** (Windows):
  ```powershell
  $Platform = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'windows' } else { 'unix' }
  ```

If you have access to both, prefer the one matching the OS (bash on Unix, PowerShell on Windows). Don't try both — pick one.

## Step 1: Detect binary

**Unix (bash):**
```bash
CLAUDE_BIN=$(python3 -c "import os,shutil; p=shutil.which('claude'); print(os.path.realpath(p) if p else '')" 2>/dev/null)
[ -z "$CLAUDE_BIN" ] && CLAUDE_BIN="$HOME/.local/share/claude/current"
```

**Windows (PowerShell):**
```powershell
$CLAUDE_BIN = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $CLAUDE_BIN) { $CLAUDE_BIN = "$env:USERPROFILE\.local\bin\claude.exe" }
```

Show path and version for user confirmation before proceeding.

## Step 2: Select patch

If user specified a patch name → use it directly.
Otherwise → list available patches and ask user to choose.

Available patches — read each `.md` file in [patches/](patches/) directory:

| Patch | Description |
|-------|-------------|
| [subagent-model](patches/subagent-model.md) | Unlock `model` param on Agent tool — use any model id per-call |
| [auto-compact-by-model](patches/auto-compact-by-model.md) | Use model-aware extended-context compact targets (Claude ≈400K, GPT ≈300K) |

Commands:
- `apply <patch-name>` — apply a patch
- `revert <patch-name>` — revert (restore from backup)
- `status` — show state of all patches on current binary
- `list` — list available patches

## Step 3: Load and execute patch

Read the patch definition file at `${CLAUDE_SKILL_DIR}/patches/<name>.md`. Each file contains:
- Fingerprint (anchor pattern + expected count)
- Context guard (surrounding bytes to verify correct location)
- Replacement (length-preserving byte swap)
- State detection logic
- Verification steps

When a patch uses the shared Node scanner, select it explicitly with `scan-bin.js <binary> --patch <name> --json`. Omitting `--patch` remains backward-compatible and selects `subagent-model`.

## Safety rules

- **NEVER** patch without explicit user confirmation
- **NEVER** patch if fingerprint or context guard doesn't match
- **ALWAYS** backup before patching (`<binary>.bak.<timestamp>`)
- **macOS**: re-sign after patching (Gatekeeper requires valid signature)
- **Windows**: don't re-sign — Authenticode signature becomes invalid (`HashMismatch`) but binary still runs; document the change to the user
- **ALWAYS** self-verify marker count after patching
- If state is abnormal → abort and report, never patch blind

## Bundle multiplicity

The bun-compiled binary may embed the JS bundle one or more times depending on platform/version:

- macOS ≤ 2.1.132: **2 instances**
- macOS ≥ 2.1.133: **1 instance** (Anthropic switched packaging)
- Windows: **1 instance** (all observed versions)

Patch definitions detect the count dynamically — never hard-assert a specific number. State detection rule: any positive anchor count = unpatched; any positive marker count = patched; mixed = abnormal.

## Windows-specific notes

- **File-lock**: `claude.exe` cannot be modified in-place while the process is running. Use the rename-swap pattern:
  1. Copy `claude.exe` → `claude.exe.patching`
  2. Patch the copy at the known offset
  3. `Rename-Item claude.exe → claude.exe.bak.<ts>` (works on running .exe — same volume rename only updates directory entry)
  4. `Move-Item claude.exe.patching → claude.exe`
- **Backups stay around** — running process keeps the `.bak` file open until exit. Cleanup of old backups should happen after Claude Code is restarted.
- **Signature**: Authenticode by Anthropic, PBC. After patching, `Get-AuthenticodeSignature` reports `HashMismatch`. Windows still executes the binary; SmartScreen/AppLocker may flag it depending on policy.

## Step 4: Verification

After patching, run the verification block in the patch definition that matches your `$PLATFORM`. Each patch file provides parallel Unix and Windows verification — run only the one for your platform.

## Revert workflow

When reverting a patch:

1. **Find backups**:
   ```bash
   # Unix
   ls -t "$CLAUDE_BIN".bak.* | head -5
   ```
   ```powershell
   # Windows
   Get-ChildItem "$CLAUDE_BIN.bak.*" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
   ```
2. **Show timestamps and sizes** and let user pick which backup to restore.
3. **Confirm current binary is patched** before reverting — check marker count > 0.
4. **Choose revert mode**:
   - **Backup restore (preferred)** — normally only if backup file size matches current binary size (same sub-build). A patch definition may explicitly allow a macOS signature-size mismatch when it additionally verifies the same Claude version and the patch's unpatched fingerprint. Claude Code occasionally re-bundles within the same dot-version, so never restore by filename alone.
     - Unix: `cp "$BACKUP" "$CLAUDE_BIN"`
     - Windows: same rename-swap pattern as for apply (running `claude.exe` is locked)
   - **In-place reverse-patch (fallback)** — when no validated backup exists. Write the patch's original bytes back over its exact marker-bearing replacement. Length-preserving and independent of backup integrity; see each patch definition for the exact reverse procedure.
5. **Always make a safety snapshot** (`<binary>.preRevert.<ts>`) of the current patched binary before any write, so the revert itself is undoable.
6. **Re-sign (macOS only)**:
   ```bash
   codesign --remove-signature "$CLAUDE_BIN" 2>/dev/null || true
   codesign --force --sign - "$CLAUDE_BIN"
   ```
   Windows: skip — backup retains the original Authenticode signature unchanged.
7. **Verify** marker count is 0 and anchor count is positive (any value, depending on bundle multiplicity).

## Contributing

To add a new patch, create `${CLAUDE_SKILL_DIR}/patches/<name>.md` following the structure in [patches/TEMPLATE.md](patches/TEMPLATE.md).
