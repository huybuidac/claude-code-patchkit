# Patch: {{NAME}}

One-line description of what this patch does.

## Metadata

| Field | Value |
|-------|-------|
| Author | @github-username |
| Version | 1.0.0 |
| Tested versions | 2.1.X (functional); derivation verified on 2.1.Y |
| Risk level | low / medium / high |
| Reversible | yes (sidecar reverse-patch, or backup) |
| Platforms | which are actually tested, and which merely share the code path |

## Usage

```bash
node patch-bin.js scan   --patch {{NAME}}
node patch-bin.js apply  --patch {{NAME}}
node patch-bin.js revert --patch {{NAME}}
```

## Motivation

What limitation does this address, and why can't configuration solve it?

## Fingerprint — derived, never hardcoded

Do not paste a byte sequence containing minified identifiers as the anchor. The bundler renames them every few builds, and a count of 0 is indistinguishable from "the feature was removed" — so a literal anchor turns routine drift into a false abort. Derive it instead, and register the derivation in `patch-bin.js`.

**Landmark** — a string the product ships (a `.describe()` text, an error message, a `source:"…"` label). Explain why it cannot move without the feature itself changing.

```
<landmark>
```

**Derivation:**

| Step | Rule |
|---|---|
| 1 | Find every landmark occurrence — the count **is** the bundle multiplicity, never assert a number |
| 2 | **anchor** = bytes from … to … |
| 3 | any expressions the replacement needs, and where they are read from |
| 4 | post-guard: what must appear after the anchor |
| 5 | pre-guard: what must appear before it, and which regex validates the shape |

State what each guard proves. If the replacement depends on a variable binding (e.g. a positional local), the guard must **check** that binding rather than assume it — that check is what makes the patch safe on an untested version.

Record what the derivation yields per version, so drift is visible at a glance:

| Version | anchor (derived) | notes |
|---|---|---|
| 2.1.X | `…` | |

## Replacement

```
replacement = <expression> right-padded with spaces to len(anchor)
```

Must be **length-preserving**; state the byte budget and why it fits in the worst case. Prefer referencing only positional locals — they survive renames.

Marker: `<UNIQUE_MARKER_STRING>` (must be unique in the binary and stable forever, since it identifies binaries patched by older versions of this definition).

## State detection

| Anchor count | Marker count | State | Action |
|---|---|---|---|
| ≥ 1 | 0 | Unpatched | Patch all sites |
| 0 | ≥ 1 | Patched | Skip |
| ≥ 1 | ≥ 1 | Abnormal | Abort — partial/concurrent patch |
| 0 | 0 | Abnormal | Abort — landmark gone, re-derive |

Note whether a patched binary still contains the landmark. If the replacement rewrites it, `landmarkCount: 0` is expected after patching and marker count is the only signal.

## Verification

```bash
node patch-bin.js scan --patch {{NAME}}
```

Plus a functional test: what should now work that did not before?

## Post-patch behavior

What changes at runtime. Does it need a restart? Do wrong inputs fail loudly or silently?

## Caveats

- What is tested functionally versus only structurally
- Interactions with other patches
- Signing consequences per platform

## Changelog

| Date | Version | Note |
|------|---------|------|
| YYYY-MM-DD | 1.0.0 | Initial |
