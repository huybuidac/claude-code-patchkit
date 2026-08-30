# Patch: resume-model

Stop `--resume` from discarding a session's model when this build does not recognise the id.

## Metadata

| Field | Value |
|-------|-------|
| Author | @huybuidac |
| Version | 1.0.0 |
| Tested versions | 2.1.250 macOS arm64 (derivation, apply, revert, binary runs); **resume itself not yet exercised** |
| Risk level | medium — the decline is removed, but what happens downstream is unverified |
| Reversible | yes (sidecar reverse-patch, or backup) |
| Platforms | macOS tested; Linux/Windows share the code path, untested |

## Usage

```bash
node patch-bin.js scan   --patch resume-model
node patch-bin.js apply  --patch resume-model
node patch-bin.js revert --patch resume-model
```

## Motivation

Resuming a session prints

```
Session model gpt-5.6-sol could not be restored
(not a model this version of Claude Code recognizes) — using claude-opus-5 instead.
```

and silently continues on the default model. The resume path re-validates the model id it reads back from the transcript against this build's own registry, so any id the build does not ship — a gateway-routed model, or one paired with [subagent-model](subagent-model.md) — is dropped on every resume. No setting reaches this check: `ANTHROPIC_MODEL` and a settings-level model override make the restore skip entirely rather than succeed.

## Fingerprint — derived, never hardcoded

The resume path walks the transcript backwards for the last assistant message, then grades its model through three tiers:

```js
let h = !(t.has(Ye(u))||xee(u)||br(u)===i) ? "unknown_family"
      : !Mp(u)&&!_r(u)                     ? "not_allowed"
      : QK(u)                              ? "retired"
      : void 0;
if (h) return {kind:"declined", model:u, reason:h};
```

**Landmark** — the reason tag, not the sentence. The user-visible text lives in a separate lookup table (`ge`), so wording can be reworded without touching the branch; the tag is what the branch itself emits.

```
?"unknown_family":
```

**Derivation:**

| Step | Rule |
|---|---|
| 1 | Find every landmark occurrence — the count **is** the bundle multiplicity, never assert a number |
| 2 | walk back to the nearest `let ` → **varName** is the text between it and the following `=` |
| 3 | **anchor** = bytes from just after that `=` to the next `;` |
| 4 | validate the anchor against `^.+\?"unknown_family":.+\?"not_allowed":([\w$.]{1,16}\([\w$]{1,8}\))\?"retired":void 0$` — the capture is the **retired call**, reused verbatim in the replacement |
| 5 | post-guard: the bytes after `;` must be `if(<varName>)return{kind:"declined",model:` |
| 6 | cross-file guard: `unknown_family:"not a model this version of Claude Code recognizes"` must exist in the binary |

Step 5 is what makes the patch safe on an untested build. Neutralising a ternary is only correct if the local it assigns is the one the decline branch reads, and the backreference on `varName` **checks** that rather than assuming the two statements belong together. Step 6 proves the tag still maps to the message this patch is named for, so a build that repurposed `unknown_family` for something else fails the guard instead of being patched.

Nothing in the anchor is assumed: `t`/`Ye`/`u`/`xee`/`br`/`Mp`/`_r`/`QK` are all minified and all module-local.

| Version | anchor (derived) | notes |
|---|---|---|
| 2.1.250 | `!(t.has(Ye(u))\|\|xee(u)\|\|br(u)===i)?"unknown_family":!Mp(u)&&!_r(u)?"not_allowed":QK(u)?"retired":void 0` | 103 bytes, 1 site, in `chunk-s6dvae69.js` |

## Replacement

```
replacement = `0` + `/*RTK-RESUME-MODEL*/`
            + `?"unknown_family":0?"not_allowed":` + <retired call> + `?"retired":void 0`
            right-padded with spaces to len(anchor)
```

77 bytes against a 103-byte anchor on 2.1.250 — 26 spaces of slack. The budget is structural rather than lucky: the replacement drops two conditions and keeps one, so it is shorter than the anchor by however long those two conditions were, and the only fixed cost is the 20-byte marker comment.

**Only the first two tiers are cut.** The retired call is captured and kept, so a model Anthropic has actually retired still declines here, with the message that explains why, instead of failing later against the API. Cutting it too would trade a clear client-side message for an opaque server error.

Marker: `RTK-RESUME-MODEL`, once per site.

## State detection

| Anchor count | Marker count | Bytecode slice | State | Action |
|---|---|---|---|---|
| ≥ 1 | 0 | any | Unpatched | Patch all sites |
| 0 | ≥ 1 | empty | Patched | Skip |
| 0 | ≥ 1 | non-empty | Patched-inert | Re-run `apply` — see [Bytecode shadowing](../SKILL.md#bytecode-shadowing) |
| ≥ 1 | ≥ 1 | any | Abnormal | Abort — partial/concurrent patch |
| 0 | 0 | any | Abnormal | Abort — landmark gone, re-derive |

The replacement **keeps the landmark**, so `landmarkCount` stays 1 after patching — unlike `subagent-model`, where it drops to 0. Derivation therefore rejects any anchor already containing the marker; without that, a replacement that happened to fill the anchor exactly would still satisfy the shape regex and the binary would read as `abnormal`.

## Verification

```bash
node patch-bin.js scan --patch resume-model
# after apply: State: patched   Anchor count: 0   Marker count: 1
#              Bytecode: /$bunfs/root/chunk-….js rec#N len=0 (disabled)
```

Functional test: resume a session whose last assistant message ran on an id this build does not ship (`claude --resume <id>`). The "could not be restored" line should not appear, and the session should continue on that model.

## Post-patch behavior

- The resume path returns `{kind:"ok", model}` for ids it previously declined as unknown or not-allowed.
- Restart is irrelevant here — the check runs at resume, so it is read fresh each time.
- Retired models still decline, with the retirement message.

## Caveats

1. **Downstream is unverified.** This patch only removes the decline. Whether the session then actually runs on the restored id depends on the session-level validators (org `availableModels` allowlist, the live server probe, startup model resolution), which this patch does not touch. It may turn out to move the failure rather than remove it — that is why the risk level is medium and the tested-versions row says resume itself has not been exercised.
2. **Not the same module as `subagent-model`** — this site lives in a different chunk, so it needs its own bytecode slice disabled. `apply` derives that per site, so nothing extra is required, and the module is small (~23 KB) so the startup cost is negligible.
3. **Stacks cleanly** with `subagent-model`, `auto-compact-by-model`, and `free-opus`: disjoint offsets, one sidecar each, independently revertible.
4. **Signing** — macOS re-signs ad-hoc; Windows Authenticode becomes `HashMismatch`.

## Changelog

| Date | Version | Note |
|------|---------|------|
| 2026-08-30 | 1.0.0 | Initial, on 2.1.250. Neutralises the `unknown_family` and `not_allowed` tiers of the resume model check, keeping `retired`. Both tiers are cut deliberately: `unknown_family` is the one users hit, but `Mp()` consults the same model registry, so cutting only the first tier would have re-declined the same ids one line later with a different message. |
