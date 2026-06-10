#!/usr/bin/env node
// scan-bin.js — find byte patterns in Claude Code binary (any size, streaming)
// Usage: node scan-bin.js <path-to-binary> [--json]
// Used by both Windows and Unix workflows when grep/python aren't suitable.

const fs = require('fs');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const filePath = args.filter(a => !a.startsWith('--'))[0];
if (!filePath) {
  console.error('Usage: node scan-bin.js <path-to-binary> [--json]');
  process.exit(2);
}

const ANCHOR = '.enum(["sonnet","opus","haiku","fable"])';
const MARKER = 'RTK-SUBAGENT-PATCH';
const PRE = '.string().optional().describe("The type of specialized agent to use for this task"),model:';
const POST = '.optional().describe("Optional model override for this agent.';

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

const anchorOffsets = findAll(filePath, ANCHOR);
const markerOffsets = findAll(filePath, MARKER);

const contextGuards = anchorOffsets.map(off => {
  const before = readAt(filePath, Math.max(0, off - 200), Math.min(200, off)).toString('utf8');
  const after = readAt(filePath, off + ANCHOR.length, 200).toString('utf8');
  return { offset: off, preMatch: before.includes(PRE), postMatch: after.startsWith(POST) };
});

function classify(a, m) {
  if (a >= 1 && m === 0) return 'unpatched';
  if (a === 0 && m >= 1) return 'patched';
  return 'abnormal';
}

const result = {
  file: filePath,
  size: fs.statSync(filePath).size,
  anchor: ANCHOR,
  marker: MARKER,
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
  console.log(`State: ${result.state}`);
  console.log(`Anchor count: ${result.anchorCount}`);
  console.log(`Marker count: ${result.markerCount}`);
  contextGuards.forEach(g => {
    console.log(`  anchor @ 0x${g.offset.toString(16)} (${g.offset})  preGuard=${g.preMatch} postGuard=${g.postMatch}`);
  });
}

process.exit(result.state === 'abnormal' ? 1 : 0);
