import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const sha256 = /^[a-f\d]{64}$/i;
const component = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[a-z\d](?:[a-z\d._-]*[a-z\d_-])?$/i;

function abortError() { return new DOMException('Runtime installation disposed', 'AbortError'); }

function waitFor(promise, signal, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const abort = () => finish(signal.reason || abortError());
    const timer = timeoutMs ? setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs) : null;
    function finish(error, value) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(null, value), finish);
    if (signal?.aborted) abort();
  });
}

async function fileSize(file) {
  try { return (await stat(file)).size; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

async function hashFile(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

// Exported separately so download behavior can be tested without extracting a runtime.
export async function downloadPart({ part, destination, fetchImpl = globalThis.fetch, tokenProvider,
  signal, onProgress = () => {}, retryDelayMs = 500, connectionTimeoutMs = 30_000, idleTimeoutMs = 30_000 }) {
  if (!Number.isSafeInteger(part.bytes) || part.bytes <= 0 || !sha256.test(part.sha256)) throw new Error('Invalid runtime part');
  await mkdir(path.dirname(destination), { recursive: true });
  for (let attempt = 0; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    let offset = await fileSize(destination);
    if (offset > part.bytes) { await rm(destination); offset = 0; }
    if (offset === part.bytes) {
      if (await hashFile(destination, signal) === part.sha256.toLowerCase()) { onProgress(offset); return; }
      await rm(destination); offset = 0;
    }
    onProgress(offset);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason || abortError());
    signal?.addEventListener('abort', abort, { once: true });
    let reader;
    let handle;
    let fatal = false;
    try {
      const url = new URL(part.url);
      const headers = {};
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid runtime download URL');
      if (url.hostname === 'api.github.com' && url.protocol === 'https:'
        && /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(url.pathname)) {
        headers.Accept = 'application/octet-stream';
        const token = tokenProvider ? await waitFor(tokenProvider(), signal, connectionTimeoutMs, 'GitHub token') : null;
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      if (offset) headers.Range = `bytes=${offset}-`;
      // Native fetch strips Authorization on cross-origin redirects.
      const response = await waitFor(fetchImpl(url.href, { headers, signal: controller.signal, redirect: 'follow' }),
        signal, connectionTimeoutMs, 'Runtime connection');
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        if (!range || Number(range[1]) !== offset || Number(range[2]) !== part.bytes - 1 || Number(range[3]) !== part.bytes) {
          fatal = true;
          throw new Error(`Invalid Content-Range for ${part.name}`);
        }
      } else if (response.status === 200) {
        offset = 0;
        onProgress(0);
      } else {
        fatal = response.status < 500 && response.status !== 408 && response.status !== 429;
        throw new Error(`Runtime download HTTP ${response.status}: ${part.name}`);
      }
      if (!response.body) throw new Error(`Empty download response: ${part.name}`);
      reader = response.body.getReader();
      handle = await open(destination, offset ? 'a' : 'w');
      while (true) {
        const { done, value } = await waitFor(reader.read(), signal, idleTimeoutMs, 'Runtime read');
        if (done) break;
        if (offset + value.byteLength > part.bytes) { fatal = true; throw new Error(`Oversized runtime part: ${part.name}`); }
        // FileHandle.write can complete only part of a buffer.
        let written = 0;
        while (written < value.byteLength) written += (await handle.write(value, written, value.byteLength - written)).bytesWritten;
        offset += value.byteLength;
        onProgress(offset);
      }
      await handle.close(); handle = null;
      if (offset !== part.bytes) throw new Error(`Incomplete runtime part: ${part.name}`);
      if (await hashFile(destination, signal) !== part.sha256.toLowerCase()) {
        fatal = true;
        await rm(destination);
        throw new Error(`SHA-256 mismatch: ${part.name}`);
      }
      return;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || abortError();
      if (fatal || attempt === 3) throw error;
    } finally {
      controller.abort();
      signal?.removeEventListener('abort', abort);
      if (reader) await reader.cancel().catch(() => {});
      if (handle) await handle.close();
    }
    await delay(retryDelayMs * (attempt + 1), undefined, { signal });
  }
}

function safeArchivePath(name, extractedRoot) {
  const normalized = name.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (!name || normalized.startsWith('/') || segments.some(p => p === '..' || /[:*?"<>|\x00-\x1f]/.test(p)
    || (p !== '.' && /[. ]$/.test(p)) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`Unsafe tar path: ${name}`);
  const clean = segments.filter(p => p && p !== '.');
  if (clean[0] !== extractedRoot) throw new Error(`Tar entry outside extracted root: ${name}`);
}

function tarString(buffer) { return buffer.toString('utf8').replace(/\0.*$/s, ''); }

// Inspect actual tar headers, not line-oriented `tar -t` output (names may contain newlines).
export async function validateTar(archive, extractedRoot, signal) {
  const input = createReadStream(archive, { signal });
  const gzip = createGunzip();
  const pumping = pipeline(input, gzip, { signal });
  pumping.catch(() => {});
  let buffer = Buffer.alloc(0), remaining = 0, metadata = null, pax = {}, longName = null, ended = false;
  try {
    for await (const chunk of gzip) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remaining) {
          const count = Math.min(remaining, buffer.length);
          if (metadata) metadata.chunks.push(buffer.subarray(0, Math.min(count, metadata.bytes)));
          if (metadata) metadata.bytes -= Math.min(count, metadata.bytes);
          buffer = buffer.subarray(count); remaining -= count;
          if (remaining) break;
          if (metadata) {
            const text = Buffer.concat(metadata.chunks).toString('utf8');
            if (metadata.type === 'L') longName = text.replace(/\0.*$/s, '');
            else {
              let pos = 0;
              const raw = Buffer.from(text);
              while (pos < raw.length) {
                const space = raw.indexOf(32, pos);
                const length = Number(raw.subarray(pos, space).toString());
                if (space < pos || !Number.isSafeInteger(length) || length <= space - pos + 1 || pos + length > raw.length) throw new Error('Invalid tar PAX record');
                const record = raw.subarray(space + 1, pos + length - 1).toString('utf8');
                const equal = record.indexOf('=');
                const key = record.slice(0, equal), value = record.slice(equal + 1);
                if (key === 'linkpath' || /sparse/i.test(key) || key === 'size') throw new Error('Unsupported tar PAX entry');
                if (key === 'path') pax.path = value;
                pos += length;
              }
            }
            metadata = null;
          }
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every(byte => byte === 0)) { ended = true; continue; }
        if (ended) throw new Error('Tar contains entries after end marker');
        const checksum = Number.parseInt(tarString(header.subarray(148, 156)).trim(), 8);
        let actual = 0;
        for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
        if (checksum !== actual) throw new Error('Invalid tar checksum');
        const sizeText = tarString(header.subarray(124, 136)).trim();
        if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid tar entry size');
        const size = Number.parseInt(sizeText, 8);
        if (!Number.isSafeInteger(size)) throw new Error('Invalid tar entry size');
        const type = String.fromCharCode(header[156] || 48);
        const prefix = tarString(header.subarray(345, 500));
        const name = (prefix ? `${prefix}/` : '') + tarString(header.subarray(0, 100));
        remaining = Math.ceil(size / 512) * 512;
        if (type === 'x' || type === 'L') {
          if (!size || size > 1024 * 1024) throw new Error('Oversized tar metadata');
          metadata = { type, bytes: size, chunks: [] };
        } else {
          if (type !== '0' && type !== '5') throw new Error(`Unsupported tar entry type: ${type} (${name})`);
          safeArchivePath(pax.path || longName || name, extractedRoot);
          if (type === '5' && size) throw new Error('Invalid tar directory size');
          pax = {}; longName = null;
        }
      }
    }
    await pumping;
    if (!ended || remaining || buffer.some(byte => byte !== 0) || metadata || longName || pax.path) throw new Error('Truncated tar archive');
  } catch (error) {
    input.destroy(); gzip.destroy();
    await pumping.catch(() => {});
    throw error;
  }
}

function extract(archive, staging, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar.exe', ['-xzf', archive, '-C', staging, '--no-same-owner', '--no-same-permissions'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Runtime extraction failed (${code}): ${stderr.trim()}`)));
  });
}

async function patchVenv(cfgPath, payload) {
  let cfg = await readFile(cfgPath, 'utf8');
  const replacements = { home: path.join(payload, 'python-base'), executable: path.join(payload, 'python-base', 'python.exe'),
    command: `"${path.join(payload, 'python-base', 'python.exe')}" -m venv "${path.join(payload, '.venv')}"` };
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`^${key}\\s*=.*$`, 'm');
    cfg = pattern.test(cfg) ? cfg.replace(pattern, () => `${key} = ${value}`) : `${cfg.trimEnd()}\n${key} = ${value}\n`;
  }
  await writeFile(cfgPath, cfg);
}

export function createRuntimeInstaller({ root, manifest, fetchImpl = globalThis.fetch, tokenProvider }) {
  if (!manifest || !component.test(manifest.version) || !component.test(manifest.extractedRoot)
    || !sha256.test(manifest.archiveSha256) || !Array.isArray(manifest.parts) || !manifest.parts.length
    || manifest.parts.some(p => !component.test(p.name) || ['ready', 'staging', 'payload.tar.gz'].includes(p.name.toLowerCase())
      || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || !sha256.test(p.sha256))
    || new Set(manifest.parts.map(p => p.name.toLowerCase())).size !== manifest.parts.length
    || !Number.isSafeInteger(manifest.parts.reduce((sum, p) => sum + p.bytes, 0))) throw new Error('Invalid runtime manifest');
  const cache = path.resolve(root, 'runtime-cache', manifest.version);
  const ready = path.join(cache, 'ready');
  const payload = path.join(ready, manifest.extractedRoot);
  const paths = { comfyDir: payload, pythonPath: path.join(payload, '.venv', 'Scripts', 'python.exe'),
    outputDir: path.join(payload, 'output'), modelsDir: path.join(payload, '_dsh_plugin', 'comfyui-agent', 'models') };
  const state = { phase: 'idle', received: 0, total: manifest.parts.reduce((sum, p) => sum + p.bytes, 0), error: null };
  const controller = new AbortController();
  const { signal } = controller;
  let pending;
  async function install() {
    signal.throwIfAborted();
    state.error = null;
    try {
      try {
        const marker = JSON.parse(await readFile(path.join(ready, 'ready.json'), 'utf8'));
        if (marker.version === manifest.version) {
          await Promise.all([stat(paths.pythonPath), stat(path.join(payload, 'main.py')), stat(paths.modelsDir)]);
          await patchVenv(path.join(payload, '.venv', 'pyvenv.cfg'), payload);
          signal.throwIfAborted();
          state.phase = 'ready'; state.received = state.total;
          return { ...paths };
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await mkdir(cache, { recursive: true });
      state.phase = 'downloading';
      let completed = 0;
      for (const part of manifest.parts) {
        await downloadPart({ part, destination: path.join(cache, part.name), fetchImpl, tokenProvider, signal,
          onProgress: bytes => { state.received = completed + bytes; } });
        completed += part.bytes;
      }
      state.phase = 'verifying';
      const archive = path.join(cache, 'payload.tar.gz');
      const output = await open(archive, 'w');
      const hash = createHash('sha256');
      try {
        for (const part of manifest.parts) {
          for await (const chunk of createReadStream(path.join(cache, part.name), { signal })) {
            hash.update(chunk);
            let written = 0;
            while (written < chunk.length) written += (await output.write(chunk, written, chunk.length - written)).bytesWritten;
          }
        }
      } finally { await output.close(); }
      if (hash.digest('hex') !== manifest.archiveSha256.toLowerCase()) throw new Error('Runtime archive SHA-256 mismatch');
      await validateTar(archive, manifest.extractedRoot, signal);
      state.phase = 'extracting';
      const staging = path.join(cache, 'staging');
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging);
      await extract(archive, staging, signal);
      signal.throwIfAborted();
      const stagedPayload = path.join(staging, manifest.extractedRoot);
      await Promise.all([stat(path.join(stagedPayload, 'main.py')), stat(path.join(stagedPayload, '.venv', 'Scripts', 'python.exe')),
        stat(path.join(stagedPayload, 'python-base', 'python.exe')), stat(path.join(stagedPayload, '_dsh_plugin', 'comfyui-agent', 'models'))]);
      await patchVenv(path.join(stagedPayload, '.venv', 'pyvenv.cfg'), payload);
      await mkdir(path.join(stagedPayload, 'output'), { recursive: true });
      await writeFile(path.join(staging, 'ready.json'), JSON.stringify({ version: manifest.version }));
      signal.throwIfAborted();
      // Only the installer-owned version cache is replaced, never an external ComfyUI.
      await rm(ready, { recursive: true, force: true });
      await rename(staging, ready);
      state.phase = 'ready'; state.received = state.total;
      return { ...paths };
    } catch (error) {
      state.phase = signal.aborted ? 'disposed' : 'error';
      state.error = error.message;
      throw error;
    }
  }
  return {
    ensure() {
      if (!pending) {
        pending = install();
        // Callers may dispose without awaiting ensure; retain the rejecting promise API, but handle its rejection.
        pending.catch(() => { pending = null; });
      }
      return pending;
    },
    snapshot() { return { ...state }; },
    dispose() { controller.abort(abortError()); state.phase = 'disposed'; },
  };
}
