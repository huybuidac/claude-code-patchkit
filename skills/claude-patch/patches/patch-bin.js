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
//
// Since 2.1.250 the binary also ships a JSC bytecode copy of each module and runs THAT,
// leaving the embedded JS source as dead weight for stack traces. A source-only patch is
// then silently inert: the marker is in the file, the behaviour is unchanged. So every
// apply also zeroes the `bytecode` slice of the module holding the patch site, which makes
// bun fall back to compiling that module's source — the copy the patch edits. See the
// bun module-graph section below.

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

const RESUMEMODEL = {
  marker: 'RTK-RESUME-MODEL',
  markComment: '/*RTK-RESUME-MODEL*/',
  // The reason tag the resume path returns; the message the user sees is looked up from it.
  landmark: '?"unknown_family":',
  // `<c1>?"unknown_family":<c2>?"not_allowed":<retired>?"retired":void 0` — only the retired
  // call is kept, so a genuinely retired model still declines client-side.
  shapeRe: /^.+\?"unknown_family":.+\?"not_allowed":([\w$.]{1,16}\([\w$]{1,8}\))\?"retired":void 0$/,
  // Same statement, so the backreference proves the local we neutralise is the one the
  // decline branch reads — not some other ternary that happens to sit nearby.
  declinePrefix: v => `if(${v})return{kind:"declined",model:`,
  reasonMap: 'unknown_family:"not a model this version of Claude Code recognizes"',
};

const PATCHES = {
  'subagent-model': { marker: SUBAGENT.marker, derive: deriveSubagentSites },
  'auto-compact-by-model': { marker: AUTOCOMPACT.marker, derive: deriveAutocompactSites },
  'free-opus': { marker: FREEOPUS.marker, derive: deriveFreeOpusSites },
  'resume-model': { marker: RESUMEMODEL.marker, derive: deriveResumeModelSites },
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

// --- bun standalone module graph -------------------------------------------

// Layout of bun v1.4.x `CompiledModuleGraphFile` (src/standalone_graph/StandaloneModuleGraph.rs):
// six StringPointer{u32 offset, u32 len} — name, contents, sourcemap, bytecode, module_info,
// bytecode_origin_path — then encoding/loader/module_format/side as u8. Nothing here is
// searched for by name; the record is located by asking which module's `contents` range
// contains the patch site, so a renamed chunk changes nothing.
const GRAPH = {
  magic: '\n---- Bun! ----\n',
  recSize: 52,
  bytecodeAt: 24, // byte offset of the bytecode StringPointer within a record
  namePrefix: '/$bunfs/root/',
  tailScan: 8 * 1024 * 1024,
};

const u32le = n => Buffer.from(Uint32Array.of(n).buffer).toString('latin1');

// Returns null when the trailer does not decode with the layout above — an older bun, or a
// newer struct. Callers must treat null as "cannot reason about bytecode here", never as
// "there is no bytecode".
function parseGraph(file) {
  try {
    const size = fs.statSync(file).size;
    const from = Math.max(0, size - GRAPH.tailScan);
    const tail = readAt(file, from, size - from);
    const rel = tail.lastIndexOf(GRAPH.magic);
    if (rel < 0) return null;
    const magic = from + rel;

    const head = Buffer.from(readAt(file, magic - 32, 32), 'latin1');
    const byteCount = Number(head.readBigUInt64LE(0));
    const modOff = head.readUInt32LE(8);
    const modLen = head.readUInt32LE(12);
    const base = magic - 32 - byteCount;
    if (base < 0 || modLen === 0 || modLen % GRAPH.recSize !== 0) return null;
    if (modOff + modLen > byteCount) return null;

    const table = Buffer.from(readAt(file, base + modOff, modLen), 'latin1');
    const graph = { base, tableOffset: base + modOff, count: modLen / GRAPH.recSize, table, file };
    const first = moduleName(graph, 0);
    if (!first.startsWith(GRAPH.namePrefix)) return null;
    return graph;
  } catch {
    return null;
  }
}

const field = (g, rec, at) => ({
  offset: g.table.readUInt32LE(rec * GRAPH.recSize + at),
  len: g.table.readUInt32LE(rec * GRAPH.recSize + at + 4),
});

function moduleName(g, rec) {
  const p = field(g, rec, 0);
  return readAt(g.file, g.base + p.offset, Math.min(p.len, 256));
}

// The module whose `contents` slice contains `offset`, i.e. the one whose source carries
// the patch. Bytecode for that module shadows the source we just edited.
function moduleFor(g, offset) {
  const want = offset - g.base;
  for (let rec = 0; rec < g.count; rec++) {
    const c = field(g, rec, 8);
    if (want >= c.offset && want < c.offset + c.len) {
      const bc = field(g, rec, GRAPH.bytecodeAt);
      return {
        record: rec,
        module: moduleName(g, rec),
        len: bc.len,
        lenOffset: g.tableOffset + rec * GRAPH.recSize + GRAPH.bytecodeAt + 4,
      };
    }
  }
  return null;
}

function bytecodeSites(file, offsets) {
  const g = parseGraph(file);
  if (!g) return { supported: false, mods: [] };
  const seen = new Map();
  for (const o of offsets) {
    const m = moduleFor(g, o);
    if (m && !seen.has(m.record)) seen.set(m.record, m);
  }
  return { supported: true, mods: [...seen.values()] };
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

function deriveResumeModelSites(file) {
  const c = RESUMEMODEL;
  const mapOk = findAll(file, c.reasonMap).length > 0;
  return findAll(file, c.landmark).map(lm => {
    const backLen = Math.min(200, lm);
    const back = readAt(file, lm - backLen, backLen);
    const fwd = readAt(file, lm, 400);

    const decl = back.lastIndexOf('let ');
    const eq = decl < 0 ? -1 : back.indexOf('=', decl);
    const varName = eq < 0 ? null : back.slice(decl + 4, eq);
    const semi = fwd.indexOf(';');

    const offset = eq < 0 ? lm : lm - backLen + eq + 1;
    const anchor = eq < 0 || semi < 0 ? null : back.slice(eq + 1) + fwd.slice(0, semi);
    const after = semi < 0 ? '' : fwd.slice(semi + 1);

    const shape = anchor === null ? null : c.shapeRe.exec(anchor);
    const preMatch = varName !== null && /^[\w$]{1,8}$/.test(varName) && shape !== null;
    const postMatch = preMatch && mapOk && after.startsWith(c.declinePrefix(varName));

    // The replacement keeps the landmark, so a patched site still derives an anchor and
    // would read as `abnormal` (anchor + marker) the moment padding stops hiding it.
    const isAnchor = preMatch && !anchor.includes(c.marker);
    const replacement = isAnchor && postMatch
      ? padTo(`0${c.markComment}?"unknown_family":0?"not_allowed":${shape[1]}?"retired":void 0`, anchor.length)
      : null;

    return { offset, anchor, varName, retiredCall: shape ? shape[1] : null, replacement, preMatch, postMatch, isAnchor };
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

  // Which module carries the patch: its anchors while unpatched, its markers once patched.
  const bc = bytecodeSites(file, a ? anchors.map(s => s.offset) : markerOffsets);
  const live = bc.mods.filter(x => x.len > 0);
  if (!bc.supported && (a || m)) {
    notes.push('bun module graph did not decode — cannot tell whether bytecode shadows the source patch');
  }
  if (m >= 1 && a === 0 && live.length) {
    notes.push(`marker present but ${live.length} module(s) still run from bytecode — the patch is inert; re-run apply to repair`);
  }

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
    bytecodeSupported: bc.supported,
    bytecode: bc.mods,
    state: a >= 1 && m === 0 ? 'unpatched'
      : a === 0 && m >= 1 ? (live.length ? 'patched-inert' : 'patched')
      : 'abnormal',
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
  if (!r.bytecodeSupported) console.log('Bytecode: module graph not decodable');
  else r.bytecode.forEach(b => {
    console.log(`Bytecode: ${b.module} rec#${b.record} len=${b.len}${b.len ? ' (SHADOWS the source patch)' : ' (disabled)'}`);
  });
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

// Zeroing the length alone is enough: bun treats an empty bytecode slice as "not cached"
// and compiles the module's source. The blob itself is left in place so the edit stays
// length-preserving and exactly reversible from the sidecar.
function graphEdits(scanResult) {
  return scanResult.bytecode.filter(b => b.len > 0).map(b => ({
    module: b.module, record: b.record, offset: b.lenOffset, original: b.len,
  }));
}

const graphWrites = edits => edits.map(e => ({ offset: e.offset, expect: u32le(e.original), write: u32le(0) }));

function writeSidecar(bin, patchId, sites, gEdits) {
  fs.writeFileSync(sidecarPath(bin, patchId), JSON.stringify({
    patch: patchId,
    sites: sites.map(s => ({ offset: s.offset, anchor: s.anchor, replacement: s.replacement })),
    graphEdits: gEdits,
  }, null, 2));
}

function cmdApply(bin, patchId) {
  const before = scan(bin, patchId);
  if (before.state === 'patched') {
    console.log(`Already patched (${before.markerCount} marker[s]), nothing to do`);
    return;
  }

  // A binary patched before bytecode shipped, or by an older patch-bin: the source edit is
  // already in place and only the bytecode shadow needs clearing.
  const repair = before.state === 'patched-inert';
  if (!repair && before.state !== 'unpatched') {
    die(`state=${before.state} — refusing to patch (${before.notes.join('; ') || 'mixed anchors and markers'})`);
  }

  const sites = repair ? [] : before.sites.filter(s => s.isAnchor);
  for (const s of sites) {
    if (!s.preMatch || !s.postMatch) die(`context guard failed at ${s.offset} (pre=${s.preMatch} post=${s.postMatch})`);
    if (!s.replacement) die(`no length-preserving replacement derivable at ${s.offset}`);
    console.log(`  @${s.offset}: ${s.anchor} -> ${JSON.stringify(s.replacement)}`);
  }
  const gEdits = graphEdits(before);
  gEdits.forEach(e => console.log(`  bytecode off: ${e.module} rec#${e.record} len ${e.original} -> 0`));
  if (repair && !gEdits.length) die('nothing to repair');
  if (!repair && !before.bytecodeSupported) {
    console.log('WARNING: module graph not decodable — if this build runs from bytecode the patch will be inert');
  }

  const backup = `${bin}.bak.${Math.floor(Date.now() / 1000)}`;
  fs.copyFileSync(bin, backup);
  console.log(`Backup: ${backup}`);

  writeBinary(bin, [
    ...sites.map(s => ({ offset: s.offset, expect: s.anchor, write: s.replacement })),
    ...graphWrites(gEdits),
  ]);
  // The original bytes cannot be recovered from a patched binary once an alias has
  // drifted (only their length survives), so record them for an exact revert.
  const prior = repair && fs.existsSync(sidecarPath(bin, patchId))
    ? JSON.parse(fs.readFileSync(sidecarPath(bin, patchId), 'utf8'))
    : null;
  writeSidecar(bin, patchId, prior ? prior.sites : sites, [...(prior?.graphEdits || []), ...gEdits]);
  resign(bin);

  const after = scan(bin, patchId);
  const wantMarkers = repair ? before.markerCount : sites.length;
  if (after.state !== 'patched' || after.markerCount !== wantMarkers) {
    die(`self-verify failed (state=${after.state} anchor=${after.anchorCount} marker=${after.markerCount})`);
  }
  console.log(`Verified: patch applied and live (${after.markerCount} marker[s])`);
}

function cmdRevert(bin, patchId) {
  const before = scan(bin, patchId);
  if (before.state !== 'patched' && before.state !== 'patched-inert') die(`state=${before.state} — nothing to revert`);

  const snapshot = `${bin}.preRevert.${Math.floor(Date.now() / 1000)}`;
  fs.copyFileSync(bin, snapshot);
  console.log(`Safety snapshot: ${snapshot}`);

  const side = sidecarPath(bin, patchId);
  if (fs.existsSync(side)) {
    const rec = JSON.parse(fs.readFileSync(side, 'utf8'));
    const g = rec.graphEdits || [];
    writeBinary(bin, [
      ...rec.sites.map(s => ({ offset: s.offset, expect: s.replacement, write: s.anchor })),
      ...g.map(e => ({ offset: e.offset, expect: u32le(0), write: u32le(e.original) })),
    ]);
    fs.rmSync(side, { force: true });
    console.log(`Reverse-patched ${rec.sites.length} site(s) and restored ${g.length} bytecode slice(s) from sidecar`);
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
    if (r.state === 'abnormal' || r.state === 'patched-inert') bad++;
    if (json) all.push(r);
    else { printScan(r, false); console.log(); }
  }
  if (json) console.log(JSON.stringify(all, null, 2));
  process.exit(bad ? 1 : 0);
} else if (cmd === 'scan') {
  const r = scan(bin, patchId);
  printScan(r, json);
  process.exit(r.state === 'abnormal' || r.state === 'patched-inert' ? 1 : 0);
} else if (cmd === 'apply') {
  cmdApply(bin, patchId);
} else {
  cmdRevert(bin, patchId);
}
