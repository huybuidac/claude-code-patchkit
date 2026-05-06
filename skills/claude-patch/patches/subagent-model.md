# Patch: subagent-model

Unlock the `model` parameter on the Agent/Task tool from a fixed enum `["sonnet","opus","haiku"]` to accept any string — enabling per-call model selection with full model IDs.

## Metadata

| Field | Value |
|-------|-------|
| Author | @huybuidac |
| Tested versions | 2.1.116, 2.1.119, 2.1.121 |
| Risk level | low |
| Reversible | yes (backup) |

## Motivation

Claude Code hard-codes a Zod enum `["sonnet","opus","haiku"]` in the Task tool's inputSchema. Passing a specific model ID (e.g., `claude-haiku-4-5-20251001`, `claude-opus-4-6[1M]`) gets rejected at schema validation before reaching the API.

The official workaround `CLAUDE_CODE_SUBAGENT_MODEL` env applies globally. This patch opens the schema gate for **per-call** model selection.

## Fingerprint

### Anchor pattern (32 bytes)

```
.enum(["sonnet","opus","haiku"])
```

- Expected count: **2** (bun-compile embeds the JS bundle twice)
- Length: **32 bytes**

### Context guard

Verify surrounding bytes to confirm this is the Task tool schema, not some other enum:

**Before** (must appear within 100 bytes preceding anchor):
```
.string().optional().describe("The type of specialized agent to use for this task"),model:
```

**After** (must immediately follow anchor):
```
.optional().describe("Optional model override for this agent.
```

### Stability notes

- Anchor exists identically across 116/119/121
- Zod alias variable is minified differently per version (`h.` vs `y.`) — we do NOT include it in the pattern
- Context guard uses string literals from `.describe()` calls which are stable across minification

## Replacement

| Old (32 bytes) | New (32 bytes) |
|---|---|
| `.enum(["sonnet","opus","haiku"])` | `.string()/*RTK-SUBAGENT-PATCH*/ ` |

Breakdown:
- `.string()` (9 bytes) — removes enum constraint, accepts any string
- `/*RTK-SUBAGENT-PATCH*/` (22 bytes) — JS comment serving as detection marker
- ` ` (1 trailing space) — padding to preserve length

Length-preserving: both old and new are exactly 32 bytes.

### Patch marker

```
RTK-SUBAGENT-PATCH
```

> **Note**: "RTK" is a legacy name (Rust Token Killer). The marker is kept unchanged for backward compatibility with already-patched binaries.

## State detection

| `.enum(["sonnet","opus","haiku"])` count | `RTK-SUBAGENT-PATCH` count | State | Action |
|---|---|---|---|
| 2 | 0 | **Unpatched** | OK to patch |
| 0 | 2 | **Patched** | Skip |
| other | other | **Abnormal** | Abort |

Detection one-liner:
```bash
EN=$(grep -ao -F '.enum(["sonnet","opus","haiku"])' "$BIN" | wc -l | tr -d ' ')
PT=$(grep -ao -F 'RTK-SUBAGENT-PATCH' "$BIN" | wc -l | tr -d ' ')
```

## Patch script

```bash
#!/usr/bin/env bash
set -euo pipefail

BIN="${1:?Usage: $0 <path-to-claude-binary>}"

OLD='.enum(["sonnet","opus","haiku"])'
NEW='.string()/*RTK-SUBAGENT-PATCH*/ '
MARKER='RTK-SUBAGENT-PATCH'

# 1. Detect state
EN=$(grep -ao -F "$OLD" "$BIN" | wc -l | tr -d ' ')
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ')

case "$EN/$PT" in
  2/0) echo "Status: unpatched — proceeding";;
  0/2) echo "Already patched, nothing to do"; exit 0;;
  *)   echo "Abnormal state (enum=$EN marker=$PT) — aborting"; exit 1;;
esac

# 2. Context guard
python3 - "$BIN" <<'PY'
import sys, pathlib
data = pathlib.Path(sys.argv[1]).read_bytes()
old = b'.enum(["sonnet","opus","haiku"])'
pre = b'.string().optional().describe("The type of specialized agent to use for this task"),model:'
post = b'.optional().describe("Optional model override for this agent.'
i = 0; hits = 0
while True:
    j = data.find(old, i)
    if j < 0: break
    hits += 1
    ctx_before = data[max(0,j-100):j]
    ctx_after  = data[j+len(old):j+len(old)+100]
    assert pre in ctx_before, f"context-before mismatch at offset {j}"
    assert ctx_after.startswith(post), f"context-after mismatch at offset {j}"
    i = j + 1
assert hits == 2, f"expected 2 occurrences, got {hits}"
print("Context guard passed")
PY

# 3. Backup
BACKUP="$BIN.bak.$(date +%s)"
cp "$BIN" "$BACKUP"
echo "Backup: $BACKUP"
trap 'echo "ERROR: restoring backup"; cp "$BACKUP" "$BIN"; codesign --force --sign - "$BIN" 2>/dev/null' ERR

# 4. Patch (length-preserving)
python3 - "$BIN" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
data = p.read_bytes()
old = b'.enum(["sonnet","opus","haiku"])'
new = b'.string()/*RTK-SUBAGENT-PATCH*/ '
assert len(old) == len(new) == 32
assert data.count(old) == 2
data = data.replace(old, new)
p.write_bytes(data)
print("Patched 2 occurrences")
PY

# 5. Re-sign (macOS)
codesign --remove-signature "$BIN" 2>/dev/null || true
codesign --force --sign - "$BIN"
echo "Re-signed"
codesign --verify "$BIN" 2>&1 || { echo "Codesign verify failed"; exit 1; }

# 6. Self-verify
VERIFY=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ')
if [ "$VERIFY" -eq 2 ]; then
  echo "Verified: patch applied successfully"
else
  echo "Self-verify FAILED (marker count: $VERIFY)"; exit 1
fi
```

## Revert script

```bash
#!/usr/bin/env bash
set -euo pipefail
BIN="${1:?Usage: $0 <path-to-claude-binary>}"
MARKER='RTK-SUBAGENT-PATCH'
# Verify currently patched
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ')
[ "$PT" -ne 2 ] && echo "Binary is not patched (marker count: $PT)" && exit 1
# Find latest backup
BACKUP=$(ls -t "$BIN".bak.* 2>/dev/null | head -1)
[ -z "$BACKUP" ] && echo "No backup found for $BIN" && exit 1
echo "Reverting to: $BACKUP"
cp "$BACKUP" "$BIN"
codesign --remove-signature "$BIN" 2>/dev/null || true
codesign --force --sign - "$BIN"
codesign --verify "$BIN" 2>&1 || { echo "Codesign verify failed after revert"; exit 1; }
# Verify reverted
EN=$(grep -ao -F '.enum(["sonnet","opus","haiku"])' "$BIN" | wc -l | tr -d ' ')
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ')
[ "$EN" -eq 2 ] && [ "$PT" -eq 0 ] && echo "Reverted successfully" || { echo "Revert verification failed (enum=$EN marker=$PT)"; exit 1; }
```

## Verification

After patching:
```bash
# Confirm marker present
grep -c -a -F 'RTK-SUBAGENT-PATCH' "$(which claude)"
# Expected output: 2

# Functional test (run in Claude Code session):
# Spawn Agent with model: "claude-haiku-4-5-20251001"
# Should succeed instead of schema validation error
```

## Post-patch behavior

- `model` field accepts any string
- Downstream resolver still handles aliases (`sonnet` → current sonnet, etc.)
- Full model IDs pass through to API directly
- Invalid model IDs fail at API call (400/404) rather than schema validation

## Caveats

1. **macOS signing** — re-sign with ad-hoc codesign resolves it. May trigger Gatekeeper on first launch.
2. **Auto-update** — new Claude Code version = new binary. Re-apply per version.
3. **No validation** — garbage model IDs produce API errors (harder to debug than schema errors).
4. **Dual bundle** — bun-compile embeds JS twice; script patches both automatically.

## Changelog

| Date | Version | Note |
|------|---------|------|
| 2026-05-06 | 1.0 | Initial — tested on 2.1.116, 2.1.119, 2.1.121 |
