# DSH Anima Agent

DeepSeek Harness 的 ComfyUI 绘画插件（Windows x64 / NVIDIA）。

## 安装

1. 在 Harness 的插件安装里填本仓库地址：`https://github.com/atorios/dsh-anima-agent`
2. 启用插件，首次出图会自动准备运行环境（ComfyUI + Python + 模型）
3. 设置 → 内置插件 → 绘画插件设置，确认 ComfyUI 目录（默认自动探测）
4. 新建会话，选「绘画模式」，直接说要画什么

不需要预装 ComfyUI、Python 或模型，也不需要跑 BAT。

**环境要求**：Windows x64、已安装兼容的 NVIDIA 驱动；首次准备约 8.3 GB 流量、至少 30 GB 空闲磁盘。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 工具实现、设置路由、运行时准备接线、ComfyUI 自动启停 |
| `runtime-installer.js` | 分片下载、断点续传、SHA-256 校验、解压、修正 venv 路径 |
| `github-auth.js` | 读取可选凭据（`GH_TOKEN` / `GITHUB_TOKEN` / GitHub CLI） |
| `runtime-manifest.json` | 运行包清单：分片文件名、字节数、哈希 |
| `comfy.js` | ComfyUI HTTP 客户端 |
| `styles.js` / `styles.json` | 画风库（本版为空） |
| `preset-mode.js` | 会话级工具隔离 |
| `penetrate-mode.js` | 穿透模式，接第三方模型 |
| `client.js` | 设置页签与状态徽标 |
| `cordis.patch.yml` | 插件行与「绘画模式」预设 |
| `guide.md` | 出图手册 |
| `locale/` | 中英文案 |
| `tests/` | 下载链路与激活流程单测 |

## 说明

**模型不进仓库。** 运行环境与权重（ComfyUI、Anima 底模、Qwen 文本编码器、VAE、两个官方 LoRA，合计 7.7 GiB）挂在 release `runtime-v1` 的 8 个分片里，由 `runtime-manifest.json` 描述。下载走 HTTP Range 续传，单片与整包双重 SHA-256 校验，tar 预检防路径穿越；就绪后不再联网，失败下次自动续传。

**凭据可选。** 仓库与运行包公开，匿名即可下载。`GH_TOKEN` / `GITHUB_TOKEN` 或已登录的 GitHub CLI 只用于避开 API 速率限制，不会写入源码或缓存，也不会发往 `api.github.com` 以外的地址。

**画风库不含在内。** `styles.json` 为空（`{"entries": []}`），`styles` 返回 0 条，融合画师按用户口述构建。自行放回画风数据需自负授权。

**授权。** ComfyUI、Python、PyTorch、CUDA、Anima 模型分别遵循各自许可；本仓库只包含插件源码，不构成对上述组件的再分发授权。
