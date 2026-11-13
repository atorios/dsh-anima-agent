import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { downloadPart, downloadSegmentedPart, createRuntimeInstaller, validateTar } from '../runtime-installer.js';

const body = Buffer.from('tiny runtime part');
const digest = value => createHash('sha256').update(value).digest('hex');
const part = { name: 'runtime.part001', bytes: body.length, sha256: digest(body), url: 'https://example.test/runtime' };
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'anima-installer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function options(destination, fetchImpl, extra = {}) {
  return { part, destination, fetchImpl, retryDelayMs: 1, connectionTimeoutMs: 100, idleTimeoutMs: 50, ...extra };
}

test('download and independently verify cached part without fetching twice', async t => {
  const destination = path.join(await workspace(t), part.name);
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(body); };
  await downloadPart(options(destination, fetchImpl));
  await downloadPart(options(destination, fetchImpl));
  assert.deepEqual(await readFile(destination), body);
  assert.equal(calls, 1);
});

test('206 resumes only with exact matching Content-Range', async t => {
  const destination = path.join(await workspace(t), part.name);
  await writeFile(destination, body.subarray(0, 4));
  await downloadPart(options(destination, async (_url, init) => {
    assert.equal(init.headers.Range, 'bytes=4-');
    return new Response(body.subarray(4), { status: 206, headers: { 'content-range': `bytes 4-${body.length - 1}/${body.length}` } });
  }));
  assert.deepEqual(await readFile(destination), body);
});

test('Range ignored with 200 restarts rather than appending', async t => {
  const destination = path.join(await workspace(t), part.name);
  await writeFile(destination, body.subarray(0, 4));
  await downloadPart(options(destination, async (_url, init) => {
    assert.equal(init.headers.Range, 'bytes=4-');
    return new Response(body);
  }));
  assert.deepEqual(await readFile(destination), body);
});

test('reject malformed and mismatched 206 ranges before writing', async t => {
  const destination = path.join(await workspace(t), part.name);
  for (const range of ['', `bytes 3-${body.length - 1}/${body.length}`, `bytes 4-${body.length - 2}/${body.length}`, `bytes 4-${body.length - 1}/*`]) {
    await writeFile(destination, body.subarray(0, 4));
    await assert.rejects(downloadPart(options(destination, async () => new Response(body.subarray(4), {
      status: 206, headers: { 'content-range': range },
    }))), /Content-Range/);
    assert.deepEqual(await readFile(destination), body.subarray(0, 4));
  }
});

test('three delayed retries after network errors', async t => {
  const destination = path.join(await workspace(t), part.name);
  let calls = 0;
  await downloadPart(options(destination, async () => {
    if (++calls < 4) throw new TypeError('network reset');
    return new Response(body);
  }));
  assert.equal(calls, 4);
  calls = 0;
  await rm(destination);
  await assert.rejects(downloadPart(options(destination, async () => { calls++; throw new TypeError('offline'); })), /offline/);
  assert.equal(calls, 4);
});

test('network interruption preserves bytes and retries with Range', async t => {
  const destination = path.join(await workspace(t), part.name);
  let calls = 0;
  await downloadPart(options(destination, async (_url, init) => {
    if (++calls === 1) {
      let reads = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (reads++ === 0) controller.enqueue(body.subarray(0, 4));
        else controller.error(new TypeError('connection reset'));
      } }));
    }
    assert.equal(init.headers.Range, 'bytes=4-');
    return new Response(body.subarray(4), { status: 206, headers: { 'content-range': `bytes 4-${body.length - 1}/${body.length}` } });
  }));
  assert.equal(calls, 2);
  assert.deepEqual(await readFile(destination), body);
});

test('hash mismatch removes corrupt part and never publishes it', async t => {
  const destination = path.join(await workspace(t), part.name);
  await assert.rejects(downloadPart(options(destination, async () => new Response(Buffer.alloc(body.length)))), /SHA-256/);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});

test('authorization and octet-stream Accept only go to HTTPS api.github.com', async t => {
  const dir = await workspace(t);
  let tokens = 0;
  for (const [index, url] of ['https://api.github.com/repos/a/b/releases/assets/1', 'https://objects.githubusercontent.com/blob', 'https://evil.test/api.github.com', 'http://api.github.com/asset'].entries()) {
    await downloadPart(options(path.join(dir, String(index)), async (_url, init) => {
      assert.equal(init.headers.Authorization, index === 0 ? 'Bearer secret' : undefined);
      assert.equal(init.headers.Accept, index === 0 ? 'application/octet-stream' : undefined);
      assert.equal(init.redirect, 'follow');
      return new Response(body);
    }, { part: { ...part, url }, tokenProvider: async () => { tokens++; return 'secret'; } }));
  }
  assert.equal(tokens, 1);
});

test('connection and read-idle timeouts retry and terminate', async t => {
  const dir = await workspace(t);
  let calls = 0;
  await assert.rejects(downloadPart(options(path.join(dir, 'connect'), async () => { calls++; return new Promise(() => {}); },
    { connectionTimeoutMs: 5 })), /connection timed out/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(downloadPart(options(path.join(dir, 'idle'), async () => {
    calls++; return new Response(new ReadableStream({ pull() {} }));
  }, { idleTimeoutMs: 5 })), /read timed out/);
  assert.equal(calls, 4);
});

test('ensure shares promise, exposes error state, dispose aborts without unhandled rejection', async t => {
  const root = await workspace(t);
  const manifest = { version: 'v1', archiveSha256: digest(body), extractedRoot: 'ComfyUI-Painting-Local', parts: [part] };
  const installer = createRuntimeInstaller({ root, manifest, fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }) });
  const first = installer.ensure();
  assert.equal(first, installer.ensure());
  installer.dispose();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(installer.snapshot().phase, 'disposed');
  const failed = createRuntimeInstaller({ root, manifest, fetchImpl: async () => new Response('', { status: 404 }) });
  const failure = failed.ensure();
  await assert.rejects(failure, /HTTP 404/);
  assert.equal(failed.snapshot().phase, 'error');
  assert.match(failed.snapshot().error, /404/);
  const retry = failed.ensure();
  assert.notEqual(retry, failure);
  await assert.rejects(retry, /HTTP 404/);
});

test('installer caps downloads at sixteen connections and merges out-of-order segments and parts', { timeout: 5000 }, async t => {
  const root = await workspace(t);
  const bodies = Array.from({ length: 10 }, (_, index) => Buffer.from(`part-${index}`));
  const parts = bodies.map((value, index) => ({ name: `runtime.part00${index + 1}`, bytes: value.length,
    sha256: digest(value), url: `https://example.test/${index}` }));
  const releases = new Map();
  let active = 0, maximum = 0, started = 0;
  const installer = createRuntimeInstaller({ root, segmentThresholdBytes: 1,
    manifest: { version: 'v1', extractedRoot: 'runtime', archiveSha256: digest('wrong archive'), parts },
    fetchImpl: async (url, init) => {
      const index = Number(new URL(url).pathname.slice(1));
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range).map(Number);
      const key = index * 2 + (start ? 1 : 0);
      started++;
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => { releases.set(key, resolve); });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bodies[index].subarray(start, end + 1));
        active--;
        controller.close();
      } }), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bodies[index].length}` } });
    } });
  const pending = assert.rejects(installer.ensure(), /archive SHA-256 mismatch/);
  let previous = 0;
  async function until(check) {
    while (!check()) {
      const { received } = installer.snapshot();
      assert.ok(received >= previous, `${received} went backwards from ${previous}`);
      previous = received;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  await until(() => started === 16);
  assert.equal(maximum, 16);
  assert.equal(releases.size, 16);
  // Finish segment1 first, then segment0; a worker advances only after its whole part.
  releases.get(15)();
  await until(() => installer.snapshot().received === 3);
  assert.equal(started, 16);
  releases.get(14)();
  await until(() => started === 18);
  releases.get(13)(); releases.get(12)();
  await until(() => started === 20);
  for (const key of [...releases.keys()].sort((a, b) => b - a)) releases.get(key)();
  await pending;
  assert.equal(maximum, 16);
  assert.equal(installer.snapshot().received, bodies.reduce((sum, value) => sum + value.length, 0));
  assert.deepEqual(await readFile(path.join(root, 'runtime-cache', 'v1', 'payload.tar.gz')), Buffer.concat(bodies));
});

test('part failure aborts sibling downloads but allows another ensure attempt', { timeout: 5000 }, async t => {
  const root = await workspace(t);
  const parts = Array.from({ length: 10 }, (_, index) => ({ ...part, name: `runtime.part00${index + 1}`,
    url: `https://example.test/${index}` }));
  let calls = 0, aborted = 0, fail;
  const installer = createRuntimeInstaller({ root,
    manifest: { version: 'v1', extractedRoot: 'runtime', archiveSha256: digest(body), parts },
    fetchImpl: async (_url, init) => {
      calls++;
      if (calls > 8) return new Response('', { status: 404 });
      if (calls === 1) {
        await new Promise(resolve => { fail = resolve; });
        return new Response('', { status: 404 });
      }
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => { aborted++; reject(init.signal.reason); }, { once: true });
      });
    } });
  const first = installer.ensure();
  while (calls < 8) await new Promise(resolve => setImmediate(resolve));
  fail();
  await assert.rejects(first, /HTTP 404/);
  assert.equal(aborted, 7);
  assert.equal(calls, 8);
  assert.equal(installer.snapshot().phase, 'error');
  await assert.rejects(installer.ensure(), /HTTP 404/);
  assert.ok(calls > 8);
  assert.equal(installer.snapshot().phase, 'error');
});

test('ready version is reused with no network and returns payload-local paths', async t => {
  const root = await workspace(t);
  const payload = path.join(root, 'runtime-cache', 'v1', 'ready', 'ComfyUI-Painting-Local');
  await mkdir(path.join(payload, '.venv', 'Scripts'), { recursive: true });
  await mkdir(path.join(payload, '_dsh_plugin', 'comfyui-agent', 'models'), { recursive: true });
  await writeFile(path.join(payload, '.venv', 'Scripts', 'python.exe'), '');
  await writeFile(path.join(payload, 'main.py'), '');
  await writeFile(path.join(payload, '.venv', 'pyvenv.cfg'), 'home = D:\\old\\python-base\nexecutable = old\n');
  await writeFile(path.join(payload, '..', 'ready.json'), JSON.stringify({ version: 'v1' }));
  const installer = createRuntimeInstaller({ root, manifest: { version: 'v1', archiveSha256: digest(body), extractedRoot: 'ComfyUI-Painting-Local', parts: [part] },
    fetchImpl: async () => { throw new Error('unexpected request'); } });
  const result = await installer.ensure();
  assert.equal(result.comfyDir, payload);
  assert.equal(result.modelsDir, path.join(payload, '_dsh_plugin', 'comfyui-agent', 'models'));
  assert.equal(installer.snapshot().phase, 'ready');
  const cfg = await readFile(path.join(payload, '.venv', 'pyvenv.cfg'), 'utf8');
  assert.ok(cfg.includes(`home = ${path.join(payload, 'python-base')}`));
  assert.ok(!cfg.includes('D:\\old'));
});

function rangeResponse(init, value = body) {
  const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range).map(Number);
  return new Response(value.subarray(start, end + 1), { status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${value.length}` } });
}

test('segmented helper keeps small parts and old single-file caches on the original path', async t => {
  const dir = await workspace(t);
  await downloadSegmentedPart(options(path.join(dir, 'small'), async (_url, init) => {
    assert.equal(init.headers.Range, undefined);
    return new Response(body);
  }));
  const destination = path.join(dir, 'legacy');
  await writeFile(destination, body.subarray(0, 4));
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    assert.equal(init.headers.Range, 'bytes=4-');
    return new Response(body.subarray(4), { status: 206,
      headers: { 'content-range': `bytes 4-${body.length - 1}/${body.length}` } });
  };
  await downloadSegmentedPart(options(destination, fetchImpl, { segmentThresholdBytes: 1 }));
  await downloadSegmentedPart(options(destination, fetchImpl, { segmentThresholdBytes: 1 }));
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(destination), body);
  await assert.rejects(readFile(`${destination}.segment0`), { code: 'ENOENT' });
});

test('segments resume with absolute ranges and validate the original total, then remove caches', async t => {
  const destination = path.join(await workspace(t), part.name);
  const mid = Math.floor(body.length / 2);
  await writeFile(`${destination}.segment0`, body.subarray(0, 2));
  await writeFile(`${destination}.segment1`, body.subarray(mid, mid + 3));
  const ranges = [];
  await downloadSegmentedPart(options(destination, async (_url, init) => {
    ranges.push(init.headers.Range);
    return rangeResponse(init);
  }, { segmentThresholdBytes: 1 }));
  assert.deepEqual(ranges.sort(), [`bytes=2-${mid - 1}`, `bytes=${mid + 3}-${body.length - 1}`].sort());
  assert.deepEqual(await readFile(destination), body);
  for (const index of [0, 1]) await assert.rejects(readFile(`${destination}.segment${index}`), { code: 'ENOENT' });
});

test('interrupted segments retry only their remaining absolute ranges', async t => {
  const destination = path.join(await workspace(t), part.name);
  const mid = Math.floor(body.length / 2);
  const calls = [0, 0];
  await downloadSegmentedPart(options(destination, async (_url, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range).map(Number);
    const index = end === mid - 1 ? 0 : 1;
    if (++calls[index] > 1) {
      assert.equal(start, (index ? mid : 0) + 2);
      return rangeResponse(init);
    }
    let reads = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (reads++ === 0) controller.enqueue(body.subarray(start, start + 2));
      else controller.error(new TypeError('connection reset'));
    } }), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } });
  }, { segmentThresholdBytes: 1 }));
  assert.deepEqual(calls, [2, 2]);
  assert.deepEqual(await readFile(destination), body);
});

test('fatal segment failure aborts its sibling and waits for cancellation', async t => {
  const destination = path.join(await workspace(t), part.name);
  let fail, started = 0, aborted = 0;
  const pending = downloadSegmentedPart(options(destination, async (_url, init) => {
    started++;
    if (init.headers.Range.startsWith('bytes=0-')) {
      await new Promise(resolve => { fail = resolve; });
      return new Response('', { status: 404 });
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted++; reject(init.signal.reason); }, { once: true });
    });
  }, { segmentThresholdBytes: 1 }));
  const rejected = assert.rejects(pending, /HTTP 404/);
  while (started < 2) await new Promise(resolve => setImmediate(resolve));
  fail();
  await rejected;
  assert.equal(aborted, 1);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});

test('segments reject ignored, malformed, wrong-start, wrong-end and segment-sized totals without writing', async t => {
  const dir = await workspace(t);
  const mid = Math.floor(body.length / 2);
  for (const [index, range] of [null, '', `bytes 1-${mid - 1}/${body.length}`,
    `bytes 0-${mid}/${body.length}`, `bytes 0-${mid - 1}/${mid}`, `bytes 0-${mid - 1}/*`].entries()) {
    const destination = path.join(dir, String(index));
    // The other segment is complete so only segment0 makes a request.
    await writeFile(`${destination}.segment1`, body.subarray(mid));
    let calls = 0;
    await assert.rejects(downloadSegmentedPart(options(destination, async () => {
      calls++;
      return new Response(body.subarray(0, mid), { status: range === null ? 200 : 206,
        headers: { 'content-range': range || '' } });
    }, { segmentThresholdBytes: 1 })), /HTTP 200|Content-Range/);
    assert.equal(calls, 1);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    await assert.rejects(readFile(`${destination}.segment0`), { code: 'ENOENT' });
    assert.deepEqual(await readFile(`${destination}.segment1`), body.subarray(mid));
  }
});

test('segment size errors and full-part hash mismatch retain segment caches', async t => {
  const dir = await workspace(t);
  const mid = Math.floor(body.length / 2);
  for (const [index, length] of [mid - 1, mid + 1, mid].entries()) {
    const destination = path.join(dir, String(index));
    await writeFile(`${destination}.segment1`, body.subarray(mid));
    let calls = 0;
    await assert.rejects(downloadSegmentedPart(options(destination, async (_url, init) => {
      calls++;
      const start = Number(/^bytes=(\d+)-/.exec(init.headers.Range)[1]);
      return new Response(Buffer.alloc(Math.max(0, length - start)), { status: 206,
        headers: { 'content-range': `bytes ${start}-${mid - 1}/${body.length}` } });
    }, { segmentThresholdBytes: 1 })), index === 0 ? /Incomplete/ : index === 1 ? /Oversized/ : /SHA-256/);
    assert.equal(calls, index === 0 ? 4 : 1);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    assert.deepEqual(await readFile(`${destination}.segment1`), body.subarray(mid));
    if (index !== 1) assert.equal((await readFile(`${destination}.segment0`)).length, length);
  }
});

test('segmented requests use the same strict URL authorization policy', async t => {
  const dir = await workspace(t);
  let tokens = 0;
  for (const [index, url] of ['https://api.github.com/repos/a/b/releases/assets/1',
    'https://objects.githubusercontent.com/blob', 'https://evil.test/api.github.com',
    'http://api.github.com/repos/a/b/releases/assets/1', 'https://api.github.com/not-an-asset'].entries()) {
    let calls = 0;
    await downloadSegmentedPart(options(path.join(dir, String(index)), async (_url, init) => {
      calls++;
      assert.equal(init.headers.Authorization, index === 0 ? 'Bearer secret' : undefined);
      assert.equal(init.headers.Accept, index === 0 ? 'application/octet-stream' : undefined);
      assert.equal(init.redirect, 'follow');
      return rangeResponse(init);
    }, { part: { ...part, url }, segmentThresholdBytes: 1, tokenProvider: async () => { tokens++; return 'secret'; } }));
    assert.equal(calls, 2);
  }
  assert.equal(tokens, 2);
});

function tarEntry(name, type = '0', content = Buffer.alloc(0)) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

test('tar preflight allows regular files but rejects traversal, absolute paths, symlinks and hardlinks', async t => {
  const file = path.join(await workspace(t), 'payload.tar.gz');
  const root = 'ComfyUI-Painting-Local';
  await writeFile(file, gzipSync(Buffer.concat([tarEntry(`${root}/main.py`), Buffer.alloc(1024)])));
  await validateTar(file, root);
  for (const [name, type] of [[`${root}/../escape`, '0'], [`/${root}/absolute`, '0'], [`C:/absolute`, '0'], [`${root}/link`, '2'], [`${root}/hard`, '1'], [`${root}/NUL.txt`, '0']]) {
    await writeFile(file, gzipSync(Buffer.concat([tarEntry(name, type), Buffer.alloc(1024)])));
    await assert.rejects(validateTar(file, root), /Unsafe|Unsupported|outside/);
  }
});
