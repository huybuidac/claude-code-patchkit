# Patch: auto-compact-by-model

Set model-aware auto-compaction targets for extended-context sessions: approximately **400K actual context tokens for `claude-*`** and **300K for `gpt-*`**, keeping `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as the fallback for other models.

## Metadata

| Field | Value |
|-------|-------|
| Author | @huybuidac |
| Version | 1.1.0 |
| Tested versions | 2.1.208 macOS arm64 (functional); anchor derivation additionally verified on 2.1.226 and 2.1.233 |
| Risk level | medium |
| Reversible | yes (sidecar reverse-patch, or backup) |
| Platforms | macOS arm64 tested; Linux/Windows share the same code path but are unverified |

## Usage

```bash
node patch-bin.js scan   --patch auto-compact-by-model
node patch-bin.js apply  --patch auto-compact-by-model
node patch-bin.js revert --patch auto-compact-by-model
```

Restart Claude Code after apply or revert — a running process keeps executing the binary it already mapped.

## Motivation

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` is process-wide. A session mixing Claude and non-Claude models — especially the main/subagent combinations that [subagent-model](subagent-model.md) enables — cannot give each model family its own compact threshold.

Claude Code already passes the active model into one central compaction-window resolver. This patch replaces that resolver's scalar-env block with model-aware logic, so each conversation or subagent computes its target from its own model without mutating shared process state.

### Target versus internal window

The default trigger path is approximately:

```text
actual trigger = configured compact window - min(model max-output tokens, 20000) - 13000
```

With the normal 20K output reserve:

| Model family | Patched internal window | Approximate actual trigger |
|---|---:|---:|
| `claude-*` extended context | 433000 | 400000 |
| `gpt-*` extended context | 333000 | 300000 |

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can still compact earlier, matching upstream behavior. A max-output value below 20K shifts the observed trigger slightly later.

## Scope and precedence

The replacement runs inside the resolver `<F>(e, t, r = <G>())`:

1. Ceiling > 200K and model starts with `gpt-` → internal window `333000`.
2. Ceiling > 200K and model starts with `claude-` → `433000`.
3. Otherwise numeric `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, preserving its 100K floor and the model-context ceiling.
4. No match → falls through to the untouched settings/clientdata/experiment/model-default/auto branches.

The two extended-context rules intentionally outrank the global scalar, so an existing value such as `290000` stays configured as the fallback for non-matching models.

## Fingerprint — derived, never hardcoded

The resolver's **algorithm** is stable across versions, but its minified top-level names are not: the parse helper, floor constant, and validator were `ODe`/`bZn`/`DJi` on 2.1.208, `R3e`/`uPo`/`hHs` on 2.1.226, and `QKe`/`vQo`/`g_a` on 2.1.233. A literal anchor therefore rots every few builds, so the anchor is derived instead.

**Landmark:**

```
if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let 
```

**Derivation:**

| Step | Rule |
|---|---|
| 1 | Find every landmark occurrence. |
| 2 | **anchor** = landmark through the first following `source:"env"}}}` (the complete scalar-env branch) |
| 3 | post-guard: within 700 bytes after the anchor, all of `source:"settings"`, `source:"clientdata"`, `source:"experiment"`, `source:"model-default"`, `source:"auto"` must appear |
| 4 | pre-guard: the preceding bytes must match `function <F>(e,t,r=<G>()){let n=<H>(e),o=<I>(e,r);` |
| 5 | the anchor must contain `Math.min(o,c)` |

Steps 4–5 are the load-bearing ones. The replacement references **only positional locals** — `o` (context ceiling) and `r` (model) — which the bundler assigns by position rather than by name, which is why the same replacement bytes work across versions whose top-level names all changed. The pre-guard is what proves those bindings still hold; without it the patch would be assuming rather than checking, and a reshuffled signature would produce a resolver that throws on `r.startsWith`. `apply` refuses to write when it fails.

The env-var name appears ~17× in the binary (docs, exported constants, embedded data); the full derived block occurs once.

## Replacement

```js
{let E=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,T=o>2e5?r.startsWith("gpt-")?333000:r.startsWith("claude-")?433000:+E:+E;if(T>0){T=Math.max(1e5,T);return{window:Math.min(o,T),configured:T,source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}
```

231 bytes, right-padded with spaces to the derived anchor length (258 bytes on every version observed, since all the drifted names happen to be 3 characters). Marker: `RTK-AUTOCOMPACT-PATCH`.

## State detection

| Anchor count | Marker count | State | Action |
|---|---|---|---|
| ≥ 1 | 0 | **Unpatched** | Validate every guard, patch all |
| 0 | ≥ 1 | **Patched** | Skip |
| ≥ 1 | ≥ 1 | **Abnormal** | Abort — mixed/partial patch |
| 0 | 0 | **Abnormal** | Abort — fingerprint changed |

A patched binary reports `landmarkCount: 0`, because the replacement rewrites the `if(process.env…)` statement the landmark names. That is expected — marker count is what identifies the patched state.

## Verification

```bash
node patch-bin.js scan --patch auto-compact-by-model
codesign --verify --verbose "$(python3 -c 'import os,shutil; print(os.path.realpath(shutil.which("claude")))')"
```

Functional check in a **fresh** process:

- `claude-*[1M]`: internal window 433K, actual trigger ≈400K.
- `gpt-*[1M]`: internal window 333K, actual trigger ≈300K.
- Non-matching or standard-context model: falls back to `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or upstream logic.
- With `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` the ceiling stays at 200K and neither family rule activates.

## Post-patch behavior

- Thresholds are computed per invocation from the resolver's own model argument, so concurrent conversations and subagents do not race through shared env mutation.
- The raw model context ceiling is unchanged; only the compaction-window layer moves.
- The global scalar remains the fallback for non-matching models but no longer overrides the two family rules.

## Caveats

1. **Functionally tested on 2.1.208 only** — later versions are verified to *derive and guard* correctly, not to behave correctly at runtime. Confirm compaction actually triggers where you expect after applying to a new version.
2. **Approximate thresholds** — 433K/333K assume the normal 20K output reserve plus 13K compact buffer. Percentage overrides or a smaller max-output shift the real trigger.
3. **Numeric scalar only** — the fallback handles the documented plain-numeric `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; undocumented parser formats are not preserved.
4. **Source label** — model-derived targets reuse `source:"env"` to stay within the byte budget and an already-supported value.
5. **Signing** — macOS gets an ad-hoc signature (the backup keeps the original); Windows Authenticode becomes `HashMismatch`.
6. **Stacking** — independent of [subagent-model](subagent-model.md); each keeps its own sidecar and can be reverted without disturbing the other (verified on 2.1.233).

## Changelog

| Date | Version | Note |
|------|---------|------|
| 2026-07-14 | 1.0.0 | Initial 2.1.208 macOS arm64 patch: Claude extended context ≈400K actual trigger, GPT ≈300K, global scalar fallback, backup/reverse-patch recovery. |
| 2026-08-15 | 1.1.0 | **Anchor derived instead of hardcoded.** On 2.1.233 the 258-byte literal anchor matched 0 times and the scanner reported `abnormal — fingerprint changed`, when in fact only the minified names had drifted (`ODe`/`bZn`/`DJi` → `QKe`/`vQo`/`g_a`; `R3e`/`uPo`/`hHs` on 2.1.226). The anchor is now derived from the env-var landmark, and the prologue shape that the replacement depends on — `o` = ceiling, `r` = model — is checked explicitly rather than assumed. Shell/PowerShell scripts replaced by `patch-bin.js apply/revert`, which also writes a sidecar for exact reverts. Derivation and guards verified on 2.1.226 and 2.1.233; apply/revert exercised on a 2.1.233 copy (stacked with subagent-model, reverted independently, binary byte-identical outside the signature). |
