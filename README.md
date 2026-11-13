# DSH Anima Agent

Windows x64 / NVIDIA 环境的 DeepSeek Harness 绘画插件。

在 Harness 插件安装中使用本 GitHub 仓库地址。插件启用后自动下载固定版本运行包、断点续传并校验完整性、解压和修正路径；首次出图自动启动 ComfyUI。无需运行 BAT、配置 Python 或单独下载模型。首次准备需要约8.3GB网络流量、至少30GB可用磁盘；运行环境为Python3.12 / PyTorch2.7.1 cu126，需已安装兼容NVIDIA驱动。

当前仓库与运行包均为私有，仅授权用户可访问。自动下载读取本机 GitHub CLI 已登录凭据或 GH_TOKEN/GITHUB_TOKEN，不把凭据写进源码或缓存；不会把作者凭据交给其他用户。公开发布前须完成第三方再分发许可审核。

设置页显示准备进度。准备失败后，下次绘画操作会重试并续传。运行包就绪后不再联网准备环境。画风参考图可能按需联网。

tag参考来源于https://github.com/AgIzT/NovelAI-Tag，请支持原项目

插件原创部分与第三方组件分别遵循各自授权。ComfyUI、Python、PyTorch、CUDA、Anima模型和画风数据不自动适用同一许可；本私有仓库不表示已取得公开再分发权。

当前状态：自动准备和完整 GitHub 安装链路正在验收，尚未宣布通过。
