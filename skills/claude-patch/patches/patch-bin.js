#!/usr/bin/env node
// patch-bin.js — scan, apply, and revert binary patches for the Claude Code CLI.
//
//   node patch-bin.js scan   [--patch <id>] [--bin <path>] [--json]
//   node patch-bin.js apply  [--patch <id>] [--bin <path>]
//   node patch-bin.js revert [--patch <id>] [--bin <path>]
//   node patch-bin.js status [--bin <path>] [--json]   # scan every registered patch
//   node patch-bin.js list                             # registered patch ids
//
// Nothing here hardcodes a minified identifier. Every few builds the bundler renames
// them, and a literal anchor then matches 0 times — which state detection cannot tell
// apart from "the feature is gone". So each patch derives its anchor at scan time from
// stable landmarks (string literals, positional locals) and reports the derived bytes.
//
// One implementation covers macOS, Linux, and Windows: ad-hoc re-signing on darwin,
// rename-swap on win32 (a running claude.exe is locked and cannot be written in place).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// --- patch definitions -----------------------------------------------------

const SUBAGENT = {
  marker: 'RTK-SUBAGENT-PATCH',
  markComment: '/*RTK-SUBAGENT-PATCH*/',
  landmark: '.optional().describe("The type of specialized agent to use for this task"),model:',
  postPrefix: '.optional().describe(',
  postDesc: 'Optional model override for this agent.',
  // `.enum(["sonnet","opus","haiku"])`, `v.enum([...,"fable"])`, `Mr([...])` — any alias.
  enumRe: /^[\w$.]{0,12}\(\["sonnet","opus","haiku"(?:,"fable")?\]\)$/,
  // The sibling `subagent_type` factory, reused as the unconstrained replacement.
  stringRe: /^[\w$.]{1,16}\(\)$/,
};

const AUTOCOMPACT = {
  marker: 'RTK-AUTOCOMPACT-PATCH',
  landmark: 'if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let ',
  tail: 'source:"env"}}}',
  // Resolver prologue: `function <F>(e,t,r=<G>()){let <model>=<H>(e),<ceil>=<I>(e,r);`
  // Both locals are CAPTURED, never assumed. They were n/o on 2.1.239 and o/u on
  // 2.1.250; every letter previously hardcoded here matched 0 times on 2.1.250 and
  // the scanner reported a false "fingerprint changed".
  //
  // `r` is NOT the model. It is the capabilities/betas value also handed to <I>(e,r),
  // <J>(e,r) and <K>(e,r); the model id is the FIRST local, the one the resolver uses
  // as a Set/Map key. A replacement calling r.startsWith() throws at runtime.
  prologueRe: /function [\w$]{1,8}\(e,t,r=[\w$]{1,8}\(\)\)\{let ([\w$]{1,8})=[\w$]{1,8}\(e\),([\w$]{1,8})=[\w$]{1,8}\(e,r\);$/,
  // The scalar-env branch, every local captured and back-referenced so the shape itself
  // proves the bindings: <env> parse result, <floor> the 1e5 constant, <res> the
  // resolved window, <ceil> the context ceiling.
  envRe: /^([\w$]{1,16})=[\w$.]{1,24}\("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process\.env\.CLAUDE_CODE_AUTO_COMPACT_WINDOW,([\w$]{1,16}),[\w$]{1,16}\);if\(\1\.status!=="invalid"\)\{let ([\w$]{1,16})=Math\.max\(\2,\1\.effective\);return\{window:Math\.min\(([\w$]{1,16}),\3\),configured:\3,source:"env"\}\}\}$/,
  requireAfter: [
    'source:"settings"',
    'source:"clientdata"',
    'source:"experiment"',
    'source:"model-default"',
    'source:"auto"',
  ],
};

const FREEOPUS = {
  marker: '0&&$FO',
  markExpr: 'if(0&&$FO)',
  // Telemetry event name — emitted by every tier of the heron_brook resolver, so it
  // cannot be dropped while the section still ships.
  landmark: 'tengu_heron_brook_applied',
  // Tier 3 only: `",{len:<C>.length,fromClientData:!1}),<C>;return null}`. Tiers 1-2
  // read a local and close with `}`; the `;return null` tail is the branch being cut,
  // and the backreference proves the logged constant is the value being returned.
  tailRe: /^",\{len:([\w$]{1,16})\.length,fromClientData:!1\}\),\1;return null\}/,
  // `if(<gate>(e))return <log>(` — the model-capability gate whose call is falsified.
  // The logger alias is captured, not assumed: it was `H` on 2.1.233 and `L` on 2.1.226.
  headRe: /if\(([\w$.]{1,16})\(e\)\)(return [\w$.]{1,16}\()$/,
  // Proves <C> holds the anti-delegation payload rather than some other constant.
  payloadInit: '=["Do not call the AgentTool unless the user requested it",'
    + '"Do not use workflows or deep-research unless the user requested it"]',
};

const PATCHES = {
  'subagent-model': { marker: SUBAGENT.marker, derive: deriveSubagentSites },
  'auto-compact-by-model': { marker: AUTOCOMPACT.marker, derive: deriveAutocompactSites },
  'free-opus': { marker: FREEOPUS.marker, derive: deriveFreeOpusSites },
};

// --- io helpers ------------------------------------------------------------

function findAll(file, needle) {
  const needleBuf = Buffer.from(needle, 'latin1');
  const fd = fs.openSync(file, 'r');
  const chunkSize = 16 * 1024 * 1024;
  const overlap = needleBuf.length - 1;
  const buf = Buffer.alloc(chunkSize + overlap);
  let pos = 0;
  let carry = 0;
  const offsets = [];
  while (true) {
    const n = fs.readSync(fd, buf, carry, chunkSize, pos);
    if (n === 0) break;
    const valid = carry + n;
    let from = 0;
    while (true) {
      const i = buf.indexOf(needleBuf, from);
      if (i < 0 || i > valid - needleBuf.length) break;
      offsets.push(pos - carry + i);
      from = i + 1;
    }
    if (n < chunkSize) break;
    pos += n;
    buf.copy(buf, 0, valid - overlap, valid);
    carry = overlap;
  }
  fs.closeSync(fd);
  return offsets;
}

// latin1 keeps 1 byte == 1 char, so string indexes are byte offsets.
function readAt(file, offset, length) {
  if (length <= 0) return '';
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  fs.closeSync(fd);
  return buf.subarray(0, n).toString('latin1');
}

function padTo(body, width) {
  return body.length <= width ? body.padEnd(width, ' ') : null;
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// --- derivations -----------------------------------------------------------

function deriveSubagentSites(file) {
  const c = SUBAGENT;
  return findAll(file, c.landmark).map(lm => {
    const offset = lm + c.landmark.length;
    const before = readAt(file, Math.max(0, lm - 96), Math.min(96, lm));
    const after = readAt(file, offset, 256);

    const k = after.indexOf(c.postPrefix);
    const anchor = k < 0 ? null : after.slice(0, k);
    const postMatch = k >= 0 && after.slice(k, k + c.postPrefix.length + 160).includes(c.postDesc);

    const s = before.lastIndexOf('subagent_type:');
    const stringExpr = s < 0 ? null : before.slice(s + 'subagent_type:'.length);
    const preMatch = stringExpr !== null && c.stringRe.test(stringExpr);

    const isAnchor = anchor !== null && c.enumRe.test(anchor);
    const replacement = isAnchor && preMatch ? padTo(stringExpr + c.markComment, anchor.length) : null;

    return { offset, anchor, stringExpr, replacement, preMatch, postMatch, isAnchor };
  });
}

// Built from the captured locals rather than baked in, so a rename shifts the bytes
// instead of breaking the patch. Reuses the env branch's own block-scoped names, which
// are already proven collision-free in that scope.
function autocompactReplacement(model, ceil, env, res) {
  return `{let ${env}=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,${res}=${ceil}>2e5?`
    + `${model}.startsWith("gpt-")?333000:${model}.startsWith("claude-")?433000:+${env}:+${env};`
    + `if(${res}>0){${res}=Math.max(1e5,${res});`
    + `return{window:Math.min(${ceil},${res}),configured:${res},source:"env"/*RTK-AUTOCOMPACT-PATCH*/}}}`;
}

function deriveAutocompactSites(file) {
  const c = AUTOCOMPACT;
  return findAll(file, c.landmark).map(offset => {
    const before = readAt(file, Math.max(0, offset - 200), Math.min(200, offset));
    const win = readAt(file, offset, 512);

    const t = win.indexOf(c.tail);
    const anchor = t < 0 ? null : win.slice(0, t + c.tail.length);
    const after = anchor === null ? '' : readAt(file, offset + anchor.length, 700);

    const pro = c.prologueRe.exec(before);
    const env = anchor === null ? null : c.envRe.exec(anchor.slice(c.landmark.length));
    const model = pro ? pro[1] : null;
    const ceil = pro ? pro[2] : null;

    // Cross-check, not assumption: the ceiling the env branch narrows must be the local
    // the prologue bound to <I>(e,r). This is what the old `Math.min(o,c)` literal was
    // standing in for, minus the dependency on which letters the bundler picked.
    const preMatch = pro !== null && env !== null && env[4] === ceil;
    // The model local must still be used as a model key downstream (`<Set>.has(<model>)`,
    // the set of extended-context model ids). Without this the replacement could call
    // .startsWith() on a non-string and throw inside the resolver.
    const postMatch = anchor !== null && model !== null
      && c.requireAfter.every(s => after.includes(s))
      && after.includes(`.has(${model})`);

    const isAnchor = anchor !== null && env !== null;
    const replacement = isAnchor && preMatch && postMatch
      ? padTo(autocompactReplacement(model, ceil, env[1], env[3]), anchor.length)
      : null;

    return { offset, anchor, model, ceil, replacement, preMatch, postMatch, isAnchor };
  });
}

function deriveFreeOpusSites(file) {
  const c = FREEOPUS;
  return findAll(file, c.landmark).map(lm => {
    // back covers [lm-64, lm-1]; the byte at lm-1 is the event name's opening quote.
    const backLen = Math.min(64, lm);
    const back = readAt(file, lm - backLen, backLen);
    const fwd = readAt(file, lm + c.landmark.length, 96);

    const tail = c.tailRe.exec(fwd);
    const constName = tail ? tail[1] : null;
    const head = c.headRe.exec(back.slice(0, -1));
    const anchor = head ? `if(${head[1]}(e))` : null;
    const offset = anchor === null ? lm : lm - 1 - head[2].length - anchor.length;

    const preMatch = anchor !== null;
    // Cross-file check, not an assumption: the constant this branch returns must be
    // the two-line payload. A renamed gate is fine; a repurposed constant is not.
    const postMatch = constName !== null && findAll(file, constName + c.payloadInit).length > 0;
    const isAnchor = preMatch && tail !== null;
    const replacement = isAnchor && postMatch ? padTo(c.markExpr, anchor.length) : null;

    return { offset, anchor, constName, replacement, preMatch, postMatch, isAnchor };
  });
}

// --- scan ------------------------------------------------------------------

function scan(file, patchId) {
  const patch = PATCHES[patchId];
  const markerOffsets = findAll(file, patch.marker);
  const sites = patch.derive(file);
  const anchors = sites.filter(s => s.isAnchor);
  const notes = [];

  // A patched binary legitimately has no landmark (the block it named was rewritten),
  // so only the both-zero case means the fingerprint itself is gone.
  if (sites.length === 0 && markerOffsets.length === 0) {
    notes.push('landmark not found — fingerprint changed, do not patch blind');
  }
  anchors.forEach(s => {
    if (!s.replacement) {
      notes.push(`no valid replacement at ${s.offset} (preMatch=${s.preMatch} postMatch=${s.postMatch})`);
    }
  });

  const a = anchors.length;
  const m = markerOffsets.length;
  return {
    file,
    size: fs.statSync(file).size,
    patch: patchId,
    marker: patch.marker,
    landmarkCount: sites.length,
    anchor: a ? anchors[0].anchor : null,
    stringExpr: a ? anchors[0].stringExpr : undefined,
    replacement: a ? anchors[0].replacement : null,
    anchorCount: a,
    markerCount: m,
    anchorOffsets: anchors.map(s => s.offset),
    markerOffsets,
    contextGuards: anchors.map(s => ({ offset: s.offset, preMatch: s.preMatch, postMatch: s.postMatch })),
    sites,
    state: a >= 1 && m === 0 ? 'unpatched' : a === 0 && m >= 1 ? 'patched' : 'abnormal',
    notes,
  };
}

function printScan(r, json) {
  if (json) return console.log(JSON.stringify(r, null, 2));
  console.log(`File: ${r.file} (${(r.size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Patch: ${r.patch}`);
  console.log(`State: ${r.state}`);
  console.log(`Landmarks: ${r.landmarkCount}`);
  console.log(`Anchor count: ${r.anchorCount}`);
  if (r.anchor) console.log(`  anchor: ${r.anchor}`);
  if (r.replacement) console.log(`  replacement: ${JSON.stringify(r.replacement)}`);
  console.log(`Marker count: ${r.markerCount}`);
  r.contextGuards.forEach(g => {
    console.log(`  @ 0x${g.offset.toString(16)} (${g.offset})  preGuard=${g.preMatch} postGuard=${g.postMatch}`);
  });
  r.notes.forEach(n => console.log(`  note: ${n}`));
}

// --- write paths -----------------------------------------------------------

// edits: [{offset, expect, write}] — every write is length-preserving and is verified
// against `expect` first, so a stale offset aborts instead of corrupting the binary.
function applyEdits(target, edits) {
  const fd = fs.openSync(target, 'r+');
  try {
    for (const e of edits) {
      const want = Buffer.from(e.expect, 'latin1');
      const got = Buffer.alloc(want.length);
      fs.readSync(fd, got, 0, want.length, e.offset);
      if (!got.equals(want)) throw new Error(`bytes at ${e.offset} are not what was expected`);
      const out = Buffer.from(e.write, 'latin1');
      if (out.length !== want.length) throw new Error(`edit at ${e.offset} is not length-preserving`);
      fs.writeSync(fd, out, 0, out.length, e.offset);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Windows keeps a running claude.exe locked, so edits go to a copy which then takes
// the original's path — renaming a running image only updates the directory entry.
function writeBinary(bin, edits) {
  if (process.platform !== 'win32') return applyEdits(bin, edits);
  const temp = `${bin}.patching`;
  fs.copyFileSync(bin, temp);
  try {
    applyEdits(temp, edits);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  const tomb = `${bin}.replacing.${Date.now()}`;
  fs.renameSync(bin, tomb);
  fs.renameSync(temp, bin);
  fs.rmSync(tomb, { force: true }); // may stay until the old process exits
}

function resign(bin) {
  if (process.platform !== 'darwin') return;
  spawnSync('codesign', ['--remove-signature', bin]);
  if (spawnSync('codesign', ['--force', '--sign', '-', bin]).status !== 0) die('codesign failed');
  if (spawnSync('codesign', ['--verify', bin]).status !== 0) die('codesign --verify failed');
  console.log('Re-signed (ad-hoc) and verified');
}

const sidecarPath = (bin, patchId) => `${bin}.rtk-${patchId}.json`;

// --- commands --------------------------------------------------------------

function cmdApply(bin, patchId) {
  const before = scan(bin, patchId);
  if (before.state === 'patched') {
    console.log(`Already patched (${before.markerCount} marker[s]), nothing to do`);
    return;
  }
  if (before.state !== 'unpatched') die(`state=${before.state} — refusing to patch (${before.notes.join('; ') || 'mixed anchors and markers'})`);

  const sites = before.sites.filter(s => s.isAnchor);
  for (const s of sites) {
    if (!s.preMatch || !s.postMatch) die(`context guard failed at ${s.offset} (pre=${s.preMatch} post=${s.postMatch})`);
    if (!s.replacement) die(`no length-preserving replacement derivable at ${s.offset}`);
    console.log(`  @${s.offset}: ${s.anchor} -> ${JSON.stringify(s.replacement)}`);
  }

  const backup = `${bin}.bak.${Math.floor(Date.now() / 1000)}`;
  fs.copyFileSync(bin, backup);
  console.log(`Backup: ${backup}`);

  writeBinary(bin, sites.map(s => ({ offset: s.offset, expect: s.anchor, write: s.replacement })));
  // The original bytes cannot be recovered from a patched binary once an alias has
  // drifted (only their length survives), so record them for an exact revert.
  fs.writeFileSync(sidecarPath(bin, patchId), JSON.stringify({
    patch: patchId,
    sites: sites.map(s => ({ offset: s.offset, anchor: s.anchor, replacement: s.replacement })),
  }, null, 2));
  resign(bin);

  const after = scan(bin, patchId);
  if (after.state !== 'patched' || after.markerCount !== sites.length) {
    die(`self-verify failed (state=${after.state} anchor=${after.anchorCount} marker=${after.markerCount})`);
  }
  console.log(`Verified: patch applied (${after.markerCount} marker[s])`);
}

function cmdRevert(bin, patchId) {
  const before = scan(bin, patchId);
  if (before.state !== 'patched') die(`state=${before.state} — nothing to revert`);

  const snapshot = `${bin}.preRevert.${Math.floor(Date.now() / 1000)}`;
  fs.copyFileSync(bin, snapshot);
  console.log(`Safety snapshot: ${snapshot}`);

  const side = sidecarPath(bin, patchId);
  if (fs.existsSync(side)) {
    const rec = JSON.parse(fs.readFileSync(side, 'utf8'));
    writeBinary(bin, rec.sites.map(s => ({ offset: s.offset, expect: s.replacement, write: s.anchor })));
    fs.rmSync(side, { force: true });
    console.log(`Reverse-patched ${rec.sites.length} site(s) from sidecar`);
  } else {
    // No sidecar (patched before sidecars existed). Validate candidates by content:
    // on macOS the Apple-signed backup and the ad-hoc-signed binary differ in size,
    // and Claude Code re-bundles within a dot-version, so neither size nor filename
    // is evidence that a backup belongs to this build.
    const dir = path.dirname(bin);
    const base = path.basename(bin);
    const cands = fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.bak.`))
      .map(f => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    const good = cands.find(c => {
      const s = scan(c, patchId);
      return s.state === 'unpatched' && s.landmarkCount === before.landmarkCount
        && s.contextGuards.every(g => g.preMatch && g.postMatch);
    });
    if (!good) die('no sidecar and no valid backup — a drifted alias cannot be reconstructed; reinstall this version');
    console.log(`Restoring backup: ${good}`);
    if (process.platform === 'win32') {
      const tomb = `${bin}.replacing.${Date.now()}`;
      fs.renameSync(bin, tomb);
      fs.copyFileSync(good, bin);
      fs.rmSync(tomb, { force: true });
    } else {
      fs.copyFileSync(good, bin);
    }
  }
  resign(bin);

  const after = scan(bin, patchId);
  if (after.state !== 'unpatched') die(`revert verification failed (state=${after.state} marker=${after.markerCount})`);
  console.log(`Reverted successfully (anchor=${after.anchorCount} marker=0)`);
}

// --- cli -------------------------------------------------------------------

function resolveBin() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  const first = (which.stdout || '').split(/\r?\n/).find(Boolean);
  if (first) return fs.realpathSync(first.trim());
  const fallback = process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe')
    : path.join(process.env.HOME || '', '.local', 'share', 'claude', 'current');
  if (fs.existsSync(fallback)) return fs.realpathSync(fallback);
  die('claude binary not found — pass --bin <path>');
}

const argv = process.argv.slice(2);
let cmd = 'scan';
let patchId = 'subagent-model';
let bin = null;
let json = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === 'scan' || a === 'apply' || a === 'revert' || a === 'status' || a === 'list') cmd = a;
  else if (a === '--json') json = true;
  else if (a === '--patch') patchId = argv[++i];
  else if (a.startsWith('--patch=')) patchId = a.slice(8);
  else if (a === '--bin') bin = argv[++i];
  else if (a.startsWith('--bin=')) bin = a.slice(6);
  else if (a.startsWith('--')) die(`unknown option: ${a}`);
  else bin = a; // positional path, for backward compatibility
}

if (cmd === 'list') {
  for (const id of Object.keys(PATCHES)) console.log(id);
  process.exit(0);
}

if (!PATCHES[patchId]) die(`unknown patch: ${patchId}. Available: ${Object.keys(PATCHES).join(', ')}`);
bin = bin ? path.resolve(bin) : resolveBin();
if (!fs.existsSync(bin)) die(`binary not found: ${bin}`);

if (cmd === 'status') {
  // Exit 1 if ANY patch is abnormal — one bad fingerprint is the thing worth noticing.
  let bad = 0;
  const all = [];
  for (const id of Object.keys(PATCHES)) {
    const r = scan(bin, id);
    if (r.state === 'abnormal') bad++;
    if (json) all.push(r);
    else { printScan(r, false); console.log(); }
  }
  if (json) console.log(JSON.stringify(all, null, 2));
  process.exit(bad ? 1 : 0);
} else if (cmd === 'scan') {
  const r = scan(bin, patchId);
  printScan(r, json);
  process.exit(r.state === 'abnormal' ? 1 : 0);
} else if (cmd === 'apply') {
  cmdApply(bin, patchId);
} else {
  cmdRevert(bin, patchId);
}
