import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Run with: node --experimental-vm-modules --test tests/activation.test.mjs
// Evaluate the unmodified entry and client in isolation: no profile, disk writes,
// downloads, subprocesses, or real ComfyUI server are involved.
const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../comfy.js', import.meta.url), 'utf8');
const manifest = await readFile(new URL('../runtime-manifest.json', import.meta.url), 'utf8');

async function activate(t, config = {}, overrides) {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run Node with --experimental-vm-modules');
  const root = join(pluginDir, 'tests', '__activation_fixture__');
  const settingsFile = join(root, 'comfyui.settings.json');
  const files = new Map([[join(root, 'runtime-manifest.json'), manifest]]);
  if (overrides) files.set(settingsFile, JSON.stringify(overrides));
  const calls = { ensure: 0, disposed: 0, stop: [], spawn: [], fetch: [], clients: [], writes: [] };
  const snapshot = { phase: 'downloading', downloadedBytes: 7, totalBytes: 19 };
  let resolve;
  let reject;
  let settled = false;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const installer = {
    ensure() { calls.ensure++; return pending; },
    snapshot() { return { ...snapshot }; },
    dispose() {
      calls.disposed++;
      if (!settled && calls.ensure > 0) {
        settled = true;
        snapshot.phase = 'cancelled';
        reject(new DOMException('Runtime installation disposed', 'AbortError'));
      }
    },
  };
  const context = vm.createContext({
    URL, AbortSignal, console, setInterval, clearInterval, setTimeout, clearTimeout,
    fetch: async (url) => {
      calls.fetch.push(url);
      const payload = url.endsWith('/queue')
        ? { queue_running: [], queue_pending: [] }
        : { system: { comfyui_version: 'activation-test', os: 'mock' }, devices: [] };
      return { ok: true, text: async () => JSON.stringify(payload) };
    },
    process: { platform: 'win32', kill() { assert.fail('No process may be killed'); } },
  });
  function synthetic(exports) {
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  }
  const fsMock = {
    ...fs,
    existsSync: () => false,
    readFileSync(path) {
      if (files.has(String(path))) return files.get(String(path));
      const error = new Error(`No fixture file: ${path}`);
      error.code = 'ENOENT';
      throw error;
    },
    writeFileSync(path, value) {
      assert.equal(String(path), settingsFile, 'Only virtual settings may be written');
      calls.writes.push(String(path));
      files.set(String(path), value);
    },
  };
  for (const name of ['mkdirSync', 'renameSync', 'unlinkSync', 'createWriteStream']) {
    fsMock[name] = () => assert.fail(`Unexpected filesystem mutation: ${name}`);
  }
  const modules = new Map();
  async function link(specifier) {
    if (modules.has(specifier)) return modules.get(specifier);
    let module;
    if (specifier === './runtime-installer.js') {
      module = synthetic({ createRuntimeInstaller(options) {
        assert.equal(options.root, root);
        assert.deepEqual(JSON.parse(JSON.stringify(options.manifest)), JSON.parse(manifest));
        return installer;
      } });
    } else if (specifier === './comfy.js') {
      const real = new vm.SourceTextModule(clientSource, { context });
      await real.link(link);
      await real.evaluate();
      class CapturedClient extends real.namespace.ComfyClient {
        constructor(settings) { super(settings); calls.clients.push(this); }
        async stopOwned() {
          calls.stop.push({ client: this, pid: this.spawnedPid });
          // Preserve the real no-PID path, but never kill a real process.
          if (!this.spawnedPid) return super.stopOwned();
          this.spawnedPid = null;
          return true;
        }
      }
      module = synthetic({ ComfyClient: CapturedClient, ComfyError: real.namespace.ComfyError });
    } else if (specifier === './github-auth.js') {
      module = synthetic({ githubToken: () => assert.fail('No credential lookup expected') });
    } else if (specifier === './guide.js') {
      module = synthetic({ readGuide: () => 'fixture guide' });
    } else if (specifier === './styles.js') {
      const unused = () => assert.fail('Styles are outside activation tests');
      module = synthetic({ styleCount: () => 0, previewStyle: unused, listStyles: unused,
        ensureStyleImage: unused, searchStyles: unused, styleByTag: unused });
    } else if (specifier === 'node:fs') {
      module = synthetic(fsMock);
    } else if (specifier === 'node:child_process') {
      module = synthetic({ spawn(...args) { calls.spawn.push(args); assert.fail('Activation must not launch Python or a bat'); } });
    } else {
      assert.ok(specifier.startsWith('node:'), `Unexpected dependency: ${specifier}`);
      module = synthetic(await import(specifier));
    }
    modules.set(specifier, module);
    return module;
  }
  const entry = new vm.SourceTextModule(indexSource, {
    context,
    initializeImportMeta(meta) { meta.url = new URL('./__activation_fixture__/index.js', import.meta.url).href; },
  });
  await entry.link(link);
  await entry.evaluate();
  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  const ctx = {
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    get(name) { assert.equal(name, 'attachments'); return undefined; },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    systemPrompt: { section() { return () => {}; } },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
    inject(services, callback) {
      assert.deepEqual(Array.from(services), ['webServer']);
      callback(ctx);
    },
  };
  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.reverse()) await cleanup();
    await Promise.resolve();
  }
  t.after(dispose);
  entry.namespace.apply(ctx, config);
  const tool = tools.get('comfyui');
  assert.ok(tool, 'apply must register the tool');
  async function route(method = 'GET', body) {
    const req = { method, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } };
    let status;
    let result;
    await routes.get('/comfyui-agent/settings').handler(req, {
      writeHead(code) { status = code; },
      end(value) { result = JSON.parse(value); },
    });
    return { status, body: result };
  }
  return { calls, tool, route, dispose, snapshot, files, settingsFile,
    finish(paths = { comfyDir: join(root, 'runtime', 'ComfyUI'), pythonPath: join(root, 'runtime', 'python.exe'), outputDir: join(root, 'runtime', 'output') }) {
      settled = true;
      snapshot.phase = 'ready';
      resolve(paths);
      return paths;
    },
  };
}

test('apply starts installer before any tool call and never launches a bat or server', async t => {
  const h = await activate(t);
  assert.equal(h.calls.ensure, 1);
  assert.equal(h.calls.clients.length, 1);
  assert.deepEqual(h.calls.spawn, []);
  assert.deepEqual(h.calls.fetch, []);
  assert.deepEqual(h.calls.writes, []);
});

test('status waits for deferred ensure and uses the prepared runtime paths', async t => {
  const h = await activate(t);
  let completed = false;
  const status = h.tool.execute({ action: 'status' }).then(value => { completed = true; return value; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(h.calls.fetch, []);
  const paths = h.finish();
  const result = await status;
  assert.equal(result.ok, true, result.result);
  assert.match(result.result, /ComfyUI activation-test/);
  assert.equal(h.calls.clients.length, 2);
  const client = h.calls.clients.at(-1);
  for (const [key, value] of Object.entries(paths)) assert.equal(client[key], value);
  const settings = await h.route();
  for (const [key, value] of Object.entries(paths)) assert.equal(settings.body[key], value);
  assert.equal(h.calls.fetch.length, 2);
  assert.deepEqual(h.calls.spawn, []);
});

test('settings tool and HTTP GET expose runtime.snapshot without waiting for installation', async t => {
  const h = await activate(t);
  const result = await h.tool.execute({ action: 'settings' });
  assert.equal(result.ok, true, result.result);
  const settings = JSON.parse(result.result.split('\noverrides file: ')[0]);
  assert.deepEqual(settings.runtime, h.snapshot);
  const response = await h.route();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.runtime, h.snapshot);
  assert.equal(h.calls.ensure, 1);
  assert.deepEqual(h.calls.fetch, []);
});

test('dispose cancels pending installation and stops the currently owned client', async t => {
  const h = await activate(t);
  const client = h.calls.clients[0];
  client.spawnedPid = 424242;
  await h.dispose();
  assert.equal(h.calls.disposed, 1);
  assert.equal(h.snapshot.phase, 'cancelled');
  assert.equal(h.calls.stop.length, 1);
  assert.equal(h.calls.stop[0].client, client);
  assert.equal(h.calls.stop[0].pid, 424242);
  assert.equal(client.spawnedPid, null);
  assert.equal(h.calls.clients.length, 1);
});

test('configured or persisted external comfyDir never invokes installer ensure', async t => {
  for (const persisted of [false, true]) {
    const config = { comfyDir: join(pluginDir, 'external-fixture') };
    const h = await activate(t, persisted ? {} : config, persisted ? config : undefined);
    assert.equal(h.calls.ensure, 0);
    const result = await h.tool.execute({ action: 'status' });
    assert.equal(result.ok, true, result.result);
    assert.equal(h.calls.ensure, 0);
    assert.equal(h.calls.clients[0].comfyDir, config.comfyDir);
    assert.deepEqual(h.calls.spawn, []);
    await h.dispose();
  }
});

test('simple mode settings via tool and route retain PID and launch bookkeeping', async t => {
  const h = await activate(t);
  h.finish();
  await h.tool.execute({ action: 'status' });
  const client = h.calls.clients.at(-1);
  const starting = Promise.resolve('already starting');
  client.spawnedPid = 424243;
  client._starting = starting;
  client.lastActivity = 12345;
  const result = await h.tool.execute({ action: 'settings', set: { mode: 'free' } });
  assert.equal(result.ok, true, result.result);
  assert.equal(client.spawnedPid, 424243);
  assert.equal(client._starting, starting);
  assert.equal(client.lastActivity, 12345);
  const response = await h.route('POST', { set: { mode: 'guided', imageCount: 2 } });
  assert.equal(response.status, 200);
  assert.equal(response.body.values.mode, 'guided');
  assert.equal(client.spawnedPid, 424243);
  assert.equal(client._starting, starting);
  assert.equal(client.lastActivity, 12345);
  assert.equal(h.calls.stop.length, 0);
  assert.deepEqual(JSON.parse(h.files.get(h.settingsFile)), { mode: 'guided', imageCount: 2 });
  await h.dispose();
  assert.equal(h.calls.stop[0].client, client);
  assert.equal(h.calls.stop[0].pid, 424243);
});
