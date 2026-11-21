/**
 * Harness plugin: operate a running ComfyUI instance from any session.
 *
 * Registers one tool with an `action` parameter covering the whole surface, so
 * the model sees a single well-described entry instead of nine near-duplicates.
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

import { ComfyClient, ComfyError } from './comfy.js';
import { readGuide } from './guide.js';
import { createRuntimeInstaller } from './runtime-installer.js';
import { githubToken } from './github-auth.js';
import { previewStyle, listStyles, ensureStyleImage, searchStyles, styleByTag, styleCount } from './styles.js';

export const name = 'comfyui-agent';

export const inject = ['tools', 'systemPrompt'];

/** Fields a user may change at runtime through the settings action. */
const SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'comfyui.settings.json');
const EDITABLE = [
  'mode',
  'imageCount',
  'baseUrl',
  'comfyDir',
  'pythonPath',
  'outputDir',
  'timeoutMs',
  'queueTimeoutMs',
  'startTimeoutMs',
  'idleShutdownMinutes',
];

const MODES = ['free', 'guided'];

const NUMERIC_SETTINGS = new Set(['timeoutMs', 'queueTimeoutMs', 'startTimeoutMs', 'idleShutdownMinutes']);

const SETTINGS_ROUTE = '/comfyui-agent/settings';

const MODELS_ROUTE = '/comfyui-agent/models';

const STYLES_ROUTE = '/comfyui-agent/styles';

const STYLE_IMAGE_ROUTE = '/comfyui-agent/style-image';

/** Folders the Settings tab lists, in display order. */
const MODEL_FOLDERS = ['diffusion_models', 'checkpoints', 'text_encoders', 'vae', 'loras'];

/** Extensions a LoRA upload may carry. */
const LORA_EXTENSIONS = new Set(['.safetensors', '.pt', '.ckpt', '.bin']);

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Reject anything that is not a plain file name inside models/loras. */
function safeFileName(raw) {
  const name = String(raw || '');
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return '';
  const base = basename(name).replace(/[^\w.\- ]+/g, '_');
  if (!base || base.startsWith('.')) return '';
  return LORA_EXTENSIONS.has(extname(base).toLowerCase()) ? base : '';
}

function loadOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const clean = {};
    for (const key of EDITABLE) {
      if (parsed[key] !== undefined) clean[key] = parsed[key];
    }
    return clean;
  } catch {
    return {};
  }
}

const ACTIONS = [
  'guide',
  'styles',
  'settings',
  'status',
  'start_server',
  'stop_server',
  'list_models',
  'search_nodes',
  'node_info',
  'view_queue',
  'history',
  'queue_workflow',
  'interrupt',
  'free_memory',
];

const DESCRIPTION = [
  'Inspect and operate a running ComfyUI instance at the configured baseUrl.',
  '',
  'Actions:',
  '- guide: the local playbook. Installed models, a ready-to-submit workflow, the prompt rules this setup needs, and known failure modes. Read it before the first image of a session.',
  `- styles: search the optional NovelAI style catalogue (${styleCount()} prompt strings, each with a reference image; 0 means the catalogue is empty and style tags are unavailable). Pass \`query\` to filter, or \`preview\` with an ordinal to download that entry's reference image and show it to the user.`,
  '- settings: read the plugin settings, or change them by passing `set` (mode, server address, ComfyUI directory, output directory, timeouts, idle shutdown). Changes apply immediately and persist across restarts. `mode` is "free" (generate from whatever prompt the user gives, no discussion) or "guided" (discuss style choices first).',
  '- status: version, GPU, free VRAM/RAM, queue depth. Start here to confirm ComfyUI is up.',
  '- start_server: launch ComfyUI and wait until it answers. Only needed when it is stopped; every other action starts it automatically on a connection failure.',
  '- stop_server: stop the ComfyUI process this plugin launched, freeing its memory. A ComfyUI you started yourself is never touched.',
  '- list_models: files available in one model folder. Check this before building a workflow.',
  '- search_nodes: find node classes by substring when you are unsure of an exact name.',
  '- node_info: the exact input names, types and defaults of one node class. Call this before wiring a node.',
  '- view_queue: what is running and pending.',
  '- history: recently finished prompts and the files they wrote.',
  '- queue_workflow: submit a full workflow and wait for the result.',
  '- interrupt: stop the currently executing prompt.',
  '- free_memory: unload models and free cached VRAM.',
].join('\n');

const WORKFLOW_HELP = [
  'A workflow is a JSON object mapping node id (string) -> {"class_type": "...", "inputs": {...}}.',
  'Connect nodes by using ["<node_id>", <output_index>] as an input value.',
  'Every graph needs a node that writes a file, e.g. SaveImage (input: images).',
  'If the result is REJECTED, node_errors names the exact node and field to fix; correct it and resubmit.',
].join(' ');

function text(value) {
  return String(value ?? '');
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** Locate a ComfyUI checkout by walking up from the plugin directory. */
function detectComfyDir(start) {
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'main.py')) && existsSync(join(dir, 'comfy'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

const MODEL_PATHS_MARKER = '# added by @local/comfyui-agent';

/**
 * The bundled weights live in the plugin folder, so ComfyUI has to be told
 * where they are. Write the entry into the checkout's extra_model_paths.yaml,
 * which both a plugin-launched and a manually launched server read.
 */
function ensureModelPaths(comfyDir) {
  if (!comfyDir || !existsSync(join(PLUGIN_DIR, 'models'))) return '';
  const target = join(comfyDir, 'extra_model_paths.yaml');
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (existing.includes(MODEL_PATHS_MARKER)) return target;

  const base = join(PLUGIN_DIR, 'models').replace(/\\/g, '/');
  const block = [
    MODEL_PATHS_MARKER,
    'comfyui_agent:',
    `  base_path: ${base}`,
    '  diffusion_models: diffusion_models',
    '  text_encoders: text_encoders',
    '  vae: vae',
    '  loras: loras',
    '',
  ].join('\n');
  writeFileSync(target, existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block);
  return target;
}

const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Persist generated images as durable attachments so the result carries image
 * blocks. Without a store the tool still returns the paths as text.
 */
async function persistImages(store, files) {
  if (!store || files.length === 0) return [];
  const refs = [];
  for (const file of files) {
    const mediaType = IMAGE_MEDIA_TYPES[extname(file).toLowerCase()];
    if (!mediaType) continue;
    try {
      const data = await readFile(file);
      refs.push(await store.saveImage({ data, mediaType, name: basename(file) }));
    } catch {
      // An unreadable output file must not fail the generation that produced it.
    }
  }
  return refs;
}

export function apply(ctx, config = {}) {
  const settings = {
    mode: MODES.includes(String(config.mode)) ? String(config.mode) : 'guided',
    imageCount: Number.isInteger(config.imageCount) && config.imageCount >= 1 && config.imageCount <= 5 ? config.imageCount : 1,
    baseUrl: config.baseUrl || 'http://127.0.0.1:8188',
    timeoutMs: Number(config.timeoutMs) || 120000,
    queueTimeoutMs: Number(config.queueTimeoutMs) || 900000,
    outputDir: config.outputDir || '',
    comfyDir: config.comfyDir || detectComfyDir(PLUGIN_DIR),
    pythonPath: config.pythonPath || '',
    startArgs: Array.isArray(config.startArgs) ? config.startArgs : [],
    startTimeoutMs: Number(config.startTimeoutMs) || 180000,
    idleShutdownMinutes: Number(config.idleShutdownMinutes) || 0,
    systemPrompt: config.systemPrompt !== false,
  };
  // A file written by the settings action overrides the bundle row, so values
  // survive restarts without editing the profile patch.
  Object.assign(settings, loadOverrides());
  let externalRuntime = Boolean(config.comfyDir || loadOverrides().comfyDir);
  // No absolute paths ship with the plugin: when the output directory is unset,
  // derive it from the detected ComfyUI root so a copied folder just works.
  if (!settings.outputDir && settings.comfyDir) {
    settings.outputDir = join(settings.comfyDir, 'output');
  }
  const runtime = createRuntimeInstaller({
    root: PLUGIN_DIR,
    manifest: JSON.parse(readFileSync(join(PLUGIN_DIR, 'runtime-manifest.json'), 'utf8')),
    // Public repository: a credential is a bonus (rate limits), never a requirement.
    tokenProvider: async () => {
      try { return await githubToken(); } catch { return null; }
    },
  });
  ctx.effect(() => () => runtime.dispose());
  let runtimeApplied = false;
  const ready = async () => {
    if (externalRuntime) return;
    const paths = await runtime.ensure();
    if (!runtimeApplied && !externalRuntime) {
      Object.assign(settings, { comfyDir: paths.comfyDir, pythonPath: paths.pythonPath, outputDir: paths.outputDir });
      client = new ComfyClient(settings);
      runtimeApplied = true;
    }
  };

  let client = new ComfyClient(settings);
  ctx.effect(() => () => { client.stopOwned().catch(() => {}); });
  // Installing this bundle authorizes automatic preparation; errors remain visible.
  ready().catch(() => {});
  const attachments = ctx.get('attachments');

  const currentSettings = () => {
    const view = {};
    for (const key of EDITABLE) view[key] = settings[key];
    return { ...view, runtime: runtime.snapshot() };
  };

  /** One operation, two callers: the `settings` tool action and the HTTP route. */
  const updateSettings = (patch) => {
    const applied = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!EDITABLE.includes(key)) {
        throw new ComfyError(`"${key}" is not an editable setting. Editable: ${EDITABLE.join(', ')}`);
      }
      if (key === 'mode') {
        const value = String(raw);
        if (!MODES.includes(value)) {
          throw new ComfyError(`mode must be one of: ${MODES.join(', ')}`);
        }
        applied.mode = value;
        continue;
      }
      if (key === 'imageCount') {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 5) {
          throw new ComfyError('imageCount must be an integer from 1 to 5');
        }
        applied.imageCount = value;
        continue;
      }
      applied[key] = NUMERIC_SETTINGS.has(key) ? Number(raw) : String(raw);
    }
    const merged = { ...loadOverrides(), ...applied };
    writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
    Object.assign(settings, applied);
    if (Object.hasOwn(applied, 'comfyDir')) externalRuntime = Boolean(applied.comfyDir);
    if (applied.comfyDir) ensureModelPaths(settings.comfyDir);
    const next = new ComfyClient(settings);
    const { _starting, spawnedPid, lastActivity } = client;
    Object.assign(client, next, { _starting, spawnedPid, lastActivity });
    return applied;
  };

  const run = async (args) => {
    const action = text(args?.action || 'status');
    if (!['guide', 'styles', 'settings', 'stop_server', 'interrupt', 'free_memory'].includes(action)) await ready();
    switch (action) {
      case 'guide':
        return readGuide();
      case 'styles': {
        if (args?.tag) {
          const style = styleByTag(args.tag);
          const tail = args?.preview ? `\n参考图: ${(await ensureStyleImage(style.index)).path}` : '';
          return [
            `画风 ${style.tag}（#${style.index}）· ${style.category || '-'} · ${style.rating}`,
            `画师: ${style.artists.length ? style.artists.map((name) => `@${name}`).join(', ') : '（无）'}`,
            `正向: ${style.positive}`,
            `负向: ${style.negative}`,
            '把上面的 @画师 和风格标签并进用户的提示词里，再出图；用户点名了角色时，角色标签放在画风标签之前。',
          ].join('\n') + tail;
        }
        if (args?.preview !== undefined && args?.preview !== null) {
          return previewStyle(Number(args.preview));
        }
        return searchStyles(args?.query || '', Number(args?.limit) || 10);
      }
      case 'settings': {
        const patch = args?.set;
        if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
          return `${JSON.stringify(currentSettings(), null, 2)}\noverrides file: ${SETTINGS_FILE}`;
        }
        return `settings updated: ${JSON.stringify(updateSettings(patch))}`;
      }
      case 'start_server':
        return client.ensureStarted();
      case 'stop_server':
        return (await client.stopOwned())
          ? 'stopped the ComfyUI process this plugin launched'
          : 'no plugin-launched ComfyUI process to stop';
      case 'status':
        return client.status();
      case 'list_models':
        return client.listModels(args?.folder || 'checkpoints');
      case 'search_nodes':
        return client.searchNodes(args?.query || '', Number(args?.limit) || 25);
      case 'node_info':
        if (!args?.node_class) throw new ComfyError('node_info requires node_class');
        return client.nodeInfo(text(args.node_class));
      case 'view_queue':
        return client.viewQueue();
      case 'history':
        return client.history(Number(args?.limit) || 5);
      case 'queue_workflow': {
        if (!args?.workflow_json) {
          throw new ComfyError(`queue_workflow requires workflow_json. ${WORKFLOW_HELP}`);
        }
        let workflow = args.workflow_json;
        if (settings.imageCount >= 1) {
          try {
            workflow = JSON.parse(workflow);
          } catch (error) {
            throw new ComfyError(`workflow_json is not valid JSON: ${error.message}`);
          }
          for (const node of Object.values(workflow || {})) {
            if (node?.class_type === 'EmptyLatentImage' && node.inputs) {
              node.inputs.batch_size = settings.imageCount;
            }
          }
        }
        return client.queueWorkflow(workflow, args.wait !== false, Number(args?.timeout_s) || undefined);
      }
      case 'interrupt':
        return client.interrupt();
      case 'free_memory':
        return client.freeMemory(args?.unload_models !== false, args?.free_cached !== false);
      default:
        throw new ComfyError(`unknown action "${action}". Valid actions: ${ACTIONS.join(', ')}`);
    }
  };

  ctx.effect(() => {
    return ctx.tools.register({
      name: 'comfyui',
      description: `${DESCRIPTION}\n\nWhen queueing: ${WORKFLOW_HELP}`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ACTIONS,
            description: 'Which ComfyUI operation to perform.',
          },
          folder: {
            type: 'string',
            description: 'For list_models: model folder such as checkpoints, loras, vae, upscale_models. Defaults to checkpoints.',
          },
          query: {
            type: 'string',
            description: 'For search_nodes: text matched against node class name, category and description. For styles: substring matched against the style prompt string.',
          },
          preview: {
            type: 'integer',
            description: 'For styles: the ordinal shown in a search result; downloads that entry\'s reference image so it can be shown to the user.',
          },
          tag: {
            type: 'string',
            description: 'For styles: the style tag the user names, e.g. "ST-0213". Returns that style\'s converted Anima prompt.',
          },
          limit: {
            type: 'integer',
            description: 'For search_nodes or history: maximum number of results.',
          },
          node_class: {
            type: 'string',
            description: 'For node_info: the exact node class name, e.g. KSampler.',
          },
          workflow_json: {
            type: 'string',
            description: 'For queue_workflow: the complete workflow as a JSON string.',
          },
          wait: {
            type: 'boolean',
            description: 'For queue_workflow: wait for completion before returning. Defaults to true.',
          },
          timeout_s: {
            type: 'integer',
            description: 'For queue_workflow: maximum seconds to wait for the result.',
          },
          unload_models: {
            type: 'boolean',
            description: 'For free_memory: also unload models from VRAM. Defaults to true.',
          },
          free_cached: {
            type: 'boolean',
            description: 'For free_memory: also release cached allocations. Defaults to true.',
          },
          set: {
            type: 'object',
            description:
              'For settings: setting names mapped to new values, e.g. {"mode": "free", "idleShutdownMinutes": 60, "comfyDir": "<path to the ComfyUI folder>"}. Omit to read the current values.',
            additionalProperties: true,
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            result: { type: 'string' },
            ok: { type: 'boolean' },
            images: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  attachmentId: { type: 'string' },
                  mediaType: { type: 'string' },
                  bytes: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                  name: { type: 'string' },
                },
                required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
                additionalProperties: true,
              },
            },
          },
          required: ['action', 'result', 'ok'],
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: text(value?.result) }];
          for (const ref of value?.images ?? []) blocks.push({ type: 'image', attachment: ref });
          return blocks;
        },
      },
      async execute(args) {
        const action = text(args?.action || 'status');
        try {
          const outcome = await run(args);
          const files = Array.isArray(outcome?.files) ? outcome.files : [];
          const message = typeof outcome === 'string' ? outcome : text(outcome?.message);
          const images = await persistImages(attachments, files);
          return { action, result: message, ok: true, images };
        } catch (error) {
          const result = error instanceof ComfyError ? error.message : `${error?.name || 'Error'}: ${error?.message || error}`;
          return { action, result, ok: false };
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: `ComfyUI: ${text(args?.action || 'status')}`,
          kind: 'other',
          rawInput: args,
        };
      },
    });
  });

  ctx.effect(() => {
    const timer = setInterval(() => {
      const minutes = settings.idleShutdownMinutes;
      if (minutes > 0) client.stopIfIdle(minutes).catch(() => {});
    }, 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  // Transport for the Settings tab: a plain-JS client plugin has no RPC service,
  // so the form reads and writes through this loopback HTTP route. Register from
  // an injected child because webServer may activate after this plugin does.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        async handler(req, res) {
          const reply = (status, payload) => {
            const body = JSON.stringify(payload);
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(body);
          };
          if (req.method === 'GET') {
            reply(200, currentSettings());
            return;
          }
          if (req.method !== 'POST') {
            reply(405, { error: 'GET or POST only' });
            return;
          }
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 20000) {
              reply(413, { error: 'body too large' });
              return;
            }
          }
          let body;
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            reply(400, { error: 'invalid JSON' });
            return;
          }
          const patch = body && typeof body === 'object' && body.set && typeof body.set === 'object' ? body.set : body;
          try {
            updateSettings(patch);
            reply(200, { ok: true, values: currentSettings() });
          } catch (error) {
            reply(400, { error: error?.message || String(error) });
          }
        },
      }),
    );

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: MODELS_ROUTE,
        async handler(req, res) {
          const reply = (status, payload) => {
            const body = JSON.stringify(payload);
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(body);
          };
          // Weights live in both the checkout's models/ and the plugin's bundled
          // models/ (registered through extra_model_paths.yaml). List and manage
          // both so the panel matches what ComfyUI can actually load.
          const modelRoots = [
            ...(settings.comfyDir ? [join(settings.comfyDir, 'models')] : []),
            ...(runtimeApplied ? [join(settings.comfyDir, '_dsh_plugin', 'comfyui-agent', 'models')] : []),
            join(PLUGIN_DIR, 'models'),
          ];

          if (req.method === 'GET') {
            const folders = {};
            for (const folder of MODEL_FOLDERS) {
              const seen = new Map();
              for (const root of modelRoots) {
                const dir = join(root, folder);
                let names;
                try {
                  names = readdirSync(dir);
                } catch {
                  continue;
                }
                for (const name of names) {
                  if (name.startsWith('.') || seen.has(name)) continue;
                  try {
                    const info = statSync(join(dir, name));
                    if (info.isFile() && info.size > 1024 * 1024) {
                      seen.set(name, { name, sizeMb: Math.round(info.size / 1024 / 1024) });
                    }
                  } catch {
                    // unreadable entry, skip it
                  }
                }
              }
              folders[folder] = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
            }
            reply(200, { modelsRoot: modelRoots[modelRoots.length - 1], modelsRoots: modelRoots, folders });
            return;
          }

          if (req.method === 'DELETE') {
            const target = safeFileName(new URL(req.url, 'http://x').searchParams.get('name') || '');
            if (!target) {
              reply(400, { error: '文件名不合法' });
              return;
            }
            let removed = false;
            for (const root of modelRoots) {
              try {
                unlinkSync(join(root, 'loras', target));
                removed = true;
              } catch {
                // not in this root
              }
            }
            if (removed) reply(200, { ok: true, removed: target });
            else reply(404, { error: `没有找到 ${target}` });
            return;
          }

          if (req.method !== 'POST') {
            reply(405, { error: 'GET, POST or DELETE only' });
            return;
          }

          const name = safeFileName(new URL(req.url, 'http://x').searchParams.get('name') || '');
          if (!name) {
            reply(400, { error: '只接受 .safetensors / .pt / .ckpt / .bin 文件，且文件名不能为空' });
            return;
          }
          const declared = Number(req.headers['content-length'] || 0);
          if (declared > MAX_UPLOAD_BYTES) {
            reply(413, { error: '文件超过 2 GB' });
            return;
          }
          const lorasDir = join(modelRoots[modelRoots.length - 1], 'loras');
          const partial = join(lorasDir, `.${randomUUID()}.upload`);
          let written = 0;
          try {
            mkdirSync(lorasDir, { recursive: true });
            const limit = new Transform({ transform(chunk, encoding, done) {
              written += chunk.length;
              if (written > MAX_UPLOAD_BYTES) done(new Error('文件超过 2 GB'));
              else done(null, chunk);
            } });
            await pipeline(req, limit, createWriteStream(partial, { flags: 'wx' }));
            renameSync(partial, join(lorasDir, name));
            reply(200, { ok: true, name, sizeMb: Math.round(written / 1024 / 1024) });
          } catch (error) {
            try { unlinkSync(partial); } catch {}
            reply(written > MAX_UPLOAD_BYTES ? 413 : 500, { error: `写入失败：${error?.message || error}` });
          }
        },
      }),
    );

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: STYLES_ROUTE,
        async handler(req, res) {
          const params = new URL(req.url, 'http://x').searchParams;
          try {
            const data = listStyles(
              params.get('query') || '',
              Number(params.get('limit')) || 12,
              Number(params.get('offset')) || 0,
            );
            const body = JSON.stringify(data);
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(body);
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error?.message || String(error) }));
          }
        },
      }),
    );

    // The browser cannot reach the asset CDN directly (CORS and hotlink rules),
    // so the plugin proxies one cached reference image per request.
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: STYLE_IMAGE_ROUTE,
        async handler(req, res) {
          const index = new URL(req.url, 'http://x').searchParams.get('index');
          try {
            const { path } = await ensureStyleImage(index);
            res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
            res.end(readFileSync(path));
          } catch (error) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error?.message || String(error) }));
          }
        },
      }),
    );
  });

  if (settings.systemPrompt) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'comfyui-agent',
        order: 500,
        text:
          `A ComfyUI image-generation server is available at ${settings.baseUrl}. The \`comfyui\` tool operates it. ` +
          'Before the first image of a session, call comfyui with action "guide": it lists the installed models, ' +
          'gives a ready-to-submit workflow, and states the prompt and sampler rules this local setup needs. ' +
          'Image requests are executed and reported, never described.',
      }),
    );
  }
}
