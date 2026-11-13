import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { downloadPart, createRuntimeInstaller, validateTar } from '../runtime-installer.js';

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
