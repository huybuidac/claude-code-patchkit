# Patch: auto-compact-by-model

Set model-aware auto-compaction targets for extended-context sessions: approximately **400K actual context tokens for `claude-*`** and **300K for `gpt-*`**, keeping `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as the fallback for other models.

## Metadata

| Field | Value |
|-------|-------|
| Author | @huybuidac |
| Version | 1.2.0 |
| Tested versions | 2.1.208 macOS arm64 (functional, pre-1.2.0 replacement); derivation + guards verified on 2.1.226, 2.1.233, 2.1.239, 2.1.250. The 1.2.0 replacement is **not yet functionally tested on a live session** — see [Caveats](#caveats). |
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

The replacement runs inside the resolver `<F>(e, t, r = <G>())`, whose prologue binds
`let <model> = <H>(e), <ceil> = <I>(e, r)`:

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
| 3 | pre-guard: the preceding bytes must match `function <F>(e,t,r=<G>()){let <model>=<H>(e),<ceil>=<I>(e,r);`, **capturing** `<model>` and `<ceil>` |
| 4 | the anchor body must match the env-branch shape, capturing `<env>`, `<floor>`, `<res>` and the ceiling it narrows — with back-references, so the shape itself proves the bindings |
| 5 | cross-check: the ceiling captured in step 4 **must be the same local** as `<ceil>` from step 3 |
| 6 | post-guard: within 700 bytes after the anchor, all of `source:"settings"`, `source:"clientdata"`, `source:"experiment"`, `source:"model-default"`, `source:"auto"` **and** `.has(<model>)` must appear |

Steps 3–6 are the load-bearing ones, and the replacement bytes are **built from the captured names** rather than fixed.

Nothing here may assume which letters the bundler picked. The resolver's locals shifted from `n`/`o` on 2.1.239 to `o`/`u` on 2.1.250, and every hardcoded letter in the 1.1.0 derivation matched 0 times — reported as `abnormal — fingerprint changed` when in fact the algorithm was untouched.

Step 6's `.has(<model>)` is a semantic guard, not a shape guard: the resolver tests the model local against a `Set` of extended-context model ids, which is what proves that local holds a **string** before the replacement calls `.startsWith()` on it. Without it a reshuffled signature would produce a resolver that throws on every turn.

The env-var name appears ~17× in the binary (docs, exported constants, embedded data); the full derived block occurs once.

## Replacement

Assembled from the captured names — `<model>`, `<ceil>`, and the env branch's own `<env>`/`<res>` block locals, which are already proven collision-free in that scope:

```js
{let <env>=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,<res>=<ceil>>2e5?<model>.startsWith("gpt-")?333000:<model>.startsWith("claude-")?433000:+<env>:+<env>;if(<res>>0){<res>=Math.max(1e5,<res>);return{window:Math.min(<ceil>,<res>),configured:<res>,source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}
```

Concretely, 2.1.250 (`<model>`=`o`, `<ceil>`=`u`, `<env>`=`E`, `<res>`=`R`):

```js
{let E=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,R=u>2e5?o.startsWith("gpt-")?333000:o.startsWith("claude-")?433000:+E:+E;if(R>0){R=Math.max(1e5,R);return{window:Math.min(u,R),configured:R,source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}
```

Right-padded with spaces to the derived anchor length (258 bytes on 2.1.239, 246 on 2.1.250 — the drifted names are no longer uniformly 3 characters, so neither the anchor nor the replacement has a fixed size any more). Marker: `RTK-AUTOCOMPACT-PATCH`.

Note the replacement is a bare block, not an `if`: it deliberately drops the `if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)` test so the two family rules also apply when the env var is unset. With it unset and no family match, `+undefined` is `NaN`, `NaN>0` is false, and control falls through to the untouched branches.

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

1. **Functionally tested on 2.1.208 only, and that was the *old* replacement.** Later versions are verified to *derive and guard* correctly, not to behave correctly at runtime. The 1.2.0 replacement corrects which local supplies the model (see the changelog) and has been checked by extracting the generated bytes and executing them against a resolver-shaped stub — it parses, and returns 433000/333000/fallthrough as documented — but it has **not** been exercised in a live session. Confirm compaction actually triggers where you expect after applying.
2. **Approximate thresholds** — 433K/333K assume the normal 20K output reserve plus 13K compact buffer. Percentage overrides or a smaller max-output shift the real trigger.
3. **Numeric scalar only** — the fallback handles the documented plain-numeric `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; undocumented parser formats are not preserved.
4. **Source label** — model-derived targets reuse `source:"env"` to stay within the byte budget and an already-supported value.
5. **Signing** — macOS gets an ad-hoc signature (the backup keeps the original); Windows Authenticode becomes `HashMismatch`.
6. **Stacking** — independent of [subagent-model](subagent-model.md); each keeps its own sidecar and can be reverted without disturbing the other (verified on 2.1.233).

## Changelog

| Date | Version | Note |
|------|---------|------|
| 2026-07-14 | 1.0.0 | Initial 2.1.208 macOS arm64 patch: Claude extended context ≈400K actual trigger, GPT ≈300K, global scalar fallback, backup/reverse-patch recovery. |
| 2026-08-28 | 1.2.0 | **Replacement bytes now derived too, and a real bug fixed.** On 2.1.250 the resolver's locals shifted `n`/`o` → `o`/`u`; the 1.1.0 pre-guard and its `Math.min(o,c)` test both hardcoded those letters, so the scanner reported `abnormal — fingerprint changed` on an algorithm that had not changed. Worse, the 1.1.0 replacement read the model from `r` — but `r` is the capabilities/betas argument (also passed to `<I>(e,r)`, `<J>(e,r)`, `<K>(e,r)`), **not** a string; the model is the *first* local, the one the resolver uses as a `Set`/`Map` key. On 2.1.239 and 2.1.233 that replacement would have thrown `TypeError: r.startsWith is not a function` inside the compaction resolver. Both locals are now captured and the replacement assembled from them, with a `.has(<model>)` post-guard proving the model local is a string. Derivation verified on 2.1.239 and 2.1.250. |
| 2026-08-15 | 1.1.0 | **Anchor derived instead of hardcoded.** On 2.1.233 the 258-byte literal anchor matched 0 times and the scanner reported `abnormal — fingerprint changed`, when in fact only the minified names had drifted (`ODe`/`bZn`/`DJi` → `QKe`/`vQo`/`g_a`; `R3e`/`uPo`/`hHs` on 2.1.226). The anchor is now derived from the env-var landmark, and the prologue shape that the replacement depends on — `o` = ceiling, `r` = model — is checked explicitly rather than assumed. Shell/PowerShell scripts replaced by `patch-bin.js apply/revert`, which also writes a sidecar for exact reverts. Derivation and guards verified on 2.1.226 and 2.1.233; apply/revert exercised on a 2.1.233 copy (stacked with subagent-model, reverted independently, binary byte-identical outside the signature). |
