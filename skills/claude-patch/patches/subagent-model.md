# Patch: subagent-model

Unlock the `model` parameter on the Agent/Task tool from a fixed model-alias enum to a plain string — enabling per-call model selection with full model IDs.

## Metadata

| Field | Value |
|-------|-------|
| Author | @huybuidac |
| Version | 1.7.0 |
| Tested versions | 2.1.116 → 2.1.233 macOS arm64; 2.1.x Windows arm64 (see [Changelog](#changelog)) |
| Risk level | low |
| Reversible | yes (sidecar reverse-patch, or backup) |
| Platforms | macOS (arm64/x86_64), Linux, Windows (arm64/x64) |

## Usage

```bash
node patch-bin.js scan   --patch subagent-model   # state, derived anchor, guards
node patch-bin.js apply  --patch subagent-model
node patch-bin.js revert --patch subagent-model
```

Add `--bin <path>` to target a binary other than the resolved `claude`. See [patch-bin.js](patch-bin.js) for what apply/revert do on each platform.

## Motivation

Claude Code hard-codes a Zod enum of model aliases in the Task tool's `inputSchema`. Passing a specific model ID (e.g. `claude-haiku-4-5-20251001`, `claude-opus-4-6[1M]`) is rejected at schema validation before reaching the API. The official `CLAUDE_CODE_SUBAGENT_MODEL` env var applies globally; this patch opens the gate for **per-call** selection.

## Scope: this enum is the only per-call gate

Re-verified through 2.1.233. The Agent/Task tool exposes **exactly one** model restriction — the Zod enum this patch targets. The `["sonnet","opus","haiku","fable"]` alias list appears 4× in the binary; the other three are a base constant (`vxd`) and two `/model`-picker label maps — data and UI, not gates.

Claude sometimes says things like *"gpt-5.5 isn't reachable from this session's Agent tooling"*. That is **not** a hard-coded string (grep for `Agent tooling` / `isn't reachable` → 0 hits); it is the model paraphrasing the enum it reads from the tool schema on an **unpatched** binary — usually one an auto-update just reset. Patching turns the enum into a plain string, the schema stops advertising a list, and the warning stops.

**Separate path, not this patch's concern:** the session-level validators governing `--model`, the `/model` picker, and the advisor — `Ya` (org `availableModels` allowlist), `GJt` (async validate → live server probe), `Osa`/`restrictedModel` (startup resolution). They never touch the Agent tool. Bypassing an org allowlist would be a separate patch against `Ya`.

## Fingerprint — derived, never hardcoded

The patch site has been rewritten by the minifier three times, and every hardcoded anchor has eventually matched 0 times (which state detection reports as "abnormal — fingerprint changed"). The anchor is therefore **derived** from the only thing that has never moved: the `.describe()` text of the sibling `subagent_type` field.

**Landmark** (`LM`, stable 2.1.116 → 2.1.233):

```
.optional().describe("The type of specialized agent to use for this task"),model:
```

**Derivation** — one pass, no version knowledge required:

| Step | Rule |
|---|---|
| 1 | Find every `LM`. The occurrence count **is** the bundle multiplicity. |
| 2 | **anchor** = bytes from the end of `LM` up to the next `.optional().describe(` |
| 3 | **stringExpr** = bytes between the preceding `subagent_type:` and the start of `LM` |
| 4 | post-guard: `Optional model override for this agent.` must appear within ~160 bytes after `.optional().describe(` |
| 5 | validate `anchor` against `^[\w$.]{0,12}\(\["sonnet","opus","haiku"(,"fable")?\]\)$` and `stringExpr` against `^[\w$.]{1,16}\(\)$` |

Why step 3 is safe: `subagent_type` is an unconstrained string schema declared in the **same statement**, so its factory expression is already proven valid in that exact lexical scope — it drops straight in where the enum was, with no separate lookup.

What the derivation yields per era (one rule, all eras):

| Version | anchor (derived) | stringExpr | len |
|---|---|---|---|
| ≤ 2.1.169 | `h.enum(["sonnet","opus","haiku"])` | `h.string()` | 33 |
| 2.1.170–2.1.223 | `v.enum(["sonnet","opus","haiku","fable"])` | `v.string()` | 41 |
| 2.1.224 | `xr(["sonnet","opus","haiku","fable"])` | `N()` | 37 |
| 2.1.233 | `Mr(["sonnet","opus","haiku","fable"])` | `F()` | 37 |

Four things have drifted independently — all are **outputs** of the derivation, never inputs:

1. **Enum content/length** — `"fable"` added at 2.1.170 (32 → 40 bytes of enum call).
2. **Call form** — method-chain (`X.enum([...])`) → destructured direct call (`xr([...])`) at 2.1.224, consistent with Zod's tree-shakable API.
3. **Minified aliases** — `h`/`v`/`xr`/`Mr` and `h.string()`/`N`/`F`, roughly every few builds.
4. **Quote style of the following `.describe()`** — flipped `"` → backtick at 2.1.176 when the text gained an apostrophe. The post-guard matches the prefix `.optional().describe(` plus the stable text, never the quote byte.

Bundle multiplicity is also unstable (macOS 2 instances ≤ 2.1.132, 1 since 2.1.133; Windows always 1) — hence step 1 counts rather than asserts.

## Replacement

```
replacement = stringExpr + "/*RTK-SUBAGENT-PATCH*/" right-padded with spaces to len(anchor)
```

Length-preserving by construction; requires `len(stringExpr) + 22 <= len(anchor)`, which holds in every era (tightest is ≤ 2.1.169: 10 + 22 = 32 ≤ 33). Result on 2.1.233:

```
model:F()/*RTK-SUBAGENT-PATCH*/            .optional().describe(`Optional model override…
```

Trailing spaces before `.optional()` are legal JS. The marker `RTK-SUBAGENT-PATCH` is identical in every era — only the padding width differs — so it detects a patched binary regardless of which version applied it. ("RTK" is a legacy name, kept for compatibility with already-patched binaries.)

## State detection

| Anchor count | Marker count | State | Action |
|---|---|---|---|
| ≥ 1 | 0 | **Unpatched** | Patch all; expect marker == anchor count |
| 0 | ≥ 1 | **Patched** | Skip |
| ≥ 1 | ≥ 1 | **Abnormal** (mixed) | Abort — partial/concurrent patch |
| 0 | 0 | **Abnormal** | Abort — landmark gone, re-inspect the binary |

`scan` exits 1 on `abnormal`. Its `--json` adds `landmarkCount`, `stringExpr`, `replacement`, and per-site `preMatch`/`postMatch` — enough to diagnose a new drift without a hex editor.

## Verification

```bash
node patch-bin.js scan --patch subagent-model
# after apply: State: patched   Anchor count: 0   Marker count: N (bundle multiplicity)
```

Functional test — in a fresh session, spawn an Agent with a full model ID (`model: "claude-haiku-4-5-20251001"`). It should be accepted instead of failing schema validation.

## Post-patch behavior

- The `model` field accepts any string at the Task tool input layer.
- Schema validation reads the disk binary at each Agent spawn, so the patch takes effect on the next subagent — **no restart required**.
- The downstream resolver does substring matching: an ID containing `opus`/`sonnet`/`haiku` routes to that family (so `claude-haiku-4-5-20251001` works).
- IDs matching no family (e.g. `gpt-5.4-mini`) **silently fall back to parent-inherit** — not an API error. A typo will not announce itself; check usage or `--debug` if a subagent seems to run on the wrong model.

## Caveats

1. **macOS signing** — apply/revert re-sign ad-hoc; Gatekeeper may prompt on first launch.
2. **Windows signing** — Authenticode becomes `HashMismatch`. The binary still runs; SmartScreen/AppLocker may flag it depending on policy.
3. **Auto-update resets the patch** — every new version ships a fresh unpatched binary. Re-apply per version. Because the anchor is derived, a new build normally needs no doc change; only a change to the landmark text itself would.
4. **Keep the sidecar** — `<bin>.rtk-subagent-model.json` is what makes an exact revert possible after aliases drift; a patched binary alone cannot reconstruct them.
5. **Backup rotation** — each apply leaves a ~290 MB `.bak.<ts>`. Prune: `ls -t "$BIN".bak.* | tail -n +3 | xargs -r rm`.

## Changelog

| Date | Version | Note |
|------|---------|------|
| 2026-05-06 | 1.0 | Initial — 2.1.116/119/121, 32-byte 3-alias enum, macOS 2-instance bundle. |
| 2026-05-08 | 1.1 | Windows port — 1-instance bundle, rename-swap for the file lock, Node scanner, signature left invalid. |
| 2026-05-09 | 1.2.0 | Bundle count made dynamic (2.1.133 switched macOS 2 → 1 instance, which the old `hits == 2` assertion called abnormal). Corrected post-patch behavior: no restart needed; unknown IDs silently inherit. |
| 2026-06-10 | 1.3.0 | 2.1.170 added `"fable"` to the enum (32 → 40 bytes); old anchor matched 0 times. |
| 2026-06-13 | 1.4.0 | 2.1.176 left the anchor identical but flipped the `.describe()` quote `"` → backtick (text gained an apostrophe), breaking the post-guard → made it quote-agnostic. Also fixed detection dying on clean binaries: `set -e` + `pipefail` + a no-match grep killed the script before its first echo. |
| 2026-07-07 | 1.5.0 | 2.1.198/2.1.201 byte-identical; no drift. Cataloged every model gate and documented that the Agent-tool enum is the only per-call one — the *"isn't reachable from this session's Agent tooling"* warning is the model paraphrasing an intact enum after an auto-update, not a new check. |
| 2026-07-15 | 1.5.1 | 2.1.210 verified, byte-identical. |
| 2026-08-08 | 1.6.0 | 2.1.224 changed the *call form*, not the content: Zod method-chains became destructured direct calls (`.enum([...])` → `xr([...])`, 40 → 37 bytes; `.string()` → `N()`). Anchor count read 0 → correctly aborted rather than patching blind. |
| 2026-08-15 | 1.7.0 | 2.1.233 drifted the aliases exactly as predicted (`xr` → `Mr`, `N` → `F`), so all three historical anchors matched 0 again. **Stopped hardcoding anchors**: anchor and replacement are now derived from the stable `subagent_type` landmark, one rule covering all four eras. Apply records the original bytes in a sidecar, since a patched binary alone cannot reconstruct a drifted alias. All shell/PowerShell scripts replaced by `patch-bin.js apply/revert`. Verified end-to-end on 2.1.233 macOS arm64: apply, stacked apply with auto-compact, independent revert of each, and a reverted binary byte-identical to the original outside the signature blob. |
