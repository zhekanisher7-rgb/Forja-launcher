'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { filterVersions } = require('../../src/main/core/versions');
const { downloadAll } = require('../../src/main/core/download');
const { mergeVersions } = require('../../src/main/core/install');

const versions = [
  { id: '1.21', type: 'release' }, { id: '24w14a', type: 'snapshot' },
  { id: 'b1.7.3', type: 'old_beta' }, { id: 'a1.0.4', type: 'old_alpha' }, { id: '1.20.1', type: 'release' },
];

test('filterVersions', () => {
  assert.deepEqual(filterVersions(versions).map((v) => v.id), ['1.21', '1.20.1']);
  assert.deepEqual(filterVersions(versions, { release: false, snapshot: true }).map((v) => v.id), ['24w14a']);
  assert.deepEqual(filterVersions(versions, { old: true, release: false }).map((v) => v.id), ['b1.7.3', 'a1.0.4']);
  assert.deepEqual(filterVersions(versions, { query: '20' }).map((v) => v.id), ['1.20.1']);
});

test('mergeVersions (inheritsFrom) — child libs first, args concatenated', () => {
  const parent = { id: 'p', libraries: [{ name: 'a:b:1' }], arguments: { game: ['--p'], jvm: ['-P'] }, mainClass: 'M', downloads: { client: {} } };
  const child = { id: 'c', inheritsFrom: 'p', libraries: [{ name: 'x:y:2' }], arguments: { game: ['--c'] }, mainClass: 'C' };
  const m = mergeVersions(parent, child);
  assert.equal(m.id, 'c');
  assert.equal(m.mainClass, 'C');
  assert.deepEqual(m.libraries.map((l) => l.name), ['x:y:2', 'a:b:1']);
  assert.deepEqual(m.arguments.game, ['--p', '--c']);
  assert.deepEqual(m.arguments.jvm, ['-P']);
  assert.equal(m._jarId, 'p');
});

test('downloadAll: parallel, sha1 verification, skip, retry, mismatch error', async () => {
  const bodies = {};
  for (let i = 0; i < 20; i++) bodies[`/f${i}`] = crypto.randomBytes(1000 + i * 100);
  let flaky = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/flaky' && flaky++ < 2) { res.statusCode = 500; return res.end(); }
    const b = req.url === '/flaky' ? bodies['/f0'] : bodies[req.url];
    if (!b) { res.statusCode = 404; return res.end(); }
    res.end(b);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-dl-'));
  const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
  try {
    const tasks = Object.entries(bodies).map(([u, b]) => ({ url: base + u, path: path.join(dir, u.slice(1)), sha1: sha(b), size: b.length }));
    tasks.push({ url: `${base}/flaky`, path: path.join(dir, 'flaky'), sha1: sha(bodies['/f0']), size: bodies['/f0'].length });
    const events = [];
    const r1 = await downloadAll(tasks, { concurrency: 8, onProgress: (p) => events.push(p) });
    assert.equal(r1.downloaded, 21);
    assert.equal(events.at(-1).doneFiles, 21);
    assert.equal(events.at(-1).doneBytes, events.at(-1).totalBytes);
    const r2 = await downloadAll(tasks, { concurrency: 8 });
    assert.equal(r2.skipped, 21);
    // corrupt a file -> re-downloaded
    fs.writeFileSync(tasks[3].path, 'garbage');
    const r3 = await downloadAll(tasks, { concurrency: 8 });
    assert.equal(r3.downloaded, 1);
    await assert.rejects(downloadAll([{ url: `${base}/f1`, path: path.join(dir, 'bad'), sha1: '0'.repeat(40) }], { retries: 1 }), /SHA1 mismatch/);
    await assert.rejects(downloadAll([{ url: `${base}/missing`, path: path.join(dir, 'm') }]), /404/);
    // cancellation
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(downloadAll([{ url: `${base}/f2`, path: path.join(dir, 'c') }], { signal: ac.signal }), { name: 'CancelledError' });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadAll resumes a partial .part file with HTTP Range', async () => {
  const body = crypto.randomBytes(200000);
  const ranges = [];
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      ranges.push(start);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` });
      return res.end(body.subarray(start));
    }
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-resume-'));
  try {
    const dest = path.join(dir, 'big.bin');
    fs.writeFileSync(`${dest}.part`, body.subarray(0, 123456));
    const sha1 = crypto.createHash('sha1').update(body).digest('hex');
    const r = await downloadAll([{ url: `http://127.0.0.1:${server.address().port}/big`, path: dest, sha1, size: body.length }]);
    assert.equal(r.downloaded, 1);
    assert.deepEqual(ranges, [123456]);
    assert.ok(fs.readFileSync(dest).equals(body));
    assert.ok(!fs.existsSync(`${dest}.part`));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
