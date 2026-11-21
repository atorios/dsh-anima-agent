# DSH Anima Agent

[DSH] 的 ComfyUI 绘画插件（Windows x64 / NVIDIA）。

## 安装

### 方式一：整合包一键安装（不需要会命令行）

1. 双击 `一键安装插件.bat`
2. 脚本会把插件装进 DSH 并启用
3. 如果 DSH 正在运行，完全退出后重新打开
4. 新建会话，选「绘画模式」，直接说要画什么

整合包已经带好 ComfyUI、Python 环境和 Anima 全部模型，**不需要下载任何东西**，也不会在启动时联网。

### 方式二：从仓库安装

1. 在 Harness 的插件安装里填本仓库地址：`https://github.com/atorios/dsh-anima-agent`
2. 启用插件，首次出图会自动准备运行环境（ComfyUI + Python + 模型）
3. 设置 → 内置插件 → 绘画插件设置，确认 ComfyUI 目录（默认自动探测）
4. 新建会话，选「绘画模式」，直接说要画什么

**环境要求**：Windows x64、已安装兼容的 NVIDIA 驱动。

**关于下载**：插件只在**没有任何可用 ComfyUI** 时才下载运行包（约 8.3 GB、至少 30 GB 空闲磁盘）。判定顺序是：设置里配置的目录 → 插件旁随包的 ComfyUI → `baseUrl` 上已在应答的服务。三者只要有一个成立就不下载。整合包属于第二种，所以永远不会触发下载。

## RTX 50 系兼容支持

使用插件自带的 ComfyUI 时，启动程序会检测当前 GPU。对于计算能力为 `sm_120` 的显卡，插件会先执行一次 CUDA 加法和矩阵乘法。原环境运行失败时，插件从 PyTorch 官方源下载 cu128 组件到独立目录，在当前显卡上验证成功后再启动 ComfyUI。首次修复需要额外数 GB 流量和磁盘空间。使用外部 ComfyUI 的用户需自行管理其 Python 环境。

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
| `client.js` | 设置页签与状态徽标 |
| `cordis.patch.yml` | 插件行与「绘画模式」预设 |
| `guide.md` | 出图手册 |
| `locale/` | 中英文案 |
| `tests/` | 下载链路与激活流程单测 |

## 说明

**模型不进仓库。** 运行环境与权重（ComfyUI、Anima 底模、Qwen 文本编码器、VAE、两个官方 LoRA，合计 7.7 GiB）挂在 release `runtime-v1` 的 8 个分片里，由 `runtime-manifest.json` 描述。下载走 HTTP Range 续传，单片与整包双重 SHA-256 校验，tar 预检防路径穿越；就绪后不再联网，失败下次自动续传。

整合包把这套运行环境直接放在 `ComfyUI/` 下，所以开箱即用；从仓库安装则走上面的下载链路。

**授权。** ComfyUI、Python、PyTorch、CUDA、Anima 模型分别遵循各自许可；本仓库只包含插件源码，不构成对上述组件的再分发授权。
