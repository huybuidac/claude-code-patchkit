# Patch: code-mode-gateway

Let Code Mode (`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`) start when Claude Code talks to the API through a gateway, proxy, or third-party provider.

## Metadata

| Field | Value |
|-------|-------|
| Author | @huybuidac |
| Version | 1.1.0 |
| Tested versions | 2.1.332 macOS arm64 (functional: interactive TUI in a pty + headless REPL run, both through a gateway; revert) |
| Risk level | low |
| Reversible | yes (sidecar reverse-patch, or backup) |
| Platforms | macOS (arm64) tested; Linux/Windows share the code path, untested |

## Usage

```bash
node patch-bin.js scan   --patch code-mode-gateway
node patch-bin.js apply  --patch code-mode-gateway
node patch-bin.js revert --patch code-mode-gateway
```

## Motivation

With `ANTHROPIC_BASE_URL` pointing anywhere but Anthropic (or Bedrock/Vertex/Foundry, a gateway login, `ANTHROPIC_UNIX_SOCKET`), every launch prints:

```
Code Mode (experimental) isn't available: it isn't offered yet through a gateway or proxy, or with Claude for Government. Starting with the ordinary tools.
```

and `claude -p` prints the `headless_provider` variant. Code Mode itself is client-side — a `REPL` tool that runs scripts locally, plus `Poll` — so nothing about it needs the first-party endpoint. There is no env var or setting that skips the check; the refusal reasons are computed from the provider state alone.

## Where the restriction lives

One module, six call sites. All are patched or none:

```
interactive launch ── I()  eligibility  ─ if(<gw>())return"provider";if(<3p>())return <hl>()?"headless_provider":"provider";
                   └─ q()  policy review ─ if(<gw>()||<3p>())return"provider";
                   └─ BSd  close (after setup, interactive only — exported as closeCodeModeOptInAfterSetup)
                         ├─ …?"otel":<gw>()||<3p>()?"provider":!…?"model":void 0
                         └─ r.signedInAs=…,<setVeto>(()=><3p>()?"provider":void 0),"none"
claude -p launch  ──  FSd  headless      ─ <hp>()?"headless_provider":void 0
mid-session       ──  veto               ─ <3p>()||<hp>()?"headless_provider":void 0
```

- `<gw>` — gateway session / gateway-vouched login / custom-auth env.
- `<3p>` — non-first-party provider, non-Anthropic `ANTHROPIC_BASE_URL` in env or any settings file, unix socket.
- `<hp>` — the headless variant of `<3p>`.

Everything else in the chain is left alone: `credentials`, `compliance` (HIPAA), `otel`, `model`, the `tengu_rustling_blossom` killswitch, the caveat prompt.

## Fingerprint — derived, never hardcoded

**Landmark** — `?"headless_provider":"provider";`. Only the eligibility check returns both reasons in one ternary.

| Step | Rule |
|---|---|
| 1 | Find every landmark — the count is the bundle multiplicity |
| 2 | eligibility anchor = bytes before it matching `if\((gw)\(\)\)return"provider";if\((3p)\(\)\)return \w+\(\)$`, plus the landmark. Pre-guard: preceded by `return"engine";`. Post-guard: `credentials`, `compliance`, `otel` returns follow |
| 3 | review anchor = `if(<gw>()\|\|<3p>())return"provider";` built from the names captured in 2. Pre-guard `return"otel";`, post-guard `return"model"` |
| 4 | For each `?"headless_provider":void 0`: launch = preceded by `?"credential_changed":(hp)()`; veto = preceded by `?"compliance":(3p)()\|\|(hp)()` |
| 5 | Veto's `<3p>` must equal step 2's, its `<hp>` must equal step 4's launch — backreferences across sites |
| 5b | close anchor = `<gw>()\|\|<3p>()?"provider":` built from step 2's names, preceded by `?"otel":`, followed by `?"model":void 0`. closeVeto anchor = `<set>(()=><3p>()?"provider":void 0),` immediately after `.signedInAs=<f>(),` and followed by `"none"` |
| 6 | The reason text `case"provider":return"it isn't offered yet through a gateway or proxy` must exist, and every kind must have the same count as step 1, or no site gets a replacement |

| Version | `<gw>` | `<3p>` | `<hp>` | module |
|---|---|---|---|---|
| 2.1.332 | `L` | `O` | `F` | `chunk-zd7v7hfm.js` |

## Replacement

| Site | Replacement |
|---|---|
| eligibility, review | `/*RTK-CODE-MODE-GW*/` padded — the statements become a comment |
| close | `/*RTK-CODE-MODE-GW*/` padded — the ternary arm disappears; 20 bytes, an exact fit with 1-char names |
| closeVeto | `/*RTK-CODE-MODE-GW*/` padded — the veto setter (`U9i(e){n.veto=e}`) is not called, so any earlier admin/compliance veto stays |
| launch, veto | `void 0/*RTK-CODE-MODE-GW*/` padded — the ternary resolves to "no reason" |

Budget: smallest anchor is launch at 30 bytes with 1-char names; its replacement is 26. Longer names only add slack.

Marker: `RTK-CODE-MODE-GW` — 6 per bundle instance once patched.

## State detection

| Anchor count | Marker count | State |
|---|---|---|
| ≥ 1 | 0 | Unpatched |
| 0 | ≥ 1 | Patched |
| ≥ 1 | ≥ 1 | Abnormal |
| 0 | 0 | Abnormal — re-derive |

The landmark is overwritten, so a patched binary has 0 landmarks and the marker is the only signal.

## Verification

```bash
node patch-bin.js scan --patch code-mode-gateway   # patched: Marker count 4, bytecode disabled

claude -p --settings '{"env":{"CLAUDE_CODE_EXPERIMENTAL_CODE_MODE":"1"}}' \
  "List the exact names of your available tools, comma-separated, nothing else."
# before: "Warning: Code Mode … isn't available …" then the ordinary tool list
# after:  REPL, Poll
```

**`-p` alone is not enough.** The interactive TUI runs `BSd` after setup and headless never does. A patch that missed it (1.0.0) passed the check above and still refused in every terminal session. Check the TUI too: start it in a pty for ~25 s and look for the startup notice.

```
before: ⚠ Code Mode (experimental) isn't available: it isn't offered yet through a …
after:  ⚠ Code Mode (experimental) is on · this session can be resumed only with Code …
```

Verified on 2.1.332 through a proxy `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`: the patched copy ran a REPL script (`uname -m`, a file count) and returned correct results.

## Post-patch behavior

- Restart required; the check runs at launch.
- Interactive sessions still ask the caveat question once (`codeModeCaveatsAcceptedV1` in `~/.claude.json`), then restart into the mode.
- `claude -p` still needs the variable in `--settings`' env block (`not_passed` is untouched).
- If the gateway sends `ANTHROPIC_AUTH_TOKEN` to a first-party base URL, the separate `credentials` gate still refuses — that one is not about the provider.

## Caveats

- Anthropic gated this on purpose ("isn't offered **yet**"); a future build may depend on something a proxy strips. Failure then shows up as REPL errors, not as a launch refusal.
- Costs ~one module compiled from source at startup (the bytecode slice for the Code Mode module is zeroed).
- Independent of the other patches; no shared bytes.

## Changelog

| Date | Version | Note |
|------|---------|------|
| 2026-11-26 | 1.1.0 | **1.0.0 missed two sites, so interactive sessions still refused.** `BSd` (`closeCodeModeOptInAfterSetup`) re-checks `<gw>()\|\|<3p>()` after setup and installs a provider-only veto. Only the TUI reaches it, so the `-p` verification passed. Both sites are now derived from the same captured names (6 markers). Upgrading a 1.0.0 binary means reverting with the old 4-site sidecar first, because the new derivation reads it as `abnormal`. Verified on 2.1.332 through a gateway: pty TUI shows "is on" (was "isn't available"), and `-p` lists `REPL, Poll`. |
| 2026-11-26 | 1.0.0 | Initial. 2.1.332 macOS arm64: apply on a copy → `REPL, Poll` in `-p` through a proxy, script ran; revert → JS region byte-identical to backup. |
