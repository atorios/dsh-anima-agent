# DSH Anima Agent

Windows x64 / NVIDIA 环境的 DeepSeek Harness 绘画插件。

在 Harness 插件安装中使用本 GitHub 仓库地址。插件启用后自动下载固定版本运行包、断点续传并校验完整性、解压和修正路径；首次出图自动启动 ComfyUI。无需运行 BAT、配置 Python 或单独下载模型。首次准备需要约 8.3 GB 网络流量、至少 30 GB 可用磁盘；运行环境为 Python 3.12 / PyTorch 2.7.1 cu126，需已安装兼容 NVIDIA 驱动。

## 仓库规则：模型走 release，不入库

- 本仓库只放插件源码（约 100 KB），**不含任何权重文件**。
- 模型与运行环境（ComfyUI + Anima 底模 / 文本编码器 / VAE + 两个官方 LoRA）打包成 8 个分片，挂在 release `runtime-v1` 上，由 `runtime-manifest.json` 描述文件名、字节数与 SHA-256。
- 下载链路：HTTP Range 断点续传、`Content-Range` 严格校验、单片 SHA-256 与整包 SHA-256 双重校验、tar 预检防路径穿越、分段并行合并且上限 16 连接。
- 已就绪的版本不会再联网；失败后下次绘画操作自动续传。

## 本版不含画风库

- `styles.json` 为空目录（`{"entries": []}`），`styles` 返回 0 条，界面里没有 tag 搜索与参考图。
- 融合画师改为按用户口述构建画风标签，不再依赖第三方 tag 数据。
- 如需画风库，请自行放回自己的 `styles.json`（受第三方授权约束，未随本仓库分发）。

## 凭据

仓库与运行包都是**公开**的，匿名即可下载，不需要 GitHub 账号。

`GH_TOKEN` / `GITHUB_TOKEN` 或本机 GitHub CLI 登录是可选的：有凭据时请求会带上 token 以避开 API 速率限制，没有也会照常下载。凭据不会写进源码或缓存，也不会被转发到 `api.github.com` 以外的地址。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 工具实现、设置路由、运行时准备接线、自动启停 |
| `runtime-installer.js` | 分片下载 / 校验 / 解压 / 修正 venv 路径 |
| `github-auth.js` | 读取 GitHub CLI 或环境变量凭据 |
| `runtime-manifest.json` | 运行包清单（版本、分片、哈希） |
| `comfy.js` | ComfyUI HTTP 客户端 |
| `styles.js` / `styles.json` | 画风库（本版为空） |
| `preset-mode.js` | 会话级工具隔离 |
| `client.js` | 设置页签与状态徽标 |
| `cordis.patch.yml` | 插件行与「绘画模式」预设 |
| `guide.md` | 出图手册 |
| `tests/` | 下载链路与激活流程单测 |

## 状态

- 自动准备与安装链路已通过 27 项单测（断点续传、Content-Range 校验、哈希不符回滚、tar 安全、分段合并、凭据作用域、超时重试）。
- ComfyUI、Python、PyTorch、CUDA 与 Anima 模型各自遵循其原始授权；本私有仓库不表示已取得公开再分发权，公开发布前须完成第三方再分发许可审核。
