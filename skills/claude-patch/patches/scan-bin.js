#!/usr/bin/env node
// scan-bin.js — find byte patterns in Claude Code binary (any size, streaming)
// Usage: node scan-bin.js <path-to-binary> [--patch <id>] [--json]
// Used by both Windows and Unix workflows when grep/python aren't suitable.

const fs = require('fs');

const PATCHES = {
  'subagent-model': {
    // 2.1.224+: call-form anchor (`xr(...)`), 37 bytes. Aliases `xr`/`N` are ordinary minified
    // identifiers, not stable literal text like the old `.enum(`/`.string()` method names — if
    // this stops matching on a future version, re-derive both aliases (see subagent-model.md
    // "Auto-update" caveat) by searching for "Optional model override for this agent." and
    // reading the call immediately before it and before `.optional().describe(`.
    anchor: 'xr(["sonnet","opus","haiku","fable"])',
    marker: 'RTK-SUBAGENT-PATCH',
    guard: {
      beforeBytes: 200,
      afterBytes: 200,
      beforeAll: ['N().optional().describe("The type of specialized agent to use for this task"),model:'],
      // Quote-agnostic: the description changed from a quoted string to a
      // template literal at 2.1.176, while its prefix and text stayed stable.
      afterPrefix: '.optional().describe(',
      afterAll: ['Optional model override for this agent.'],
    },
  },
  'auto-compact-by-model': {
    anchor: 'if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=ODe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,bZn,DJi);if(l.status!=="invalid"){let c=Math.max(bZn,l.effective);return{window:Math.min(o,c),configured:c,source:"env"}}}',
    marker: 'RTK-AUTOCOMPACT-PATCH',
    guard: {
      beforeBytes: 0,
      afterBytes: 700,
      beforeAll: [],
      afterAll: [
        'source:"settings"',
        'source:"clientdata"',
        'source:"experiment"',
        'source:"model-default"',
        'source:"auto"',
      ],
    },
  },
};

const args = process.argv.slice(2);
let filePath;
let patchId = 'subagent-model';
let jsonOutput = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--patch') {
    patchId = args[++i];
    if (!patchId) {
      console.error('--patch requires a patch id');
      process.exit(2);
    }
  } else if (arg.startsWith('--patch=')) {
    patchId = arg.slice('--patch='.length);
  } else if (arg.startsWith('--')) {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  } else if (!filePath) {
    filePath = arg;
  } else {
    console.error(`Unexpected argument: ${arg}`);
    process.exit(2);
  }
}

if (!filePath) {
  console.error('Usage: node scan-bin.js <path-to-binary> [--patch <id>] [--json]');
  process.exit(2);
}

const patch = PATCHES[patchId];
if (!patch) {
  console.error(`Unknown patch: ${patchId}. Available: ${Object.keys(PATCHES).join(', ')}`);
  process.exit(2);
}

function findAll(filePath, needle) {
  const needleBuf = Buffer.from(needle, 'utf8');
  const fd = fs.openSync(filePath, 'r');
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

function readAt(filePath, offset, length) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  fs.closeSync(fd);
  return buf.subarray(0, n);
}

function includesAll(text, needles = []) {
  return needles.every(needle => text.includes(needle));
}

const anchorOffsets = findAll(filePath, patch.anchor);
const markerOffsets = findAll(filePath, patch.marker);
const guard = patch.guard || {};

const contextGuards = anchorOffsets.map(off => {
  const beforeBytes = guard.beforeBytes || 0;
  const afterBytes = guard.afterBytes || 0;
  const before = readAt(filePath, Math.max(0, off - beforeBytes), Math.min(beforeBytes, off)).toString('utf8');
  const after = readAt(filePath, off + patch.anchor.length, afterBytes).toString('utf8');
  const preMatch = includesAll(before, guard.beforeAll);
  const postMatch = (!guard.afterPrefix || after.startsWith(guard.afterPrefix)) && includesAll(after, guard.afterAll);
  return { offset: off, preMatch, postMatch };
});

function classify(a, m) {
  if (a >= 1 && m === 0) return 'unpatched';
  if (a === 0 && m >= 1) return 'patched';
  return 'abnormal';
}

const result = {
  file: filePath,
  size: fs.statSync(filePath).size,
  patch: patchId,
  anchor: patch.anchor,
  marker: patch.marker,
  anchorCount: anchorOffsets.length,
  markerCount: markerOffsets.length,
  anchorOffsets,
  markerOffsets,
  contextGuards,
  state: classify(anchorOffsets.length, markerOffsets.length),
};

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`File: ${result.file} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Patch: ${result.patch}`);
  console.log(`State: ${result.state}`);
  console.log(`Anchor count: ${result.anchorCount}`);
  console.log(`Marker count: ${result.markerCount}`);
  contextGuards.forEach(g => {
    console.log(`  anchor @ 0x${g.offset.toString(16)} (${g.offset})  preGuard=${g.preMatch} postGuard=${g.postMatch}`);
  });
}

process.exit(result.state === 'abnormal' ? 1 : 0);
