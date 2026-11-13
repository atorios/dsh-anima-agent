import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
export async function githubToken() {
  const configured = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (configured) return configured;
  const installed = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  const gh = existsSync(installed) ? installed : 'gh';
  try {
    const { stdout } = await run(gh, ['auth', 'token', '--hostname', 'github.com'], { windowsHide: true });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // Private repository assets require the same user's GitHub authorization.
  }
  throw new Error('私有仓库运行包无法授权访问：未找到已登录的 GitHub CLI 或 GitHub 环境凭据。');
}
