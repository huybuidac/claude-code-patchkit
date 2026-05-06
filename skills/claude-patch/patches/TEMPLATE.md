# Patch: {{NAME}}

One-line description of what this patch does.

## Metadata

| Field | Value |
|-------|-------|
| Author | @github-username |
| Tested versions | 2.1.X, 2.1.Y |
| Risk level | low / medium / high |
| Reversible | yes (backup) |

## Motivation

Why is this patch needed? What limitation does it address?

## Fingerprint

### Anchor pattern (N bytes)

```
<exact byte sequence to search for in binary>
```

- Expected count: **N**
- Length: **N bytes**

### Context guard

**Before** (must appear within 100 bytes preceding anchor):
```
<surrounding text before the anchor>
```

**After** (must immediately follow anchor):
```
<surrounding text after the anchor>
```

### Stability notes

Why is this fingerprint stable across versions? What could break it?

## Replacement

| Old (N bytes) | New (N bytes) |
|---|---|
| `<old>` | `<new>` |

Must be **length-preserving**. Explain padding if needed.

### Patch marker

```
<UNIQUE_MARKER_STRING>
```

## State detection

| Anchor count | Marker count | State | Action |
|---|---|---|---|
| N | 0 | Unpatched | OK to patch |
| 0 | N | Patched | Skip |
| other | other | Abnormal | Abort |

## Patch script

```bash
#!/usr/bin/env bash
set -euo pipefail
# Full patch script here
# Must: detect → guard → backup → patch → re-sign → verify
```

## Verification

```bash
# Commands to confirm patch works correctly
```

## Post-patch behavior

Describe what changes functionally after the patch is applied.

## Caveats

- Known risks or edge cases
- Interactions with other features

## Changelog

| Date | Version | Note |
|------|---------|------|
| YYYY-MM-DD | 1.0 | Initial |
