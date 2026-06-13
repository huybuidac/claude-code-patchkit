# Patch: subagent-model

Unlock the `model` parameter on the Agent/Task tool from a fixed enum (`["sonnet","opus","haiku"]` on ≤ 2.1.169, `["sonnet","opus","haiku","fable"]` on ≥ 2.1.170) to accept any string — enabling per-call model selection with full model IDs.

## Metadata

| Field | Value |
|-------|-------|
| Author | @huybuidac |
| Tested versions | 2.1.116, 2.1.119, 2.1.121, 2.1.132 (2-instance bundle, 32-byte 3-enum), 2.1.133 (1-instance bundle, 32-byte 3-enum), 2.1.170 (1-instance bundle, 40-byte 4-enum, `"`-quoted post-guard), 2.1.176 (1-instance bundle, 40-byte 4-enum, backtick post-guard) on macOS; 2.1.x on Windows arm64 |
| Risk level | low |
| Reversible | yes (backup) |
| Platforms | macOS (arm64/x86_64), Windows (arm64/x64) |

## Motivation

Claude Code hard-codes a Zod enum in the Task tool's inputSchema (`["sonnet","opus","haiku"]` on ≤ 2.1.169, extended to `["sonnet","opus","haiku","fable"]` on ≥ 2.1.170). Passing a specific model ID (e.g., `claude-haiku-4-5-20251001`, `claude-opus-4-6[1M]`) gets rejected at schema validation before reaching the API.

The official workaround `CLAUDE_CODE_SUBAGENT_MODEL` env applies globally. This patch opens the schema gate for **per-call** model selection.

## Fingerprint

> **Anchor changed at 2.1.170.** Anthropic added a fourth model alias (`"fable"`) to the enum. This changes BOTH the anchor bytes AND its length (32 → 40), so the replacement string changes too. The skill ships the 2.1.170+ anchor as primary; the pre-2.1.170 3-enum is documented below as historical.

### Anchor pattern — ≥ 2.1.170 (40 bytes, current)

```
.enum(["sonnet","opus","haiku","fable"])
```

- Length: **40 bytes**
- Observed count on 2.1.170 macOS arm64: **1** (single bundle embed)

### Anchor pattern — ≤ 2.1.169 (32 bytes, historical)

```
.enum(["sonnet","opus","haiku"])
```

- Length: **32 bytes** — no longer present in 2.1.170+ binaries.

### Bundle multiplicity

- Expected count: **variable — detect dynamically**
  - **macOS ≤ 2.1.132**: 2 (bun-compile embedded the JS bundle twice)
  - **macOS ≥ 2.1.133**: 1 (Anthropic switched to single bundle embed) — still 1 on 2.1.170
  - **Windows**: 1 (single bundle embed, all observed versions)
  - State detection MUST treat any positive anchor count as "unpatched" rather than hard-asserting a specific number.

### Context guard

Verify surrounding bytes to confirm this is the Task tool schema, not one of the other `["sonnet","opus","haiku","fable"]` arrays in the binary (on 2.1.170 the bare 4-element array appears 4×, but only one is wrapped in `.enum(...)` and only one has this context):

**Before** (must appear within 100 bytes preceding anchor):
```
.string().optional().describe("The type of specialized agent to use for this task"),model:
```
Note: on 2.1.170 the byte immediately before the anchor is the minified Zod alias (`k`), i.e. the live text is `...,model:k.enum(...)`. The guard string ends at `model:` and is matched as a substring, so the alias char does not affect it.

**After** (must immediately follow anchor):
```
.optional().describe(<q>Optional model override for this agent.
```
where `<q>` is the JS string-quote character that the minifier chose for the description:
- **2.1.170–2.1.175**: a double-quote `"` → `.optional().describe("Optional model override for this agent.`
- **≥ 2.1.176**: a **backtick** `` ` `` → `.optional().describe(\`Optional model override for this agent.` — Anthropic expanded the description (it now contains an apostrophe in *"agent definition's"* and an embedded `"fork"`), so the minifier emitted a template literal instead of a `"`-quoted string.

The guard is therefore **quote-agnostic**: it checks the stable prefix `.optional().describe(` immediately after the anchor **and** the stable substring `Optional model override for this agent.` in the following bytes — it does NOT pin the quote character. This survives both the 2.1.176 quote flip and any future quote-style change.

### Stability notes

- Anchor **content and length changed at 2.1.170** (added `"fable"`, 32 → 40 bytes). Byte-identical within each era: 116/119/121/132/133 share the 32-byte 3-enum; 2.1.170 uses the 40-byte 4-enum.
- Zod alias variable is minified differently per version (`h.` vs `y.` vs `v.` vs `k.`) — we do NOT include it in the pattern.
- Context guard uses string literals from `.describe()` calls which are stable across minification — the **text** is unchanged across the 2.1.170 enum change, which is why the guard still validates. At **2.1.176** the post-guard's surrounding *quote character* flipped from `"` to a backtick (description gained an apostrophe + embedded `"fork"`), so the guard was made quote-agnostic — it no longer matches the quote byte, only the stable prefix `.optional().describe(` and the stable text `Optional model override for this agent.`
- **Bundle multiplicity is NOT stable** — Anthropic flipped macOS from 2-instance to 1-instance between 2.1.132 and 2.1.133 (still 1-instance at 2.1.170). Treat the count as observed, not fixed.

## Replacement

### ≥ 2.1.170 (40 bytes, current)

| Old (40 bytes) | New (40 bytes) |
|---|---|
| `.enum(["sonnet","opus","haiku","fable"])` | `.string()/*RTK-SUBAGENT-PATCH*/         ` |

Breakdown:
- `.string()` (9 bytes) — removes enum constraint, accepts any string
- `/*RTK-SUBAGENT-PATCH*/` (22 bytes) — JS comment serving as detection marker
- `         ` (9 trailing spaces) — padding to preserve length

Length-preserving: both old and new are exactly 40 bytes.

### ≤ 2.1.169 (32 bytes, historical)

| Old (32 bytes) | New (32 bytes) |
|---|---|
| `.enum(["sonnet","opus","haiku"])` | `.string()/*RTK-SUBAGENT-PATCH*/ ` |

Same marker, 1 trailing space (32-byte total). The marker string is identical across both eras — only the padding width differs — so detection (`grep RTK-SUBAGENT-PATCH`) works regardless of which era patched the binary.

### Patch marker

```
RTK-SUBAGENT-PATCH
```

> **Note**: "RTK" is a legacy name (Rust Token Killer). The marker is kept unchanged for backward compatibility with already-patched binaries.

## State detection

Generic — works for any bundle multiplicity (1 or 2 currently observed):

| Anchor count | Marker count | State | Action |
|---|---|---|---|
| ≥ 1 | 0 | **Unpatched** | OK to patch (record count, patch all, expect marker == count) |
| 0 | ≥ 1 | **Patched** | Skip |
| ≥ 1 | ≥ 1 | **Abnormal** (mixed) | Abort — partial/concurrent patch |
| 0 | 0 | **Abnormal** (anchor missing) | Abort — fingerprint changed in this version |

Concretely as observed:
- macOS ≤ 2.1.132: unpatched=`2/0`, patched=`0/2`
- macOS 2.1.133–2.1.169: unpatched=`1/0`, patched=`0/1`
- macOS ≥ 2.1.170: unpatched=`1/0`, patched=`0/1` (anchor is the 40-byte 4-enum; post-guard quote is `"` on 2.1.170–2.1.175, backtick on ≥ 2.1.176 — anchor bytes unchanged either way)
- Windows: unpatched=`1/0`, patched=`0/1`

Detection one-liner — Unix (use the 40-byte anchor on 2.1.170+):
```bash
EN=$(grep -ao -F '.enum(["sonnet","opus","haiku","fable"])' "$BIN" | wc -l | tr -d ' ')
PT=$(grep -ao -F 'RTK-SUBAGENT-PATCH' "$BIN" | wc -l | tr -d ' ')
```

Detection — Windows (uses bundled Node scanner):
```powershell
$json = & node "$PSScriptRoot\scan-bin.js" $CLAUDE_BIN --json | ConvertFrom-Json
# $json.anchorCount, $json.markerCount, $json.state, $json.contextGuards
```

## Patch script

### macOS / Linux (bash)

> **Note**: bundle multiplicity is detected at runtime, not asserted. Works on both legacy 2-instance bundles (≤ 2.1.132) and current 1-instance bundles (≥ 2.1.133), and tolerates future re-bundling changes as long as every anchor still has the right context guard.

```bash
#!/usr/bin/env bash
set -euo pipefail

BIN="${1:?Usage: $0 <path-to-claude-binary>}"

# 2.1.170+ anchor (40 bytes). For ≤ 2.1.169 use the 32-byte 3-enum:
#   OLD='.enum(["sonnet","opus","haiku"])'   NEW='.string()/*RTK-SUBAGENT-PATCH*/ '
OLD='.enum(["sonnet","opus","haiku","fable"])'
NEW='.string()/*RTK-SUBAGENT-PATCH*/         '   # 40 bytes (9 trailing spaces)
MARKER='RTK-SUBAGENT-PATCH'

# 1. Detect state — generic (works for any bundle count)
# `|| true`: grep exits 1 when a needle is absent (e.g. marker on an unpatched binary);
# under `set -o pipefail` + `set -e` that would kill the script at the assignment before
# the `if` ever runs. The assignment still captures wc's count; `|| true` just eats the status.
EN=$(grep -ao -F "$OLD" "$BIN" | wc -l | tr -d ' ') || true
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true

if   [ "$EN" -ge 1 ] && [ "$PT" -eq 0 ]; then
  echo "Status: unpatched (anchor=$EN) — proceeding"
  EXPECT="$EN"
elif [ "$EN" -eq 0 ] && [ "$PT" -ge 1 ]; then
  echo "Already patched (marker=$PT), nothing to do"; exit 0
else
  echo "Abnormal state (enum=$EN marker=$PT) — aborting"; exit 1
fi

# 2. Context guard — every anchor must have valid pre/post context
python3 - "$BIN" "$EXPECT" <<'PY'
import sys, pathlib
data = pathlib.Path(sys.argv[1]).read_bytes()
expect = int(sys.argv[2])
old = b'.enum(["sonnet","opus","haiku","fable"])'
pre = b'.string().optional().describe("The type of specialized agent to use for this task"),model:'
# Quote-agnostic post-guard: the .describe() quote flipped "->backtick at 2.1.176.
post_prefix = b'.optional().describe('
post_desc   = b'Optional model override for this agent.'
i = 0; hits = 0
while True:
    j = data.find(old, i)
    if j < 0: break
    hits += 1
    ctx_before = data[max(0,j-100):j]
    ctx_after  = data[j+len(old):j+len(old)+120]
    assert pre in ctx_before, f"context-before mismatch at offset {j}"
    assert ctx_after.startswith(post_prefix), f"context-after prefix mismatch at offset {j}"
    assert post_desc in ctx_after, f"context-after desc mismatch at offset {j}"
    i = j + 1
assert hits == expect, f"expected {expect} occurrences, got {hits}"
print(f"Context guard passed ({hits} anchor[s] verified)")
PY

# 3. Backup
BACKUP="$BIN.bak.$(date +%s)"
cp "$BIN" "$BACKUP"
echo "Backup: $BACKUP"
trap 'echo "ERROR: restoring backup"; cp "$BACKUP" "$BIN"; codesign --force --sign - "$BIN" 2>/dev/null' ERR

# 4. Patch (length-preserving)
python3 - "$BIN" "$EXPECT" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
expect = int(sys.argv[2])
data = p.read_bytes()
old = b'.enum(["sonnet","opus","haiku","fable"])'
new = b'.string()/*RTK-SUBAGENT-PATCH*/         '
assert len(old) == len(new) == 40
hits = data.count(old)
assert hits == expect, f"anchor count changed between detect and patch ({hits} vs {expect})"
data = data.replace(old, new)
p.write_bytes(data)
print(f"Patched {hits} occurrence(s)")
PY

# 5. Re-sign (macOS)
codesign --remove-signature "$BIN" 2>/dev/null || true
codesign --force --sign - "$BIN"
echo "Re-signed"
codesign --verify "$BIN" 2>&1 || { echo "Codesign verify failed"; exit 1; }

# 6. Self-verify — marker count should equal the original anchor count
VERIFY=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true
if [ "$VERIFY" -eq "$EXPECT" ]; then
  echo "Verified: patch applied successfully ($VERIFY marker[s])"
else
  echo "Self-verify FAILED (expected $EXPECT marker[s], got $VERIFY)"; exit 1
fi
```

### Windows (PowerShell)

Uses the **rename-swap** pattern because Claude Code is typically running while the skill executes — modifying `claude.exe` in place is blocked by the file lock.

```powershell
# Self-contained: resolve binary path and skill paths from current location.
# Run from any cwd. Requires Node.js on PATH (or via full path).
$ErrorActionPreference = 'Stop'

# Resolve claude.exe — prefer Get-Command, fallback to common location
$Bin = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $Bin) { $Bin = "$env:USERPROFILE\.local\bin\claude.exe" }
if (-not (Test-Path $Bin)) { throw "claude.exe not found at $Bin" }

# Resolve scanner — sibling of this script, or in the patches/ directory of the skill
$ScanJs = Join-Path $PSScriptRoot 'scan-bin.js'
if (-not (Test-Path $ScanJs)) {
  $ScanJs = "$env:USERPROFILE\.claude\skills\claude-patch\patches\scan-bin.js"
}
if (-not (Test-Path $ScanJs)) { throw "scan-bin.js not found (looked in $PSScriptRoot and skill dir)" }

# Resolve node — prefer PATH, fallback to default install location
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $Node)) { throw "node.exe not found — install Node.js LTS first" }

$Old    = '.enum(["sonnet","opus","haiku","fable"])'
$New    = '.string()/*RTK-SUBAGENT-PATCH*/         '   # 40 bytes, length-preserving (9 trailing spaces)
$Marker = 'RTK-SUBAGENT-PATCH'
# For ≤ 2.1.169 binaries use the 32-byte 3-enum instead:
#   $Old = '.enum(["sonnet","opus","haiku"])'  ;  $New = '.string()/*RTK-SUBAGENT-PATCH*/ '

# 1. State detect + context guard via Node scanner — count-agnostic
$state = & $Node $ScanJs $Bin --json | ConvertFrom-Json
if ($state.state -ne 'unpatched' -or $state.anchorCount -lt 1) {
  throw "State: $($state.state), anchor=$($state.anchorCount) marker=$($state.markerCount) — aborting"
}
$expect = [int]$state.anchorCount
Write-Host "Detected $expect anchor instance(s) — proceeding"

# Every anchor must have valid pre/post context
$offsets = @()
foreach ($g in $state.contextGuards) {
  if (-not $g.preMatch -or -not $g.postMatch) {
    throw "Context guard failed at offset $($g.offset) (preMatch=$($g.preMatch) postMatch=$($g.postMatch))"
  }
  $offsets += [int64]$g.offset
}

# 2. Backup (Copy is read-only on source — works while claude.exe is running)
$ts     = [DateTimeOffset]::Now.ToUnixTimeSeconds()
$backup = "$Bin.bak.$ts"
Copy-Item $Bin $backup
Write-Host "Backup: $backup"

# 3. Patch a fresh copy at every known offset (length-preserving overwrite)
$temp = "$Bin.patching"
Copy-Item $Bin $temp -Force
$newBytes = [System.Text.Encoding]::UTF8.GetBytes($New)
if ($newBytes.Length -ne 40) { throw "Replacement is not 40 bytes" }
$fs = [System.IO.File]::Open($temp, 'Open', 'Write', 'None')
try {
  foreach ($off in $offsets) {
    $fs.Seek($off, 'Begin') | Out-Null
    $fs.Write($newBytes, 0, $newBytes.Length)
  }
} finally { $fs.Close() }

# 4. Verify the patched copy — marker count should equal original anchor count
$verify = & $Node $ScanJs $temp --json | ConvertFrom-Json
if ($verify.markerCount -ne $expect -or $verify.anchorCount -ne 0) {
  Remove-Item $temp -Force
  throw "Patched copy verification failed (anchor=$($verify.anchorCount) marker=$($verify.markerCount), expected anchor=0 marker=$expect)"
}

# 5. Rename-swap. Renaming a running .exe on the same volume succeeds because
#    Windows just updates the directory entry; the file mapping stays valid.
$tomb = "$Bin.replacing.$ts"
try {
  Rename-Item $Bin $tomb           # old running binary kept under new name
  Move-Item   $temp $Bin           # patched copy now occupies original path
} catch {
  # Best-effort rollback
  if (Test-Path $tomb -PathType Leaf) { Rename-Item $tomb $Bin -ErrorAction SilentlyContinue }
  if (Test-Path $temp -PathType Leaf) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
  throw
}

# 6. Try to remove the displaced old binary. May fail if a process still has it
#    mapped — leave it; Windows will release on process exit and user can clean up.
Remove-Item $tomb -Force -ErrorAction SilentlyContinue

# 7. Self-verify on the new binary at the original path
$final = & $Node $ScanJs $Bin --json | ConvertFrom-Json
if ($final.markerCount -eq $expect -and $final.anchorCount -eq 0) {
  Write-Host "Verified: patch applied successfully ($($final.markerCount) marker[s])"
} else {
  throw "Self-verify FAILED on final binary (anchor=$($final.anchorCount) marker=$($final.markerCount), expected anchor=0 marker=$expect)"
}

# 8. Inform user about Authenticode
$sig = Get-AuthenticodeSignature $Bin
Write-Host "Authenticode status after patch: $($sig.Status) (HashMismatch is expected; binary still runs)"
Write-Host "Restart Claude Code to pick up the patched binary."
```

## Revert script

### macOS / Linux (bash)

Two revert modes:

1. **Backup restore** — copy `<bin>.bak.<ts>` over the binary. Safe only if the backup file size matches the current binary size (i.e., backup was taken from the same sub-build). If sizes differ, the backup is from a different build and would replace 2.1.X content with older bytes — fall through to mode 2.
2. **In-place reverse-patch** — write the 32-byte enum back over the marker. Length-preserving, doesn't depend on backup integrity. Use when no usable backup exists or when the backup is from a different build.

```bash
#!/usr/bin/env bash
set -euo pipefail
BIN="${1:?Usage: $0 <path-to-claude-binary>}"
# 2.1.170+ (40-byte) anchor. For ≤ 2.1.169 use the 32-byte 3-enum variant.
OLD='.enum(["sonnet","opus","haiku","fable"])'
NEW='.string()/*RTK-SUBAGENT-PATCH*/         '
MARKER='RTK-SUBAGENT-PATCH'

# 1. Verify currently patched (any marker count >= 1)
# `|| true` guards against grep's exit-1-on-no-match killing the script under set -e + pipefail.
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true
[ "$PT" -lt 1 ] && echo "Binary is not patched (marker count: $PT)" && exit 1
EXPECT="$PT"
echo "Currently patched (marker count: $PT)"

# 2. Try backup restore first — but only if sizes match (same build)
BACKUP=""
CUR_SZ=$(stat -f%z "$BIN" 2>/dev/null || stat -c%s "$BIN")
for cand in $(ls -t "$BIN".bak.* 2>/dev/null); do
  CAND_SZ=$(stat -f%z "$cand" 2>/dev/null || stat -c%s "$cand")
  if [ "$CAND_SZ" -eq "$CUR_SZ" ]; then
    BACKUP="$cand"; break
  else
    echo "  Skipping $cand (size $CAND_SZ != current $CUR_SZ — different build)"
  fi
done

# Always keep a safety snapshot of current (patched) state before any write
SAFETY="$BIN.preRevert.$(date +%s)"
cp "$BIN" "$SAFETY"
echo "Safety snapshot of current patched binary: $SAFETY"

if [ -n "$BACKUP" ]; then
  echo "Reverting from backup: $BACKUP"
  cp "$BACKUP" "$BIN"
else
  echo "No size-matching backup found — performing in-place reverse-patch"
  python3 - "$BIN" "$EXPECT" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
expect = int(sys.argv[2])
data = p.read_bytes()
old = b'.string()/*RTK-SUBAGENT-PATCH*/         '   # 40 bytes (current marker)
new = b'.enum(["sonnet","opus","haiku","fable"])'   # 40 bytes (original)
assert len(old) == len(new) == 40
hits = data.count(old)
assert hits == expect, f"marker count drifted ({hits} vs {expect})"
data = data.replace(old, new)
p.write_bytes(data)
print(f"Reverse-patched {hits} occurrence(s)")
PY
fi

# 3. Re-sign
codesign --remove-signature "$BIN" 2>/dev/null || true
codesign --force --sign - "$BIN"
codesign --verify "$BIN" 2>&1 || { echo "Codesign verify failed after revert"; exit 1; }

# 4. Verify reverted — generic (|| true: marker is absent after a clean revert → grep exits 1)
EN=$(grep -ao -F "$OLD" "$BIN" | wc -l | tr -d ' ') || true
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true
if [ "$EN" -ge 1 ] && [ "$PT" -eq 0 ]; then
  echo "Reverted successfully (anchor=$EN marker=0)"
else
  echo "Revert verification failed (enum=$EN marker=$PT)"; exit 1
fi
```

### Windows (PowerShell)

```powershell
# Self-contained: resolves $Bin / $ScanJs / $Node from current environment.
$ErrorActionPreference = 'Stop'

$Bin = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $Bin) { $Bin = "$env:USERPROFILE\.local\bin\claude.exe" }
if (-not (Test-Path $Bin)) { throw "claude.exe not found at $Bin" }

$ScanJs = Join-Path $PSScriptRoot 'scan-bin.js'
if (-not (Test-Path $ScanJs)) {
  $ScanJs = "$env:USERPROFILE\.claude\skills\claude-patch\patches\scan-bin.js"
}
if (-not (Test-Path $ScanJs)) { throw "scan-bin.js not found" }

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $Node)) { throw "node.exe not found" }

$Old    = '.enum(["sonnet","opus","haiku","fable"])'   # 40 bytes (2.1.170+); use 3-enum for ≤ 2.1.169
$New    = '.string()/*RTK-SUBAGENT-PATCH*/         '
$Marker = 'RTK-SUBAGENT-PATCH'

# 1. Confirm currently patched (any marker count >= 1)
$state = & $Node $ScanJs $Bin --json | ConvertFrom-Json
if ($state.state -ne 'patched' -or $state.markerCount -lt 1) {
  throw "Not patched (state=$($state.state) marker=$($state.markerCount)) — nothing to revert"
}
$expect = [int]$state.markerCount
Write-Host "Currently patched (marker count: $expect)"

# 2. Find size-matching backup (Claude Code re-bundles within same dot-version,
#    so an older .bak may be a different build with different bytes/size).
$curSize = (Get-Item $Bin).Length
$backup = $null
foreach ($cand in (Get-ChildItem "$Bin.bak.*" -ErrorAction SilentlyContinue |
                   Sort-Object LastWriteTime -Descending)) {
  if ($cand.Length -eq $curSize) { $backup = $cand; break }
  Write-Host "  Skipping $($cand.Name) (size $($cand.Length) != current $curSize — different build)"
}

# 3. Stage replacement bytes — either backup copy or in-place reverse-patch
$staged = "$Bin.reverting"

if ($backup) {
  Write-Host "Reverting from backup: $($backup.FullName)"
  Copy-Item $backup.FullName $staged -Force
} else {
  Write-Host "No size-matching backup — performing in-place reverse-patch"
  Copy-Item $Bin $staged -Force
  $oldBytes = [System.Text.Encoding]::UTF8.GetBytes($New)    # current marker bytes
  $newBytes = [System.Text.Encoding]::UTF8.GetBytes($Old)    # restore enum bytes
  if ($newBytes.Length -ne 40 -or $oldBytes.Length -ne 40) { throw "Replacement is not 40 bytes" }
  # Find marker offsets in the staged copy (use scanner: it only reports anchor offsets,
  # so re-scan with marker as the needle would need a separate pass — easier to scan via PowerShell).
  $bytes = [System.IO.File]::ReadAllBytes($staged)
  $offsets = New-Object System.Collections.Generic.List[int64]
  $pos = 0
  while ($pos -le $bytes.Length - $oldBytes.Length) {
    $match = $true
    for ($i = 0; $i -lt $oldBytes.Length; $i++) {
      if ($bytes[$pos + $i] -ne $oldBytes[$i]) { $match = $false; break }
    }
    if ($match) { $offsets.Add($pos); $pos += $oldBytes.Length } else { $pos++ }
  }
  if ($offsets.Count -ne $expect) {
    Remove-Item $staged -Force
    throw "Marker count drifted ($($offsets.Count) vs $expect)"
  }
  $fs = [System.IO.File]::Open($staged, 'Open', 'Write', 'None')
  try {
    foreach ($off in $offsets) {
      $fs.Seek($off, 'Begin') | Out-Null
      $fs.Write($newBytes, 0, $newBytes.Length)
    }
  } finally { $fs.Close() }
}

# 4. Rename-swap (same trick as apply — running .exe is locked)
$ts   = [DateTimeOffset]::Now.ToUnixTimeSeconds()
$tomb = "$Bin.replacing.$ts"
try {
  Rename-Item $Bin $tomb
  Move-Item   $staged $Bin
} catch {
  if (Test-Path $tomb)   { Rename-Item $tomb $Bin -ErrorAction SilentlyContinue }
  if (Test-Path $staged) { Remove-Item $staged -Force -ErrorAction SilentlyContinue }
  throw
}
Remove-Item $tomb -Force -ErrorAction SilentlyContinue

# 5. Verify reverted — generic
$final = & $Node $ScanJs $Bin --json | ConvertFrom-Json
if ($final.anchorCount -ge 1 -and $final.markerCount -eq 0) {
  Write-Host "Reverted successfully (anchor=$($final.anchorCount) marker=0)"
} else {
  throw "Revert verification failed (anchor=$($final.anchorCount) marker=$($final.markerCount))"
}
```

## Verification

### Unix (bash) — expects ≥ 1

```bash
grep -c -a -F 'RTK-SUBAGENT-PATCH' "$(which claude)"
# Expected: 2 on macOS ≤ 2.1.132, 1 on macOS ≥ 2.1.133 (incl. 2.1.170, 2.1.176), 1 on Linux (so far)
```

### Windows (PowerShell) — expects ≥ 1

```powershell
$Bin    = (Get-Command claude).Source
$Node   = (Get-Command node).Source
$ScanJs = "$env:USERPROFILE\.claude\skills\claude-patch\patches\scan-bin.js"
$state  = & $Node $ScanJs $Bin --json | ConvertFrom-Json
"$($state.state) (anchor=$($state.anchorCount) marker=$($state.markerCount))"
# Expected: "patched (anchor=0 marker=N)" where N is the bundle multiplicity (currently 1 on all observed Windows builds)
```

### Functional test (any platform)

In a fresh Claude Code session, spawn an Agent with a full model ID:
```
model: "claude-haiku-4-5-20251001"
```
Should succeed instead of failing schema validation.

## Post-patch behavior

- `model` field accepts any string at the Task tool input layer.
- Schema validation reads disk-binary state at each Agent invocation — the patch takes effect immediately on the next subagent spawn, no Claude Code restart required.
- Downstream Claude Code resolver does substring matching (`be1` function): if the model id contains `opus`/`sonnet`/`haiku`, it routes to the corresponding default. Full model IDs that include those substrings (e.g., `claude-haiku-4-5-20251001`) get routed to the matching family.
- Model IDs that don't match any family (e.g., `gpt-5.4-mini`) gracefully fall back to parent-inherit, NOT an API error. Don't rely on garbage IDs producing visible errors — they'll silently run on the parent's model.

## Caveats

1. **macOS signing** — re-sign with ad-hoc codesign resolves it. May trigger Gatekeeper on first launch.
2. **Windows signing** — Authenticode signature becomes `HashMismatch` after patching. Binary still runs; restart Claude Code to pick up the patched file.
3. **Windows file lock** — patching uses rename-swap. The displaced original may stay on disk until the running process exits; clean up `*.replacing.*` files after restart if any remain.
4. **Auto-update** — new Claude Code version = new binary. Re-apply per version. The fingerprint can change shape in two independent ways: (a) the **anchor** — 2.1.170 added `"fable"` to the enum, changing it from 32 to 40 bytes; (b) the **context guard** — 2.1.176 left the anchor untouched but flipped the post-guard's `.describe()` quote from `"` to a backtick (the guard is now quote-agnostic to absorb this). When a version stops matching, re-inspect the binary around `model:` / `Optional model override for this agent.` to recover the current enum and rebuild the length-preserving replacement.
5. **Backup rotation** — each apply creates a `.bak.<ts>` file (~210 MB). After confirming a new version works, delete older backups:
   - Windows: `Get-ChildItem "$env:USERPROFILE\.local\bin\claude.exe.bak.*" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | Remove-Item`
   - Unix: `ls -t "$BIN".bak.* | tail -n +3 | xargs -r rm`
6. **Silent fallback for garbage IDs** — model strings that don't match `opus`/`sonnet`/`haiku` substrings inherit from parent rather than producing a visible error. If you typo a model id, you may not notice until you check usage / `--debug` logs. (Original spec said "API 400/404"; empirical behavior is silent fallback — verified on 2.1.133 macOS.)
7. **Bundle count is not stable** — macOS used 2-instance bundles up to 2.1.132 and switched to 1-instance from 2.1.133. Windows is 1-instance on all observed versions. State detection treats any positive anchor count as "unpatched" rather than asserting a fixed number.
8. **Backup may be from a different sub-build** — Claude Code occasionally re-bundles within the same dot-version (different bytes, same `--version` string). The revert script size-checks `.bak` files and falls back to in-place reverse-patch when no backup matches the current build size.

## Changelog

| Date | Version | Note |
|------|---------|------|
| 2026-05-06 | 1.0 | Initial — tested on 2.1.116, 2.1.119, 2.1.121 |
| 2026-05-08 | 1.1 | Windows port — single-instance bundle, rename-swap for file-lock, Node-based scanner, signature left invalid |
| 2026-05-08 | 1.1.1 | Self-review fixes: Windows scripts self-contained, `[DateTimeOffset]` instead of `Get-Date -UFormat`, parallel Unix/Windows verification blocks, backup rotation hint |
| 2026-06-10 | 1.3.0 | **2.1.170 anchor change.** Anthropic added a fourth model alias (`"fable"`) to the Task-tool enum, changing the anchor from `.enum(["sonnet","opus","haiku"])` (32 bytes) to `.enum(["sonnet","opus","haiku","fable"])` (40 bytes). Old anchor count dropped to 0 → previous patch no longer matched. Updated primary anchor, replacement (now `.string()/*RTK-SUBAGENT-PATCH*/` + 9 trailing spaces = 40 bytes), all bash/PowerShell length assertions (32→40), and `scan-bin.js` ANCHOR. Pre-2.1.170 3-enum kept as historical/fallback. Single-instance bundle, anchor count 1; context guard (`subagent_type...model:` before, `Optional model override` after) unchanged and still validates — note the byte before the anchor is now the minified Zod alias `k`. Verified end-to-end on macOS 2.1.170 arm64 (patch + ad-hoc codesign + marker self-verify). |
| 2026-06-13 | 1.4.0 | **2.1.176 context-guard change (anchor unchanged).** The 40-byte 4-enum anchor and the length-preserving replacement are byte-identical to 2.1.170 (count 1, unpatched=`1/0`), so the patch/replacement bytes did not change. But Anthropic expanded the `model` field's `.describe()` text — it now reads *"Optional model override for this agent. Takes precedence over the agent definition's model frontmatter…"* and mentions `subagent_type: "fork"` — and because that text contains an apostrophe and an embedded `"`, the minifier emitted it as a **backtick template literal** instead of a `"`-quoted string. The old post-guard `.optional().describe("Optional model override…` no longer matched (`postMatch=false`), so both the bash Python guard and `scan-bin.js` would have aborted at the context-guard step. Fix: made the post-guard **quote-agnostic** — match the stable prefix `.optional().describe(` plus the stable substring `Optional model override for this agent.`, ignoring the quote byte. Updated `scan-bin.js` (`POST` → `POST_PREFIX`/`POST_DESC`), the bash guard, fingerprint docs, and caveat #4. **Also fixed a latent bash bug** surfaced during verification: the detection greps (`EN=$(grep …)`, `PT=$(grep …)`) had no `|| true`, so on a clean unpatched binary the marker grep returned exit 1, and `set -o pipefail` + `set -e` killed the script at the assignment *before the first echo* — detection never completed on any fresh binary. Added `|| true` to every count-grep assignment in both the apply and revert scripts (the assignment still captures `wc`'s count; `|| true` only swallows grep's no-match status). Verified end-to-end on macOS 2.1.176 arm64 (patch + ad-hoc codesign + marker self-verify). |
| 2026-05-09 | 1.2.0 | Bundle count made dynamic on both platforms. macOS 2.1.133 switched from 2-instance to 1-instance bundle — old hard-coded `hits == 2` assertion would classify it as "abnormal" and abort. State detection now treats any positive anchor count as unpatched on both Unix and Windows; PowerShell apply loops over all anchor offsets instead of only the first. Added in-place reverse-patch fallback to both bash and PowerShell revert scripts, triggered when no `.bak.<ts>` matches current binary size (different sub-build). Post-patch behavior corrected: schema validation reads disk binary per Agent spawn (no restart needed), and unknown model IDs silently fall back to parent-inherit instead of API-failing. Tested on macOS 2.1.132 (2-instance) and 2.1.133 (1-instance); Windows scripts updated symmetrically but not retested on Windows since 1.1.1. |
