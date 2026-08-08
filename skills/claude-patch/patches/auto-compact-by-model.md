# Patch: auto-compact-by-model

Set model-aware auto-compaction targets for extended-context sessions: approximately **400K actual context tokens for `claude-*`** and **300K for `gpt-*`**, while retaining `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as the fallback for other models.

## Metadata

| Field | Value |
|-------|-------|
| Author | @huybuidac |
| Tested versions | 2.1.208 (macOS arm64, single bundle embed) |
| Risk level | medium |
| Reversible | yes (backup + in-place reverse-patch fallback) |
| Platforms | macOS arm64 tested; macOS x86_64/Linux/Windows scripts included but their 2.1.208 bundle fingerprint is unverified |

## Motivation

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` is process-wide. A session that mixes Claude and non-Claude models — especially main/subagent combinations enabled by the `subagent-model` patch — cannot assign different compact thresholds to each model family.

Claude Code 2.1.208 already passes the active model into one central compaction-window resolver. This patch replaces that resolver's scalar-env block with model-aware logic, so each main conversation or subagent computes its target from its own model without mutating shared process environment state.

### Target versus internal window

In 2.1.208 the default trigger path is approximately:

```text
actual trigger = configured compact window
               - min(model max-output tokens, 20000)
               - 13000
```

With the normal output reserve capped at 20K:

| Model family | Patched internal window | Approximate actual trigger |
|---|---:|---:|
| `claude-*` extended context | 433000 | 400000 |
| `gpt-*` extended context | 333000 | 300000 |

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can still cause earlier compaction, matching upstream behavior. A custom max-output value below 20K can shift the observed trigger slightly later.

## Scope and precedence

The replacement runs inside the 2.1.208 `DV(model, configured)` resolver:

1. If the resolved model context ceiling is greater than 200K and the normalized model starts with `gpt-`, use internal window `333000`.
2. Otherwise, if the ceiling is greater than 200K and the model starts with `claude-`, use `433000`.
3. Otherwise, use numeric `CLAUDE_CODE_AUTO_COMPACT_WINDOW` when present, preserving its 100K floor and the model-context ceiling.
4. If none match, fall through to the untouched settings/clientdata/experiment/model-default/auto branches.

Matched extended-context Claude/GPT rules intentionally take precedence over the global scalar. This allows an existing value such as `290000` to remain configured as the fallback for nonmatching models.

## Fingerprint

> **Version-specific:** the algorithm is stable between 2.1.207 and 2.1.208, but minified aliases changed. This exact anchor is for 2.1.208 only. A future version must be re-inspected rather than patched blind.

### Anchor pattern (258 bytes)

```js
if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}
```

- Length: **258 bytes**
- Observed count on 2.1.208 macOS arm64: **1**
- Observed offset: **219400482** (`0xd135a22`); the scripts discover offsets dynamically and never depend on this number.

### Context guard

The anchor itself is the complete scalar-env branch and is unique. Additionally, within 700 bytes immediately after it, all of these stable resolver source literals must appear:

```text
source:"settings"
source:"clientdata"
source:"experiment"
source:"model-default"
source:"auto"
```

This distinguishes the active compaction resolver from the other occurrences of the env-var name in documentation, exported constants, and embedded data.

### Stability notes

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` appears multiple times in the binary; only the full 258-byte block above occurs once on 2.1.208.
- The minified names `ODe`, `bZn`, and `DJi` are not stable across versions. They are included because the whole original block is the exact reverse-patch payload, not because their names are trusted as semantic identifiers.
- The context guard uses stable string values from the resolver's return objects.
- Bundle multiplicity is detected dynamically. Any positive anchor count is accepted only when every occurrence passes its guard.

## Replacement

The semantic replacement before padding is:

```js
{let E=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,T=o>2e5?r.startsWith("gpt-")?333000:r.startsWith("claude-")?433000:+E:+E;if(T>0){T=Math.max(1e5,T);return{window:Math.min(o,T),configured:T,source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}
```

It is **231 bytes**. Insert **27 ASCII spaces immediately before `*/`** in the marker comment to make the replacement exactly 258 bytes:

```text
/*RTK-AUTOCOMPACT-PATCH<27 spaces>*/
```

The scripts construct this padding programmatically and assert `len(old) == len(new) == 258` before writing.

### Patch marker

```text
RTK-AUTOCOMPACT-PATCH
```

## State detection

Generic — works with any future bundle multiplicity as long as every anchor has the expected guard:

| Anchor count | Marker count | State | Action |
|---|---|---|---|
| ≥ 1 | 0 | **Unpatched** | Validate every guard, record count, patch all |
| 0 | ≥ 1 | **Patched** | Skip |
| ≥ 1 | ≥ 1 | **Abnormal** | Abort — mixed/partial patch |
| 0 | 0 | **Abnormal** | Abort — fingerprint changed |

Unix detection:

```bash
OLD='if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}'
MARKER='RTK-AUTOCOMPACT-PATCH'
EN=$(grep -ao -F "$OLD" "$BIN" | wc -l | tr -d ' ') || true
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true
```

Windows/fallback detection:

```powershell
$state = & $Node $ScanJs $Bin --patch auto-compact-by-model --json | ConvertFrom-Json
```

## Patch script

### macOS / Linux (bash)

```bash
#!/usr/bin/env bash
set -euo pipefail

BIN="${1:?Usage: $0 <path-to-claude-binary>}"
OLD='if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}'
MARKER='RTK-AUTOCOMPACT-PATCH'

resign_if_macos() {
  if [ "$(uname -s)" = "Darwin" ]; then
    codesign --remove-signature "$BIN" 2>/dev/null || true
    codesign --force --sign - "$BIN"
    codesign --verify "$BIN" 2>&1
  fi
}

# 1. Detect state. `|| true` is required because grep exits 1 on no-match,
# which would otherwise terminate the script under set -e + pipefail.
EN=$(grep -ao -F "$OLD" "$BIN" | wc -l | tr -d ' ') || true
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true

if   [ "$EN" -ge 1 ] && [ "$PT" -eq 0 ]; then
  EXPECT="$EN"
  echo "Status: unpatched (anchor=$EN) — proceeding"
elif [ "$EN" -eq 0 ] && [ "$PT" -ge 1 ]; then
  echo "Already patched (marker=$PT), nothing to do"
  exit 0
else
  echo "Abnormal state (anchor=$EN marker=$PT) — aborting"
  exit 1
fi

# 2. Guard every occurrence before any write.
python3 - "$BIN" "$EXPECT" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
expect = int(sys.argv[2])
data = p.read_bytes()
old = b'if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}'
required = [
    b'source:"settings"',
    b'source:"clientdata"',
    b'source:"experiment"',
    b'source:"model-default"',
    b'source:"auto"',
]
pos = 0
hits = 0
while True:
    at = data.find(old, pos)
    if at < 0:
        break
    hits += 1
    after = data[at + len(old):at + len(old) + 700]
    missing = [x for x in required if x not in after]
    assert not missing, f"context-after mismatch at offset {at}: missing {missing}"
    pos = at + 1
assert hits == expect, f"expected {expect} anchors, got {hits}"
print(f"Context guard passed ({hits} anchor[s])")
PY

# 3. Backup before modifying anything.
BACKUP="$BIN.bak.$(date +%s)"
cp "$BIN" "$BACKUP"
echo "Backup: $BACKUP"
rollback() {
  echo "ERROR: restoring $BACKUP"
  cp "$BACKUP" "$BIN"
  resign_if_macos || true
}
trap rollback ERR

# 4. Exact-length replacement.
python3 - "$BIN" "$EXPECT" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
expect = int(sys.argv[2])
data = p.read_bytes()
old = b'if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}'
base = b'{let E=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,T=o>2e5?r.startsWith("gpt-")?333000:r.startsWith("claude-")?433000:+E:+E;if(T>0){T=Math.max(1e5,T);return{window:Math.min(o,T),configured:T,source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}'
pad = len(old) - len(base)
assert pad >= 0, f"replacement exceeds anchor by {-pad} bytes"
new = base.replace(b'*/', b' ' * pad + b'*/', 1)
assert len(old) == len(new) == 258
hits = data.count(old)
assert hits == expect, f"anchor count changed between detect and patch ({hits} vs {expect})"
data = data.replace(old, new)
p.write_bytes(data)
print(f"Patched {hits} occurrence(s); marker padding={pad} bytes")
PY

# 5. Re-sign on macOS and verify.
resign_if_macos
echo "Signature verified"

# 6. Self-verify.
EN=$(grep -ao -F "$OLD" "$BIN" | wc -l | tr -d ' ') || true
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true
if [ "$EN" -eq 0 ] && [ "$PT" -eq "$EXPECT" ]; then
  trap - ERR
  echo "Verified: patch applied successfully (marker=$PT)"
  echo "Restart Claude Code to load the patched binary."
else
  echo "Self-verify failed (anchor=$EN marker=$PT expected marker=$EXPECT)"
  exit 1
fi
```

### Windows (PowerShell)

> The exact 2.1.208 Windows anchor has not been tested. The scanner must report `unpatched` and every context guard must pass or this script aborts before backup/write.

```powershell
$ErrorActionPreference = 'Stop'

$Bin = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $Bin) { $Bin = "$env:USERPROFILE\.local\bin\claude.exe" }
if (-not (Test-Path $Bin)) { throw "claude.exe not found at $Bin" }

$ScanJs = Join-Path $PSScriptRoot 'scan-bin.js'
if (-not (Test-Path $ScanJs)) {
  $ScanJs = "$env:USERPROFILE\.claude\skills\claude-patch\patches\scan-bin.js"
}
if (-not (Test-Path $ScanJs)) { throw 'scan-bin.js not found' }

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $Node)) { throw 'node.exe not found' }

$Old = 'if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}'
$Base = '{let E=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,T=o>2e5?r.startsWith("gpt-")?333000:r.startsWith("claude-")?433000:+E:+E;if(T>0){T=Math.max(1e5,T);return{window:Math.min(o,T),configured:T,source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}'
$Marker = 'RTK-AUTOCOMPACT-PATCH'
$utf8 = [System.Text.Encoding]::UTF8
$pad = $utf8.GetByteCount($Old) - $utf8.GetByteCount($Base)
if ($pad -lt 0) { throw "Replacement exceeds anchor by $(-$pad) bytes" }
$New = $Base.Replace('*/', ((' ' * $pad) + '*/'))
if ($utf8.GetByteCount($Old) -ne 258 -or $utf8.GetByteCount($New) -ne 258) {
  throw 'Old/new replacement must both be 258 bytes'
}

# 1. Detect + guard.
$state = & $Node $ScanJs $Bin --patch auto-compact-by-model --json | ConvertFrom-Json
if ($state.state -eq 'patched') {
  Write-Host "Already patched (marker=$($state.markerCount)), nothing to do"
  exit 0
}
if ($state.state -ne 'unpatched' -or $state.anchorCount -lt 1) {
  throw "State=$($state.state) anchor=$($state.anchorCount) marker=$($state.markerCount) — aborting"
}
$expect = [int]$state.anchorCount
$offsets = @()
foreach ($g in $state.contextGuards) {
  if (-not $g.preMatch -or -not $g.postMatch) {
    throw "Context guard failed at offset $($g.offset)"
  }
  $offsets += [int64]$g.offset
}

# 2. Backup.
$ts = [DateTimeOffset]::Now.ToUnixTimeSeconds()
$backup = "$Bin.bak.$ts"
Copy-Item $Bin $backup
Write-Host "Backup: $backup"

# 3. Patch and verify a sidecar copy.
$temp = "$Bin.patching"
Copy-Item $Bin $temp -Force
$newBytes = $utf8.GetBytes($New)
$fs = [System.IO.File]::Open($temp, 'Open', 'Write', 'None')
try {
  foreach ($off in $offsets) {
    $fs.Seek($off, 'Begin') | Out-Null
    $fs.Write($newBytes, 0, $newBytes.Length)
  }
} finally { $fs.Close() }

$verify = & $Node $ScanJs $temp --patch auto-compact-by-model --json | ConvertFrom-Json
if ($verify.anchorCount -ne 0 -or $verify.markerCount -ne $expect) {
  Remove-Item $temp -Force
  throw "Patched-copy verification failed (anchor=$($verify.anchorCount) marker=$($verify.markerCount))"
}

# 4. Rename-swap because a running claude.exe is locked.
$tomb = "$Bin.replacing.$ts"
try {
  Rename-Item $Bin $tomb
  Move-Item $temp $Bin
} catch {
  if (Test-Path $tomb) { Rename-Item $tomb $Bin -ErrorAction SilentlyContinue }
  if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
  throw
}
Remove-Item $tomb -Force -ErrorAction SilentlyContinue

$final = & $Node $ScanJs $Bin --patch auto-compact-by-model --json | ConvertFrom-Json
if ($final.anchorCount -ne 0 -or $final.markerCount -ne $expect) {
  throw "Final verification failed (anchor=$($final.anchorCount) marker=$($final.markerCount))"
}

$sig = Get-AuthenticodeSignature $Bin
Write-Host "Verified: patch applied ($($final.markerCount) marker[s])"
Write-Host "Authenticode: $($sig.Status) (HashMismatch is expected after patching)"
Write-Host 'Restart Claude Code to load the patched binary.'
```

## Revert script

### macOS / Linux (bash)

The revert prefers the newest backup that scans as **unpatched for this patch** and reports the same Claude Code version. On macOS, replacing Anthropic's signature with an ad-hoc signature changes the binary size, so size equality is preferred but is not required when version + fingerprint match. Otherwise it performs an exact 258-byte reverse-patch. A pre-revert safety snapshot is always created.

```bash
#!/usr/bin/env bash
set -euo pipefail

BIN="${1:?Usage: $0 <path-to-claude-binary>}"
OLD='if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}'
MARKER='RTK-AUTOCOMPACT-PATCH'

PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true
[ "$PT" -lt 1 ] && echo "Binary is not patched (marker=$PT)" && exit 1
EXPECT="$PT"

CUR_SZ=$(stat -f%z "$BIN" 2>/dev/null || stat -c%s "$BIN")
CUR_VER=$("$BIN" --version 2>/dev/null || true)
BACKUP=""
for cand in $(ls -t "$BIN".bak.* 2>/dev/null); do
  CAND_SZ=$(stat -f%z "$cand" 2>/dev/null || stat -c%s "$cand")
  CAND_VER=$("$cand" --version 2>/dev/null || true)
  CAND_EN=$(grep -ao -F "$OLD" "$cand" | wc -l | tr -d ' ') || true
  CAND_PT=$(grep -ao -F "$MARKER" "$cand" | wc -l | tr -d ' ') || true
  if [ "$CAND_VER" = "$CUR_VER" ] && [ "$CAND_EN" -ge 1 ] && [ "$CAND_PT" -eq 0 ]; then
    [ "$CAND_SZ" -ne "$CUR_SZ" ] && echo "  Accepting $cand despite size change ($CAND_SZ vs $CUR_SZ; signature layout differs)"
    BACKUP="$cand"
    break
  fi
done

SAFETY="$BIN.preRevert.$(date +%s)"
cp "$BIN" "$SAFETY"
echo "Safety snapshot: $SAFETY"

if [ -n "$BACKUP" ]; then
  echo "Restoring backup: $BACKUP"
  cp "$BACKUP" "$BIN"
else
  echo "No matching unpatched backup — reverse-patching in place"
  python3 - "$BIN" "$EXPECT" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
expect = int(sys.argv[2])
data = p.read_bytes()
old = b'if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}'
base = b'{let E=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,T=o>2e5?r.startsWith("gpt-")?333000:r.startsWith("claude-")?433000:+E:+E;if(T>0){T=Math.max(1e5,T);return{window:Math.min(o,T),configured:T,source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}'
pad = len(old) - len(base)
patched = base.replace(b'*/', b' ' * pad + b'*/', 1)
assert len(old) == len(patched) == 258
hits = data.count(patched)
assert hits == expect, f"patched block count drifted ({hits} vs {expect})"
data = data.replace(patched, old)
p.write_bytes(data)
print(f"Reverse-patched {hits} occurrence(s)")
PY
fi

if [ "$(uname -s)" = "Darwin" ]; then
  codesign --remove-signature "$BIN" 2>/dev/null || true
  codesign --force --sign - "$BIN"
  codesign --verify "$BIN" 2>&1
fi

EN=$(grep -ao -F "$OLD" "$BIN" | wc -l | tr -d ' ') || true
PT=$(grep -ao -F "$MARKER" "$BIN" | wc -l | tr -d ' ') || true
if [ "$EN" -ge 1 ] && [ "$PT" -eq 0 ]; then
  echo "Reverted successfully (anchor=$EN marker=0)"
else
  echo "Revert verification failed (anchor=$EN marker=$PT)"
  exit 1
fi
```

### Windows (PowerShell)

```powershell
$ErrorActionPreference = 'Stop'

$Bin = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $Bin) { $Bin = "$env:USERPROFILE\.local\bin\claude.exe" }
$ScanJs = Join-Path $PSScriptRoot 'scan-bin.js'
if (-not (Test-Path $ScanJs)) { $ScanJs = "$env:USERPROFILE\.claude\skills\claude-patch\patches\scan-bin.js" }
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

$Old = 'if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}'
$Base = '{let E=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,T=o>2e5?r.startsWith("gpt-")?333000:r.startsWith("claude-")?433000:+E:+E;if(T>0){T=Math.max(1e5,T);return{window:Math.min(o,T),configured:T,source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}'
$Marker = 'RTK-AUTOCOMPACT-PATCH'
$utf8 = [System.Text.Encoding]::UTF8
$pad = $utf8.GetByteCount($Old) - $utf8.GetByteCount($Base)
$Patched = $Base.Replace('*/', ((' ' * $pad) + '*/'))

$state = & $Node $ScanJs $Bin --patch auto-compact-by-model --json | ConvertFrom-Json
if ($state.state -ne 'patched' -or $state.markerCount -lt 1) {
  throw "Not patched (state=$($state.state) marker=$($state.markerCount))"
}
$expect = [int]$state.markerCount
$curSize = (Get-Item $Bin).Length
$backup = $null
foreach ($cand in (Get-ChildItem "$Bin.bak.*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
  if ($cand.Length -ne $curSize) { continue }
  $candidate = & $Node $ScanJs $cand.FullName --patch auto-compact-by-model --json | ConvertFrom-Json
  if ($candidate.state -eq 'unpatched') { $backup = $cand; break }
}

$ts = [DateTimeOffset]::Now.ToUnixTimeSeconds()
$safety = "$Bin.preRevert.$ts"
Copy-Item $Bin $safety
Write-Host "Safety snapshot: $safety"
$staged = "$Bin.reverting"

if ($backup) {
  Copy-Item $backup.FullName $staged -Force
  Write-Host "Restoring backup: $($backup.FullName)"
} else {
  Copy-Item $Bin $staged -Force
  $patchedBytes = $utf8.GetBytes($Patched)
  $oldBytes = $utf8.GetBytes($Old)
  $bytes = [System.IO.File]::ReadAllBytes($staged)
  $offsets = New-Object System.Collections.Generic.List[int64]
  $pos = 0
  while ($pos -le $bytes.Length - $patchedBytes.Length) {
    $match = $true
    for ($i = 0; $i -lt $patchedBytes.Length; $i++) {
      if ($bytes[$pos + $i] -ne $patchedBytes[$i]) { $match = $false; break }
    }
    if ($match) { $offsets.Add($pos); $pos += $patchedBytes.Length } else { $pos++ }
  }
  if ($offsets.Count -ne $expect) { throw "Patched block count drifted ($($offsets.Count) vs $expect)" }
  $fs = [System.IO.File]::Open($staged, 'Open', 'Write', 'None')
  try {
    foreach ($off in $offsets) {
      $fs.Seek($off, 'Begin') | Out-Null
      $fs.Write($oldBytes, 0, $oldBytes.Length)
    }
  } finally { $fs.Close() }
}

$tomb = "$Bin.replacing.$ts"
try {
  Rename-Item $Bin $tomb
  Move-Item $staged $Bin
} catch {
  if (Test-Path $tomb) { Rename-Item $tomb $Bin -ErrorAction SilentlyContinue }
  if (Test-Path $staged) { Remove-Item $staged -Force -ErrorAction SilentlyContinue }
  throw
}
Remove-Item $tomb -Force -ErrorAction SilentlyContinue

$final = & $Node $ScanJs $Bin --patch auto-compact-by-model --json | ConvertFrom-Json
if ($final.state -ne 'unpatched') {
  throw "Revert verification failed (state=$($final.state) anchor=$($final.anchorCount) marker=$($final.markerCount))"
}
Write-Host "Reverted successfully (anchor=$($final.anchorCount) marker=0)"
```

## Verification

### Scanner

```bash
node skills/claude-patch/patches/scan-bin.js "$(python3 -c 'import os,shutil; print(os.path.realpath(shutil.which("claude")))')" --patch auto-compact-by-model --json
```

Expected after patch:

```text
state = patched
anchorCount = 0
markerCount >= 1
```

### macOS signature and launch

```bash
BIN=$(python3 -c 'import os,shutil; print(os.path.realpath(shutil.which("claude")))')
codesign --verify --verbose "$BIN"
"$BIN" --version
```

### Functional behavior

Start a **fresh Claude Code process** after patching. Existing processes keep the old memory-mapped executable.

- `claude-*[1M]`: internal compact window 433K, normal actual trigger approximately 400K.
- `gpt-*[1M]`: internal compact window 333K, normal actual trigger approximately 300K.
- Nonmatching/standard-context model: falls back to the existing numeric `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or upstream resolver logic.
- If `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, the resolved ceiling stays at 200K and the per-family extended-context rules do not activate.

## Post-patch behavior

- Model-specific thresholds are computed per invocation from the resolver's `model` argument; concurrently running main conversations/subagents do not race through shared env mutation.
- The raw model context ceiling remains unchanged. The patch only changes the compaction-window layer.
- The global scalar remains useful as the fallback for nonmatching models, but no longer overrides the two extended-context family rules.
- Restart Claude Code after apply/revert. A running process continues executing the binary it already mapped.

## Caveats

1. **Version-specific fingerprint** — tested only on macOS arm64 2.1.208. Auto-update installs a fresh binary and minified aliases can change even when the algorithm does not.
2. **Approximate actual thresholds** — the 433K/333K compensation assumes the normal 20K output reserve plus 13K compact buffer. Percentage overrides or a smaller max-output setting can compact earlier/later.
3. **Numeric scalar compatibility** — the fallback accepts the documented plain numeric `CLAUDE_CODE_AUTO_COMPACT_WINDOW` format. Undocumented parser formats are not preserved.
4. **Source label** — model-derived targets reuse `source:"env"` to stay within the fixed byte budget and an already-supported source value.
5. **macOS signing** — the original Anthropic signature is replaced by an ad-hoc signature. The backup retains the original bytes/signature.
6. **Windows signing** — Authenticode becomes `HashMismatch`; SmartScreen/AppLocker policy may reject modified binaries.
7. **Backup size** — each apply creates a full binary backup (~230 MB). Rotate old backups only after verifying the current version.
8. **Other patches** — backup restore returns to the exact state immediately before this patch was applied. The Unix selector verifies the Claude version plus this patch's unpatched fingerprint; Windows also requires equal size. This avoids choosing a later backup that already contains the marker while tolerating macOS signature-size changes.

## Changelog

| Date | Version | Note |
|------|---------|------|
| 2026-07-14 | 1.0.0 | Initial 2.1.208 macOS arm64 patch: Claude extended context ≈400K actual trigger, GPT extended context ≈300K, global scalar fallback, backup/reverse-patch recovery, multi-patch scanner integration |
