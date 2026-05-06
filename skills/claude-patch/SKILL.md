---
name: claude-patch
description: "Patch Claude Code CLI binary to unlock hard-coded limitations. Use when the user wants to apply, revert, or check status of binary patches after upgrading Claude Code. Community-contributed patches for model restrictions, feature flags, and schema unlocks."
disable-model-invocation: true
argument-hint: "apply|revert|status|list [patch-name]"
metadata:
  author: huybuidac
  version: "1.0.0"
  compatibility: "Requires macOS (arm64 or x86_64) with codesign available. Python 3 required for patch scripts."
---

# claude-patch

Binary patches for Claude Code CLI — unlock hard-coded limitations without waiting for upstream changes.

## Workflow

1. Detect Claude Code binary and version
2. Ask user which patch to apply (or accept from argument)
3. Load patch definition from `patches/` directory
4. Detect state (unpatched / patched / abnormal)
5. Confirm with user before any modification
6. Backup → Patch → Re-sign → Verify

## Step 1: Detect binary

```bash
CLAUDE_BIN=$(python3 -c "import os,shutil; p=shutil.which('claude'); print(os.path.realpath(p) if p else '')" 2>/dev/null)
[ -z "$CLAUDE_BIN" ] && CLAUDE_BIN="$HOME/.local/share/claude/current"
```

Show path and version for user confirmation before proceeding.

## Step 2: Select patch

If user specified a patch name → use it directly.
Otherwise → list available patches and ask user to choose.

Available patches — read each `.md` file in [patches/](patches/) directory:

| Patch | Description |
|-------|-------------|
| [subagent-model](patches/subagent-model.md) | Unlock `model` param on Agent tool — use any model id per-call |

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

## Safety rules

- **NEVER** patch without explicit user confirmation
- **NEVER** patch if fingerprint or context guard doesn't match
- **ALWAYS** backup before patching (`<binary>.bak.<timestamp>`)
- **ALWAYS** re-sign after patching (macOS requires valid signature)
- **ALWAYS** self-verify marker count after patching
- If state is abnormal → abort and report, never patch blind

## Step 4: Verification

After patching, run the verification commands specified in the patch definition to confirm functional correctness.

## Revert workflow

When reverting a patch:

1. **Find backups**:
   ```bash
   ls -t "$CLAUDE_BIN".bak.* | head -5
   ```
2. **Show timestamps** and let user pick which backup to restore.
3. **Confirm current binary is patched** before reverting — check marker count > 0.
4. **Copy backup over binary**:
   ```bash
   cp "$BACKUP" "$CLAUDE_BIN"
   ```
5. **Re-sign restored binary**:
   ```bash
   codesign --remove-signature "$CLAUDE_BIN" 2>/dev/null || true
   codesign --force --sign - "$CLAUDE_BIN"
   ```
6. **Verify** marker count is 0 and anchor count is restored:
   ```bash
   # Marker should be gone
   PT=$(grep -ao -F "$MARKER" "$CLAUDE_BIN" | wc -l | tr -d ' ')
   # Anchor should be back
   EN=$(grep -ao -F "$ANCHOR" "$CLAUDE_BIN" | wc -l | tr -d ' ')
   [ "$PT" -eq 0 ] && [ "$EN" -eq 2 ] && echo "Revert successful" || echo "Revert verification failed"
   ```

## Contributing

To add a new patch, create `${CLAUDE_SKILL_DIR}/patches/<name>.md` following the structure in [patches/TEMPLATE.md](patches/TEMPLATE.md).
