/**
 * ComfyUI client for the Harness plugin.
 *
 * Every call goes to the live ComfyUI HTTP API, so the Harness operates the
 * same server the user is looking at. No dependencies: Node's global fetch.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kill a launcher and everything it spawned; taskkill /T is the Windows tree kill. */
function stopProcessTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
    resolve();
  });
}

export class ComfyError extends Error {
  constructor(message, { unreachable = false } = {}) {
    super(message);
    this.name = 'ComfyError';
    this.unreachable = unreachable;
  }
}

export class ComfyClient {
  /**
   * @param {{
   *   baseUrl?: string, timeoutMs?: number, queueTimeoutMs?: number, outputDir?: string,
   *   comfyDir?: string, pythonPath?: string, startArgs?: string[], startTimeoutMs?: number,
   * }} config
   */
  constructor(config = {}) {
    this.baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = Number(config.timeoutMs) || 120000;
    this.queueTimeoutMs = Number(config.queueTimeoutMs) || 900000;
    this.outputDir = String(config.outputDir || '').replace(/[\\/]+$/, '');
    this.comfyDir = String(config.comfyDir || '').replace(/[\\/]+$/, '');
    this.pythonPath = String(config.pythonPath || '');
    this.startArgs = Array.isArray(config.startArgs) ? config.startArgs : [];
    this.startTimeoutMs = Number(config.startTimeoutMs) || 180000;
    this.port = new URL(this.baseUrl).port || '8188';
    this._starting = null;
    // Tracked only for a process this client launched, so idle shutdown never
    // kills a ComfyUI the user started themselves.
    this.spawnedPid = null;
    this.lastActivity = Date.now();
  }

  toAbsolute(outputPath) {
    if (!this.outputDir || !outputPath) return outputPath;
    return `${this.outputDir}\\${outputPath.replace(/\//g, '\\')}`;
  }

  /**
   * Launch ComfyUI and wait for it to answer. Concurrent callers share one
   * attempt, so a burst of tool calls starts exactly one process.
   */
  async ensureStarted() {
    try {
      await this.request('/system_stats', { timeoutMs: 5000 });
      return `ComfyUI is already running at ${this.baseUrl}`;
    } catch {
      // not up, continue to launch
    }
    if (!this.comfyDir) {
      throw new ComfyError(
        `ComfyUI at ${this.baseUrl} is unreachable and this plugin has no comfyDir configured to start it. ` +
          'Set comfyDir in the plugin config, or start ComfyUI yourself.',
      );
    }
    if (!this._starting) {
      this._starting = this.launchAndWait().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  async launchAndWait() {
    const python = this.pythonPath || join(this.comfyDir, '.venv', 'Scripts', 'python.exe');
    const args = this.startArgs.length > 0 ? this.startArgs : ['-s', 'main.py', '--port', this.port];
    let child;
    try {
      child = spawn(python, args, {
        cwd: this.comfyDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      throw new ComfyError(`could not launch ComfyUI via ${python}: ${error?.message || error}`);
    }
    child.on('error', () => {});
    child.unref();

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        await this.request('/system_stats');
        this.spawnedPid = child.pid ?? null;
        this.lastActivity = Date.now();
        return `ComfyUI started (port ${this.port}, ~${Math.round((Date.now() - (deadline - this.startTimeoutMs)) / 1000)}s)`;
      } catch {
        // still booting
      }
    }
    throw new ComfyError(
      `ComfyUI did not answer within ${Math.round(this.startTimeoutMs / 1000)}s of launch. ` +
        `Run it manually from ${this.comfyDir} to see the startup error.`,
    );
  }

  /**
   * Stop the process this client launched once it has been idle long enough.
   * Returns true when a process was stopped.
   */
  async stopIfIdle(minutes) {
    if (!this.spawnedPid) return false;
    if (Date.now() - this.lastActivity < minutes * 60_000) return false;
    const stopped = await this.stopOwned();
    return stopped;
  }

  /** Stop the process this client launched, if any. */
  async stopOwned() {
    const pid = this.spawnedPid;
    if (!pid) return false;
    this.spawnedPid = null;
    await stopProcessTree(pid);
    return true;
  }

  async call(path, options = {}) {
    try {
      return await this.request(path, options);
    } catch (error) {
      if (!error?.unreachable) throw error;
      await this.ensureStarted();
      return this.request(path, options);
    }
  }

  async request(path, { method = 'GET', body, timeoutMs } = {}) {
    const url = `${this.baseUrl}${path}`;
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs) });
    } catch (error) {
      throw new ComfyError(`ComfyUI at ${this.baseUrl} is unreachable (${error?.message || error}).`, {
        unreachable: true,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ComfyError(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 600)}`);
    }
    if (!text) {
      this.lastActivity = Date.now();
      return {};
    }
    try {
      const parsed = JSON.parse(text);
      this.lastActivity = Date.now();
      return parsed;
    } catch {
      this.lastActivity = Date.now();
      return { raw: text.slice(0, 2000) };
    }
  }

  // ---- reads ----

  async status() {
    const stats = await this.call('/system_stats');
    const queue = await this.call('/queue');
    const system = stats.system || {};
    const device = (stats.devices || [])[0] || {};
    const gb = (n) => (Number(n || 0) / 1024 ** 3).toFixed(1);
    return [
      `ComfyUI ${system.comfyui_version || '?'} on ${system.os || '?'}`,
      `device: ${device.name || 'none'} (${device.type || '?'})`,
      `VRAM ${gb(device.vram_total)} GB total, ${gb(device.vram_free)} GB free`,
      `RAM ${gb(system.ram_free)} GB free`,
      `queue: ${(queue.queue_running || []).length} running, ${(queue.queue_pending || []).length} pending`,
    ].join(' | ');
  }

  async listModels(folder) {
    const dir = String(folder || 'checkpoints').replace(/^\/+|\/+$/g, '');
    const models = await this.call(`/models/${encodeURIComponent(dir)}`);
    if (!Array.isArray(models) || models.length === 0) {
      return `models/${dir} is empty. Nothing can be generated from it until a file is added.`;
    }
    return `models/${dir} (${models.length}):\n${models.map((m) => `  - ${m}`).join('\n')}`;
  }

  async objectInfo() {
    if (!this._objectInfo) this._objectInfo = await this.call('/object_info', { timeoutMs: 300000 });
    return this._objectInfo;
  }

  async searchNodes(query, limit = 25) {
    const info = await this.objectInfo();
    const needle = String(query || '').toLowerCase();
    const hits = Object.keys(info)
      .filter((name) => {
        if (!needle) return true;
        const spec = info[name] || {};
        return `${name} ${spec.category || ''} ${spec.description || ''}`.toLowerCase().includes(needle);
      })
      .sort();
    if (hits.length === 0) return `No node class matches "${query}".`;
    const shown = hits.slice(0, limit);
    const more = hits.length > limit ? `\n  ... ${hits.length - limit} more` : '';
    return `matching node classes (${hits.length}):\n${shown.map((h) => `  - ${h}`).join('\n')}${more}`;
  }

  async nodeInfo(nodeClass) {
    const info = await this.objectInfo();
    const spec = info[nodeClass];
    if (!spec) return `Unknown node class "${nodeClass}". Use comfy_search_nodes to find the exact name.`;
    const lines = [`${nodeClass}  [${spec.category || '?'}]`];
    if (spec.description) lines.push(`  desc: ${spec.description}`);
    const input = spec.input || {};
    for (const section of ['required', 'optional']) {
      const fields = input[section] || {};
      const names = Object.keys(fields);
      if (names.length === 0) continue;
      lines.push(`  ${section} inputs:`);
      for (const name of names) {
        lines.push(`    ${name}: ${JSON.stringify(fields[name]).slice(0, 240)}`);
      }
    }
    if (spec.output) lines.push(`  outputs: ${JSON.stringify(spec.output)}`);
    if (spec.output_name) lines.push(`  output names: ${JSON.stringify(spec.output_name)}`);
    return lines.join('\n');
  }

  async viewQueue() {
    const queue = await this.call('/queue');
    const running = queue.queue_running || [];
    const pending = queue.queue_pending || [];
    const summarise = (items) =>
      items.map((item) => {
        const prompt = item?.[2] || {};
        const classes = [...new Set(Object.values(prompt).map((v) => v?.class_type).filter(Boolean))];
        return `    ${item?.[1] || '?'}: ${classes.slice(0, 6).join(', ') || '(unknown)'}`;
      });
    const parts = [`running=${running.length} pending=${pending.length}`];
    if (running.length) parts.push('  running:', ...summarise(running));
    if (pending.length) parts.push('  pending:', ...summarise(pending));
    return parts.join('\n');
  }

  async history(limit = 5) {
    const hist = await this.call(`/history?max_items=${Number(limit) || 5}`);
    const ids = Object.keys(hist || {});
    if (ids.length === 0) return 'history is empty';
    const lines = ids.map((id) => {
      const entry = hist[id] || {};
      const status = entry.status || {};
      const files = Object.values(entry.outputs || {})
        .flatMap((node) => node?.images || [])
        .map((image) => image?.filename)
        .filter(Boolean);
      return `  ${id} completed=${status.completed === true} files=${files.join(', ') || 'none'}`;
    });
    return `history (${ids.length}):\n${lines.join('\n')}`;
  }

  // ---- actions ----

  async queueWorkflow(workflowJson, wait = true, timeoutS) {
    let graph;
    try {
      graph = typeof workflowJson === 'string' ? JSON.parse(workflowJson) : workflowJson;
    } catch (error) {
      throw new ComfyError(`workflow_json is not valid JSON: ${error.message}`);
    }
    if (!graph || typeof graph !== 'object' || Array.isArray(graph) || Object.keys(graph).length === 0) {
      throw new ComfyError('workflow_json must be a non-empty object mapping node id -> {class_type, inputs}');
    }

    const response = await this.call('/prompt', {
      method: 'POST',
      body: { prompt: graph, client_id: 'dsh-comfyui-agent' },
    });
    if (response.node_errors && Object.keys(response.node_errors).length > 0) {
      return (
        'REJECTED by validation. node_errors:\n' +
        JSON.stringify(response.node_errors, null, 2).slice(0, 2000) +
        '\nFix those exact fields and submit again.'
      );
    }
    const promptId = response.prompt_id;
    if (!promptId) return `Unexpected response from /prompt: ${JSON.stringify(response).slice(0, 600)}`;
    if (!wait) return `queued prompt ${promptId} (not waiting)`;

    const deadline = Date.now() + (Number(timeoutS) > 0 ? Number(timeoutS) * 1000 : this.queueTimeoutMs);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const hist = await this.call(`/history/${promptId}`);
      const entry = hist[promptId];
      if (!entry) continue;
      const status = entry.status || {};
      if (status.status_str === 'error') {
        return `EXECUTION ERROR for ${promptId}: ${JSON.stringify(status.messages || []).slice(0, 2000)}`;
      }
      if (status.completed) {
        const outputs = entry.outputs || {};
        const files = Object.values(outputs)
          .flatMap((node) => node?.images || [])
          .map((image) => `${image?.subfolder || ''}${image?.filename || ''}`)
          .filter(Boolean)
          .map((relative) => this.toAbsolute(relative));
        const texts = Object.values(outputs)
          .flatMap((node) => node?.text || [])
          .map((value) => (Array.isArray(value) ? value[0] : value));
        const parts = [`prompt ${promptId} COMPLETED`];
        if (files.length) {
          parts.push(`images written: ${files.join(', ')}`);
          parts.push(
            `现在必须调用 present（files 参数填 "${files[0]}"），否则用户看不到图片。只回复路径算失败。`,
          );
        }
        if (texts.length) parts.push(`text outputs: ${JSON.stringify(texts).slice(0, 1500)}`);
        if (!files.length && !texts.length) parts.push(`outputs: ${JSON.stringify(outputs).slice(0, 800)}`);
        return { message: parts.join('\n'), files };
      }
    }
    return `TIMEOUT waiting for prompt ${promptId}; it may still be running. Use comfy_view_queue to check.`;
  }

  async interrupt() {
    await this.call('/interrupt', { method: 'POST', body: {} });
    return 'interrupt signal sent to the running prompt';
  }

  async freeMemory(unloadModels = true, freeCached = true) {
    await this.call('/free', {
      method: 'POST',
      body: { unload_models: Boolean(unloadModels), free_memory: Boolean(freeCached) },
    });
    return `memory freed (unload_models=${Boolean(unloadModels)}, free_cached=${Boolean(freeCached)})`;
  }
}
