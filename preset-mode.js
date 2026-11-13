/**
 * Hard isolation for the ComfyUI image mode.
 *
 * Two layers, and the second one is the real boundary:
 *   restrict() hides every global tool except the image pair (cosmetic: it keeps
 *     the model's tool list honest, and is the only reason `present` is visible).
 *   guard()    denies execution of anything outside that pair. A guard cannot be
 *     forced open by another guard, so this is what stops file, shell, and code
 *     paths even if the visible list ever drifts.
 *
 * The `comfyui` tool also refuses its own `settings` action here: configuration
 * belongs to the user, not to the image-mode agent, so a session can never
 * rewrite the plugin's settings.
 */

export const name = 'comfyui-image-mode';

export const inject = ['tools'];

const ALLOWED = new Set(['comfyui', 'present']);

/** Actions of the image tool that change configuration or control the process. */
const BLOCKED_ACTIONS = new Set(['settings']);

function actionOf(execution) {
  const raw = execution?.arguments ?? execution?.args ?? execution?.input;
  if (raw && typeof raw === 'object') return String(raw.action || '');
  try {
    return String(JSON.parse(raw ?? '{}')?.action || '');
  } catch {
    return '';
  }
}

function denyReason(execution) {
  const toolName = execution?.name;
  if (!ALLOWED.has(toolName)) return 'anima 生图模式只允许出图相关操作';
  if (toolName === 'comfyui' && BLOCKED_ACTIONS.has(actionOf(execution))) {
    return 'anima 生图模式不允许改配置，请在设置面板里修改';
  }
  return undefined;
}

function harden(scope) {
  try {
    scope.tools.restrict({ allow: [...ALLOWED] });
  } catch {
    // Keep the guard as the enforcement point rather than narrowing the list:
    // a shorter allow set would hide `present`, the only way to show the image.
  }
  try {
    scope.tools.guard((execution) => denyReason(execution));
  } catch {
    // The persona still constrains behavior; nothing else can be registered.
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [];
    const drain = () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // already released
        }
      }
    };

    const off = ctx.on('agent/created', ({ agent }) => {
      const scope = agent?.ctx;
      if (!scope) return;
      try {
        disposers.push(
          scope.effect(() => {
            harden(scope);
            return () => {};
          }),
        );
      } catch {
        // Never fail agent creation from here.
      }
    });

    return () => {
      off?.();
      drain();
    };
  });
}
