window.__ModuleLoader__.load({
  id: '@local/comfyui-agent',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const STYLES = {
      wrap: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginLeft: 'auto',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: '16px',
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
      label: {
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 260,
      },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2, #b8bec9)',
        background: 'var(--dsw-alias-bg-layer-2, #eef0f4)',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        borderRadius: 6,
        padding: '2px 8px',
        fontSize: 11,
        cursor: 'pointer',
        lineHeight: '16px',
      },
    };

    function ComfyStatus() {
      const [state, setState] = useState({ phase: 'idle', text: 'ComfyUI', ok: null });

      const refresh = useCallback(() => {
        setState({ phase: 'loading', text: 'checking...', ok: null });
        Promise.resolve()
          .then(() => {
            const invoker = window.__DSH_TOOL__;
            if (typeof invoker !== 'function') throw new Error('no tool bridge');
            return invoker('comfyui', { action: 'status' });
          })
          .then((result) => {
            const text = String(result?.result ?? result ?? '');
            const ok = result?.ok !== false;
            const firstLine = text.split('\n')[0];
            const vram = /VRAM ([0-9.]+) GB total, ([0-9.]+) GB free/.exec(text);
            const short = ok
              ? `ComfyUI ${vram ? vram[2] : ''} GB free`.replace(/\s+/g, ' ').trim()
              : firstLine.slice(0, 60);
            setState({ phase: 'ready', text: short, ok });
          })
          .catch((error) => {
            setState({ phase: 'error', text: 'ComfyUI offline', ok: false });
          });
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const color =
        state.ok === true ? 'var(--dsw-alias-state-success-primary, #1f9254)' : state.ok === false ? 'var(--dsw-alias-state-error-primary, #c62828)' : 'var(--dsw-alias-state-idle-primary, #9aa1ac)';

      return h(
        'div',
        { style: STYLES.wrap, title: state.text },
        h('span', { style: { ...STYLES.dot, background: color } }),
        h('span', { style: STYLES.label }, state.text),
        h(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            onClick: refresh,
            disabled: state.phase === 'loading',
            title: 'Re-check the ComfyUI server',
          },
          state.phase === 'loading' ? '…' : '↻',
        ),
      );
    }

    const ENDPOINT = '/comfyui-agent/settings';
    const PENETRATE_ENDPOINT = '/penetrate/settings';
    const MODELS_ENDPOINT = '/comfyui-agent/models';
    const STYLES_ENDPOINT = '/comfyui-agent/styles';
    const STYLE_IMAGE_ENDPOINT = '/comfyui-agent/style-image';

    // Only path settings are exposed; timeouts and idle shutdown keep their
    // bundle defaults and are not worth a control here.
    const FIELDS = [
      { key: 'comfyDir', label: 'ComfyUI 目录', hint: '自动启动时使用的工作目录', type: 'text' },
      { key: 'pythonPath', label: 'Python 路径', hint: '留空则用 .venv\\Scripts\\python.exe', type: 'text' },
      { key: 'outputDir', label: '输出目录', hint: '生成图片的绝对路径根目录', type: 'text' },
    ];

    const MODE_OPTIONS = [
      {
        value: 'free',
        label: '自由模式',
        hint: '无条件进行图片生成，哪怕提示词无法使用。推荐已有完整提示词时使用。',
      },
      {
        value: 'guided',
        label: '引导模式',
        hint: '与模型探讨具体绘画风格，推荐没有完整提示词时使用。',
      },
    ];

    const FOLDER_LABELS = {
      diffusion_models: '主模型',
      checkpoints: '单体底模',      text_encoders: '文本编码器',
      vae: 'VAE',
      loras: 'LoRA',
    };

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560, fontSize: 13, lineHeight: '18px' },
      intro: { color: 'var(--dsw-alias-label-secondary, #6b7280)', margin: 0 },
      row: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontWeight: 500, color: 'var(--dsw-alias-label-primary, #1a1a1a)' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, #b8bec9)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        fontFamily: 'inherit',
        fontSize: 13,
        outline: 'none',
      },
      bar: { display: 'flex', alignItems: 'center', gap: 10 },
      save: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-brand-primary, #247bbf)',
        borderRadius: 6,
        padding: '7px 18px',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        color: '#fff',
        background: 'var(--dsw-alias-brand-primary, #247bbf)',
      },
      reload: {
        ...STYLES.button,
        padding: '7px 14px',
        fontSize: 12,
        fontWeight: 500,
        background: 'var(--dsw-alias-bg-layer-2, #eef0f4)',
        border: '1px solid var(--dsw-alias-border-l2, #b8bec9)',
      },
      ok: { color: 'var(--dsw-alias-state-success-primary, #1f9254)', fontSize: 12 },
      bad: { color: 'var(--dsw-alias-state-error-primary, #c62828)', fontSize: 12 },
    };

    function ComfySettings() {
      const [values, setValues] = useState(null);
      const [status, setStatus] = useState({ kind: 'idle', text: '' });
      const [busy, setBusy] = useState(false);
      const [models, setModels] = useState(null);
      const [modelStatus, setModelStatus] = useState({ kind: 'idle', text: '' });
      const [uploading, setUploading] = useState(false);
      const [penetrate, setPenetrate] = useState(null);
      const [penetrateStatus, setPenetrateStatus] = useState({ kind: 'idle', text: '' });

      const loadPenetrate = useCallback(() => {
        fetch(PENETRATE_ENDPOINT, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => setPenetrate(payload?.enabled === true))
          .catch(() => setPenetrate(null));
      }, []);

      const togglePenetrate = (next) => {
        setPenetrate(next);
        setPenetrateStatus({ kind: 'idle', text: '' });
        fetch(PENETRATE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        })
          .then((response) => response.json())
          .then((payload) => {
            if (payload?.error) throw new Error(payload.error);
            setPenetrate(payload.enabled === true);
            setPenetrateStatus({ kind: 'ok', text: next ? '已开启，新会话生效' : '已关闭' });
          })
          .catch((error) => {
            setPenetrate(!next);
            setPenetrateStatus({ kind: 'error', text: '保存失败：' + (error?.message || error) });
          });
      };

      const load = useCallback(() => {
        setStatus({ kind: 'idle', text: '' });
        fetch(ENDPOINT, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => setValues(payload))
          .catch((error) => setStatus({ kind: 'error', text: '读取失败：' + (error?.message || error) }));
      }, []);

      const loadModels = useCallback(() => {
        setModelStatus({ kind: 'idle', text: '' });
        fetch(MODELS_ENDPOINT, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (payload?.error) throw new Error(payload.error);
            setModels(payload);
          })
          .catch((error) => setModelStatus({ kind: 'error', text: '读取模型失败：' + (error?.message || error) }));
      }, []);

      useEffect(() => {
        load();
        loadModels();
        loadPenetrate();
      }, [load, loadModels, loadPenetrate]);

      const setField = (key, raw) => setValues((current) => ({ ...current, [key]: raw }));

      const save = () => {
        if (!values) return;
        setBusy(true);
        setStatus({ kind: 'idle', text: '' });
        const patch = { mode: values.mode || 'guided', imageCount: values.imageCount ?? 1 };
        for (const field of FIELDS) patch[field.key] = values[field.key] ?? '';
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((response) => response.json().then((payload) => ({ response, payload })))
          .then(({ response, payload }) => {
            if (!response.ok || payload?.error) throw new Error(payload?.error || 'HTTP ' + response.status);
            setValues(payload.values || values);
            setStatus({ kind: 'ok', text: '已保存并生效' });
            loadModels();
          })
          .catch((error) => setStatus({ kind: 'error', text: '保存失败：' + (error?.message || error) }))
          .finally(() => setBusy(false));
      };

      const upload = (event) => {
        const files = Array.from(event.target.files || []);
        if (files.length === 0) return;
        setUploading(true);
        setModelStatus({ kind: 'idle', text: '' });
        const one = (file) =>
          fetch(MODELS_ENDPOINT + '?name=' + encodeURIComponent(file.name), {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: file,
          }).then((response) => response.json().then((payload) => ({ response, payload })));
        files
          .reduce((chain, file) => chain.then(() => one(file)), Promise.resolve())
          .then(() => {
            setModelStatus({ kind: 'ok', text: `已上传 ${files.length} 个文件` });
            loadModels();
          })
          .catch((error) => setModelStatus({ kind: 'error', text: '上传失败：' + (error?.message || error) }))
          .finally(() => {
            setUploading(false);
            event.target.value = '';
          });
      };

      if (!values && status.kind !== 'error') {
        return h('div', { style: S.wrap }, h('p', { style: S.intro }, '正在读取设置…'));
      }
      if (!values) {
        return h(
          'div',
          { style: S.wrap },
          h('p', { style: S.bad }, status.text),
          h('div', { style: S.bar },
            h('button', { type: 'button', style: S.reload, onClick: load }, '重试'),
          ),
        );
      }

      const folderRows = models
        ? Object.keys(FOLDER_LABELS).map((folder) => {
            const items = models.folders?.[folder] || [];
            return h(
              'div',
              { key: folder, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h(
                'div',
                { style: { ...S.label, display: 'flex', gap: 8, alignItems: 'baseline' } },
                h('span', null, FOLDER_LABELS[folder]),
                h('span', { style: S.hint }, `${items.length} 个`),
              ),
              items.length === 0
                ? h('span', { style: S.hint }, '（空）')
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 10 } },
                    ...items.map((item) =>
                      h(
                        'span',
                        { key: item.name, style: S.hint },
                        `${item.name}  ·  ${item.sizeMb} MB`,
                      ),
                    ),
                  ),
            );
          })
        : [h('span', { key: 'loading', style: S.hint }, '正在读取模型列表…')];

      return h(
        'div',
        { style: S.wrap },
        h(RuntimePreparation, { key: 'runtime-preparation' }),
        h(
          'p',
          { style: S.intro },
          '路径设置保存在插件目录的 comfyui.settings.json，优先级高于插件配置行，保存后立即生效。',
        ),
        h(
          'div',
          { style: S.row },
          h('label', { style: S.label }, '工作模式'),
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            ...MODE_OPTIONS.map((option) =>
              h(
                'button',
                {
                  key: option.value,
                  type: 'button',
                  style: {
                    ...S.reload,
                    flex: 1,
                    padding: '7px 10px',
                    background:
                      (values.mode || 'guided') === option.value
                        ? 'var(--dsw-alias-brand-primary, #247bbf)'
                        : 'var(--dsw-alias-bg-layer-2, #eef0f4)',
                    color:
                      (values.mode || 'guided') === option.value
                        ? '#fff'
                        : 'var(--dsw-alias-label-primary, #1a1a1a)',
                    border:
                      (values.mode || 'guided') === option.value
                        ? '1px solid var(--dsw-alias-brand-primary, #247bbf)'
                        : '1px solid var(--dsw-alias-border-l2, #b8bec9)',
                  },
                  onClick: () => setField('mode', option.value),
                },
                option.label,
              ),
            ),
          ),
          h(
            'span',
            { style: S.hint },
            (values.mode === 'free' ? MODE_OPTIONS[0] : MODE_OPTIONS[1]).hint,
          ),
        ),
        h(
          'div',
          { style: S.row },
          h(
            'label',
            {
              style: { ...S.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
            },
            h('input', {
              type: 'checkbox',
              checked: penetrate === true,
              disabled: penetrate === null,
              onChange: (event) => togglePenetrate(event.target.checked),
              style: { margin: 0, width: 14, height: 14, cursor: 'pointer' },
            }),
            '破甲',
          ),
          h(
            'span',
            { style: S.hint },
            '勾选后你懂的，要和自由模式一起使用，并在模型选择那里把思考强度选为off',
          ),
          penetrateStatus.kind === 'ok' ? h('span', { style: S.ok }, penetrateStatus.text) : null,
          penetrateStatus.kind === 'error' ? h('span', { style: S.bad }, penetrateStatus.text) : null,
          penetrate === null ? h('span', { style: S.hint }, '破甲插件未加载，开关不可用') : null,
        ),
        h(
          'div',
          { style: S.row },
          h('label', { style: S.label, htmlFor: 'comfyui-image-count' }, '单次生成张数'),
          h(
            'select',
            {
              id: 'comfyui-image-count',
              style: S.input,
              value: values.imageCount ?? 1,
              onChange: (event) => setField('imageCount', Number(event.target.value)),
            },
            ...[1, 2, 3, 4, 5].map((count) => h('option', { key: count, value: count }, `${count} 张`)),
          ),
          h('span', { style: S.hint }, '默认 1 张，最多 5 张。点击保存后生效；多张图片会增加生成时间和显存占用。'),
        ),
        ...FIELDS.map((field) =>
          h(
            'div',
            { key: field.key, style: S.row },
            h('label', { style: S.label, htmlFor: 'comfyui-' + field.key }, field.label),
            h('input', {
              id: 'comfyui-' + field.key,
              style: S.input,
              type: 'text',
              value: values[field.key] ?? '',
              onChange: (event) => setField(field.key, event.target.value),
            }),
            h('span', { style: S.hint }, field.hint),
          ),
        ),
        h(
          'div',
          { style: S.bar },
          h('button', { type: 'button', style: S.save, onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { type: 'button', style: S.reload, onClick: load, disabled: busy }, '重新读取'),
          status.kind === 'ok' ? h('span', { style: S.ok }, status.text) : null,
          status.kind === 'error' ? h('span', { style: S.bad }, status.text) : null,
        ),
        h('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1, #dcdfe5)', margin: '6px 0' } }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { ...S.label, fontSize: 13 } }, '模型列表'),
          ...(models?.modelsRoots ?? []).map((root) => h('span', { key: root, style: S.hint }, root)),
          ...folderRows,
          h(
            'div',
            { style: { ...S.bar, marginTop: 4 } },
            h(
              'label',
              {
                style: {
                  ...S.reload,
                  display: 'inline-flex',
                  alignItems: 'center',
                  cursor: uploading ? 'default' : 'pointer',
                  opacity: uploading ? 0.6 : 1,
                },
              },
              uploading ? '上传中…' : '上传 LoRA',
              h('input', {
                type: 'file',
                accept: '.safetensors,.pt,.ckpt,.bin',
                multiple: true,
                style: { display: 'none' },
                disabled: uploading,
                onChange: upload,
              }),
            ),
            h('button', { type: 'button', style: S.reload, onClick: loadModels, disabled: uploading }, '刷新'),
            modelStatus.kind === 'ok' ? h('span', { style: S.ok }, modelStatus.text) : null,
            modelStatus.kind === 'error' ? h('span', { style: S.bad }, modelStatus.text) : null,
          ),
          h('span', { style: S.hint }, '上传的文件写入 models\\loras，支持 .safetensors / .pt / .ckpt / .bin，单个上限 2 GB。'),
        ),
        h(StyleLibrary, { key: 'styles' }),
      );
    }

    function RuntimePreparation() {
      const [runtime, setRuntime] = useState(null);
      useEffect(() => {
        let disposed = false;
        const load = () => fetch(ENDPOINT).then(r => r.json()).then(data => { if (!disposed) setRuntime(data.runtime); }).catch(() => {});
        load();
        const timer = setInterval(load, 2000);
        return () => { disposed = true; clearInterval(timer); };
      }, []);
      if (!runtime) return null;
      return h('div', { style: { ...S.row, padding: 10, border: '1px solid var(--dsw-alias-border-l1, #dcdfe5)', borderRadius: 8 } },
        h('span', { style: S.label }, runtime.phase === 'ready' ? '绘画环境已就绪' : '正在自动准备绘画环境'),
        h('span', { style: S.hint }, `${runtime.phase || ''} · ${((runtime.received || 0) / 1073741824).toFixed(2)} / ${((runtime.total || 0) / 1073741824).toFixed(2)} GiB`),
        runtime.total > 0 && runtime.phase !== 'ready' ? h('progress', { value: runtime.received || 0, max: runtime.total, style: { width: '100%' } }) : null,
        runtime.error ? h('span', { style: S.bad }, runtime.error) : null,
        h('span', { style: S.hint }, '安装后自动完成准备，无需 BAT 或手动配置；首次出图会等待环境就绪。'),
      );
    }

    function StyleLibrary() {
      const PAGE = 12;
      const [query, setQuery] = useState('');
      const [offset, setOffset] = useState(0);
      const [data, setData] = useState(null);
      const [state, setState] = useState({ kind: 'idle', text: '' });

      const run = useCallback((keyword, from) => {
        setState({ kind: 'loading', text: '' });
        const url =
          STYLES_ENDPOINT +
          '?limit=' + PAGE +
          '&offset=' + (from || 0) +
          '&query=' + encodeURIComponent(keyword || '');
        fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (payload?.error) throw new Error(payload.error);
            setData(payload);
            setState({ kind: 'idle', text: '' });
          })
          .catch((error) => setState({ kind: 'error', text: '读取失败：' + (error?.message || error) }));
      }, []);

      useEffect(() => {
        run('', 0);
      }, [run]);

      const search = () => {
        setOffset(0);
        run(query, 0);
      };

      const go = (next) => {
        const target = Math.max(0, next);
        setOffset(target);
        run(query, target);
      };

      const copy = (text) => {
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
      };

      const grid = data?.entries?.length
        ? h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 } },
            ...data.entries.map((entry) =>
              h(
                'div',
                {
                  key: entry.index,
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    border: '1px solid var(--dsw-alias-border-l1, #dcdfe5)',
                    borderRadius: 8,
                    padding: 6,
                    background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
                  },
                },
                h('img', {
                  src: `${STYLE_IMAGE_ENDPOINT}?index=${entry.index}`,
                  alt: `画风 #${entry.index}`,
                  loading: 'lazy',
                  style: { width: '100%', borderRadius: 6, display: 'block', aspectRatio: '3 / 4', objectFit: 'cover', background: 'var(--dsw-alias-bg-layer-2, #eef0f4)' },
                }),
                h('span', { style: { ...S.hint, fontWeight: 500 } }, entry.tag),
                h('span', { style: S.hint }, entry.category || '-'),
                h(
                  'button',
                  { type: 'button', style: { ...S.reload, padding: '2px 0', fontSize: 11 }, onClick: () => copy(entry.tag) },
                  '复制 tag',
                ),
              ),
            ),
          )
        : h('span', { style: S.hint }, state.kind === 'loading' ? '正在读取…' : '没有匹配的画风');

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1, #dcdfe5)', margin: '6px 0' } }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          h('span', { style: { ...S.label, fontSize: 13 } }, '画风库'),
          data
            ? h(
                'span',
                { style: S.hint },
                `${data.matched} / ${data.total} 条` +
                  (data.matched > PAGE
                    ? ` · 第 ${Math.floor(data.offset / PAGE) + 1} / ${Math.max(1, Math.ceil(data.matched / PAGE))} 页`
                    : ''),
              )
            : null,
        ),
        h(
          'div',
          { style: S.bar },
          h('input', {
            style: { ...S.input, flex: 1 },
            type: 'text',
            placeholder: '搜画师名，例如 mika pikazo、kantoku',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') search();
            },
          }),
          h('button', { type: 'button', style: S.save, onClick: search, disabled: state.kind === 'loading' }, '搜索'),
        ),
        state.kind === 'error' ? h('span', { style: S.bad }, state.text) : null,
        grid,
        data && data.matched > PAGE
          ? h(
              'div',
              { style: { ...S.bar, justifyContent: 'center' } },
              h(
                'button',
                { type: 'button', style: S.reload, onClick: () => go(offset - PAGE), disabled: offset <= 0 || state.kind === 'loading' },
                '上一页',
              ),
              h('span', { style: S.hint }, `${Math.floor(offset / PAGE) + 1} / ${Math.ceil(data.matched / PAGE)}`),
              h(
                'button',
                {
                  type: 'button',
                  style: S.reload,
                  onClick: () => go(offset + PAGE),
                  disabled: offset + PAGE >= data.matched || state.kind === 'loading',
                },
                '下一页',
              ),
            )
          : null,
        h('span', { style: S.hint }, '参考图首次查看时才下载（约 1–2 秒），之后走本地缓存。复制后用出图模式生成。'),
        h('span', { style: S.hint },
          'tag参考来源于',
          h('a', {
            href: 'https://github.com/AgIzT/NovelAI-Tag',
            target: '_blank',
            rel: 'noopener noreferrer',
            style: { color: 'var(--dsw-alias-brand-primary, #2563eb)' },
          }, 'https://github.com/AgIzT/NovelAI-Tag'),
          '，请支持原项目',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'comfyui-agent-status',
              order: 40,
            },
            ComfyStatus,
          ),
        );

        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'comfyui-agent-settings',
              order: 30,
              label: () => '绘画插件设置',
            },
            ComfySettings,
          ),
        );
      },
    };
  },
});
