# 本机 ComfyUI 出图手册

本文件由 `comfyui{action:"guide"}` 返回。直接编辑本文件即可更新知识，无需重装插件。

## 已安装的模型

| 模型 | 文件 | 说明 |
|---|---|---|
| **Anima-Base v1.0** | `diffusion_models/anima-base-v1.0.safetensors` | **唯一底模**。动漫/插画，画风依从性最强 |

`models/checkpoints` 目录当前为空。不要再尝试 SDXL 单体底模，也不要编造不存在的工作流。

Anima 配套文件：

- `text_encoders/qwen_3_06b_base.safetensors` — 文本编码器，`CLIPLoader` 的 `type` 填 `qwen_image`
- `vae/qwen_image_vae.safetensors` — VAE
- `loras/anima-highres-aesthetic-boost.safetensors` — 官方画质增强，强度 0.4–0.5
- `loras/anima-turbo-lora-v0.2.safetensors` — 官方加速，配 cfg 1、8–12 步

## LoRA 怎么用

`models/loras` 里有什么就用什么，**用之前先调 `list_models`（folder 填 `loras`）**，不要凭记忆假设列表内容。用户在设置面板上传的 LoRA 会直接出现在这里，而且**不需要重启 ComfyUI**——实测上传后 `list_models` 和 `LoraLoader` 的枚举立刻就能看到。

接线方式：在 UNETLoader 与文本编码之间插 `LoraLoader`，`model` 接 UNETLoader 输出 0，`clip` 接 CLIPLoader 输出 0，两个 CLIPTextEncode 改接它的输出 1，KSampler 的 model 改接它的输出 0。多个 LoRA 可以串联。

**兼容性**：只有 Anima 官方 LoRA 保证能用。用户上传的 LoRA 如果是给 SDXL 或 SD1.5 训练的，尺寸对不上，加载时会报 shape 错误，但**工作流仍会返回 COMPLETED，图照常出，LoRA 完全没生效**——不会报错给你看。所以用户用了非 Anima 官方 LoRA 时，提醒一句可能不生效。

判断办法：相同的提示词和种子，加 LoRA 前后出图几乎没区别，就是没生效。

## 怎么选模型

本机只有 Anima 一套底模，所有出图都走 Anima 三件套，差异靠 LoRA 调。

| 需求 | 选择 |
|---|---|
| 默认、动漫插画 | **Anima 三件套** |
| 想要更高细节 | Anima + `anima-highres-aesthetic-boost`（0.4–0.5） |
| 快速试构图 | Anima + `anima-turbo-lora-v0.2`（cfg 1、8–12 步） |

两个 LoRA 可以叠，但一般不需要：画质增强偏精细，turbo 偏速度，同时开容易互相抵消。

## 提升画质的三个手段

按效果排序：

1. **分辨率直接给足（最明显）**：直接按 1248×1824 生成，不要小图放大。细节容量的上限由分辨率决定。
2. **加官方画质 LoRA**：`anima-highres-aesthetic-boost` 强度 0.4–0.5，细节和质感都会变好。
3. **提高步数**：34 → 40（官方上限 50），线条更干净。

**不要用二次采样做「高清修复」，会出重影**，见上一节的实测数据。

分辨率上限 1536²。超过这个尺寸画面会开始重复。

## 默认流程：Anima 三件套

Anima 不是单体 checkpoint，必须用三个加载器分别取，再接标准采样链：

```
UNETLoader       unet_name=anima-base-v1.0.safetensors, weight_dtype=default
CLIPLoader       clip_name=qwen_3_06b_base.safetensors, type=qwen_image
VAELoader        vae_name=qwen_image_vae.safetensors
CLIPTextEncode   正向，clip = CLIPLoader 输出 0
CLIPTextEncode   负向，clip = CLIPLoader 输出 0
EmptyLatentImage
KSampler         model = UNETLoader 输出 0
VAEDecode        vae = VAELoader 输出 0
SaveImage
```

**默认就用这一份**：画质增强 LoRA + 直接按目标分辨率单段生成。只替换 `__PROMPT__`、`__NEGATIVE__`、`__SEED__`、`__PREFIX__`：

```json
{
  "1":  {"class_type": "UNETLoader", "inputs": {"unet_name": "anima-base-v1.0.safetensors", "weight_dtype": "default"}},
  "10": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_06b_base.safetensors", "type": "qwen_image"}},
  "11": {"class_type": "LoraLoader", "inputs": {"model": ["1", 0], "clip": ["10", 0], "lora_name": "anima-highres-aesthetic-boost.safetensors", "strength_model": 0.45, "strength_clip": 0.45}},
  "3":  {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
  "4":  {"class_type": "CLIPTextEncode", "inputs": {"clip": ["11", 1], "text": "__PROMPT__"}},
  "5":  {"class_type": "CLIPTextEncode", "inputs": {"clip": ["11", 1], "text": "__NEGATIVE__"}},
  "6":  {"class_type": "EmptyLatentImage", "inputs": {"width": 1248, "height": 1824, "batch_size": 1}},
  "7":  {"class_type": "KSampler", "inputs": {"model": ["11", 0], "seed": __SEED__, "steps": 40, "cfg": 4.5, "sampler_name": "er_sde", "scheduler": "normal", "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0], "denoise": 1.0}},
  "8":  {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
  "9":  {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "__PREFIX__"}}
}
```

分辨率直接写目标值，竖图常用 1248×1824，横图 1824×1248，方图 1536×1536。Anima 支持到 1536²，超过会开始出现重复构图。

## 不要做二次采样（重要）

**不要用 `LatentUpscale` + 第二个 `KSampler` 做「高清修复」。** 实测会出**重影**：边缘出现双线，画面发虚。

原因：`bislerp` 插值放大后的潜变量本来就是模糊的，再用 `er_sde` 这种带随机噪声的采样器以 denoise 0.4 重采样，结构被轻微重画，边缘错开半个像素就成了双线。中频噪声显著上升。

同一提示词同一 seed 的实测对比：

| 版本 | 锐度 | 中频占比 |
|---|---|---|
| 两段式 | 19.86 | **8.67%** |
| 单段直出 1248×1824 | 21.30 | **6.83%** |

中频差值就是重影的量化特征。单段直出既更清晰，也更快（40 步 vs 34+24 步）。

**也不要用 `LoadImage` + `VAEEncode` 做放大**，那是图生图，需要外部图片当输入，还会丢掉第一段的构图。

想更快预览时，把尺寸降到 832×1216、步数降到 30 即可，不要靠减少采样段数。

## 生成参数（Anima 官方推荐）

- 步数 **30–50**
- CFG **4–5**
- 采样器：`er_sde`（默认，平涂锐线）/ `euler_a`（柔和细线）/ `dpmpp_2m_sde_gpu`（更多变）/ `euler`
- 分辨率 512²–1536²
- 负向固定用：`worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration`

负向里那个 `artist name` 是官方写法，用来压掉泛化的画师影响，让 `@` 指定的那位更突出。

## 设置面板

图形界面在 **设置 → 内置插件 → anima 生图** 页签里，可改服务地址、ComfyUI 目录、Python 路径、输出目录和三个超时、空闲关闭时间。保存后立即生效。

命令行等价物是 `comfyui{action:"settings"}`（读）和 `comfyui{action:"settings", set:{...}}`（写），两者共用同一套逻辑。

值保存在插件目录的 `comfyui.settings.json`，优先级高于插件配置行；重装插件不会丢。

## 图片必须用 present 交付

生图模式下只有两个工具：`comfyui` 和 `present`。

`queue_workflow` 成功后，工具结果里会带一行「现在必须调用 present」。**照它做**：把返回的绝对路径填进 `present` 的 `files` 参数。只回复路径等于没交付，用户看不到图。

`present` 的卡片是唯一能在对话里显示图片的通道，`comfyui` 自己的结果卡片不会渲染图片。

## 官方还原模板

用户要「贴合原作画风」时用这一套。结构固定，只换角色相关部分，实测能高度贴近官方设计：

```
1girl, solo, <角色名 \(作品名\)>, anime style, Japanese anime illustration,
key visual, official art style, <种族>, <发色>, <发型>, <瞳色>, <服装配色>, <关键配饰>,
<姿势>, <场景>, <光照>, <表情>, calm mood, clean lineart, vibrant colors,
detailed background, <视线>, masterpiece, best quality, very aesthetic, absurdres
```

五个要点：

1. **角色标签的括号必须转义**：`Emilia \(Re:Zero\)`，不转义括号会被当成权重组吃掉。
2. **外貌写六到八项**：种族、发色、发型、瞳色、服装配色、关键配饰。这是防漂移的主力。
3. **画风锚点不能省**：`anime style, key visual, official art style, clean lineart, vibrant colors`。
4. **不要加 `@画师`**：加了就变成画师个人风格，反而离开原作。这是这套模板最关键的一条。
5. **负向必须带反写实组**，见下。

负向固定用：

```
photorealistic, realistic, 3d render, photo, photographic, cgi, octane render,
live action, realistic skin, real person, lowres, bad anatomy, bad hands,
extra fingers, fewer fingers, missing fingers, fused fingers, extra digits,
extra limbs, deformed, text, watermark, signature, username, blurry,
worst quality, low quality, jpeg artifacts
```

示例（爱蜜莉雅，实测贴近原作）：

```
1girl, solo, Emilia \(Re:Zero\), anime style, Japanese anime illustration, key visual,
official art style, half-elf, long silver hair, half updo, braided hair, pointed ears,
purple eyes, flower hair ornament, white dress with purple accents, detached sleeves,
green gem pendant, sitting under a tree, holding a flower, forest, dappled sunlight,
sunbeams through leaves, peaceful expression, gentle serene smile, calm mood,
clean lineart, vibrant colors, detailed background, looking at viewer,
masterpiece, best quality, very aesthetic, absurdres
```

## 工作模式

设置面板里可切换，存在 `comfyui.settings.json` 的 `mode` 字段，会话开始时由模型用 `comfyui{action:"settings"}` 读取。

| 模式 | 行为 |
|---|---|
| `free` 自由模式 | 用户给什么提示词就直接出图，不追问、不确认、不解释 |
| `guided` 引导模式（默认） | 先问「贴合原作画风」还是「融合画师画风」，按选择走模板或画风库 |

## NovelAI 画风目录

插件内置了一份 NovelAI v5 画师词典（16,542 条画风串，每条配一张参考图），来自 quicktagcloud。用户想找某种画风时用它：

```
comfyui{action:"styles", query:"kantoku", limit:5}   → 按关键词搜索，结果显示 tag
comfyui{action:"styles", tag:"ST-0213"}              → 按 tag 取完整提示词
comfyui{action:"styles", preview:213}                → 下载该条参考图
```

搜索返回的提示词**已经转成 Anima 能用的写法**，可以直接拿去出图。

### 用 tag 指定画风

每条画风都有一个稳定 tag，格式 `ST-` 加四位序号，例如 `ST-0213`。用户可以直接说：

> 帮我生成一个爱蜜莉雅，画风选 ST-0213

处理流程：

1. 调 `comfyui{action:"styles", tag:"ST-0213"}` 拿到该条的正向和负向
2. 把它的 `@画师` 和风格标签，与用户的角色要求合并成一条提示词：
   - `masterpiece, best quality, score_7, safe` 只保留一次
   - **角色标签放在画风标签之前**（角色决定画谁，画师决定怎么画）
   - 画风条目里已有的 `year 20xx`、风格词照抄
3. 按情况补上构图标签（`1girl, solo, upper body, looking at viewer`）
4. 用合并后的提示词出图，并把最终提示词贴给用户

tag 也接受 `213`、`#213`、`st213` 这些写法，不用严格按格式说。

### 转换规则

NovelAI 和 Anima 的语法不同，插件自动做了这些处理：

| NovelAI | Anima | 说明 |
|---|---|---|
| `artist:kantoku` | `@kantoku` | 画师必须加 `@` 才生效 |
| `1.39::artist:ixy::` | `@ixy` | 权重块拆掉，权重不保留 |
| `-1.5::realistic face::` | 移入负向 | 负权重转成负向提示词 |
| `artist:fuka (kantoku)` | `@fuka \(kantoku\)` | 括号是画师消歧符，转义成字面量 |
| `1.39::ixy::`（无 artist: 前缀） | `@ixy` | 整条没有 artist: 时，把权重块里的名字当画师 |
| `year 2025`、`very aesthetic` | 保留 `year`，丢弃 `very aesthetic` | 质量词由 Anima 自己的 `score_7` 体系负责 |

正向统一以 `masterpiece, best quality, score_7, safe` 开头，负向用 Anima 标准词。

### 已知不完美

原始数据是社区整理的，写法不统一。有些条目的画师名没加 `artist:` 前缀、又混在普通标签里，转换后可能残留少量重复标签（例如同时出现 `@muchi maro` 和 `muchi_maro`）。这不影响出图，看到时忽略即可。

画师串里通常混了十几个画师，Anima 不一定都认识，认不出的会被当普通词忽略——不会报错。

## 服务启动

ComfyUI 是独立进程，DSH 重启不会带起它。插件已配置 `comfyDir`：任何操作遇到连接失败时会自动拉起 ComfyUI 并等它就绪（约 10–20 秒），不需要手动开 `start.bat`。也可以显式调用 `comfyui` 的 `start_server` 动作。

**空闲 30 分钟会自动关闭**（由插件自己拉起的那个进程，`idleShutdownMinutes` 可调，设 0 关闭该行为）。你手动开的 ComfyUI 插件不会去动。也可以随时调 `stop_server` 手动释放。

所以：长时间不用之后，第一张图会重新等一次启动；连续使用则一直是热的。

如果自动启动超时（默认 180 秒），说明 ComfyUI 本身启动报错，需要手动跑一次 `start.bat` 看控制台输出。

## 提示词规则（Anima 官方）

- 训练数据 = Danbooru 标签 + 自然语言 + 两者混合。**用户给的提示词原样提交，不要翻译、不要删标签。**
- 标签小写，用空格代替下划线；只有 score 标签用下划线。
- 正向开头推荐：`masterpiece, best quality, score_7, safe, `
- 标签顺序：`[质量/年份/安全] [人数] [角色] [系列] [画师] [通用描述]`
- **画师名前必须加 `@`**，如 `@kantoku`。不加 `@` 效果极弱。
- 提示词权重可用，但要给得比 SDXL 更高，如 `(chibi:2)`。
- 纯自然语言时写得越具体越好，至少两句；过短的提示词会跑偏。
- 角色名后面补外貌描述，多角色时尤其重要，否则会混淆。

## 坑

1. **NoobAI-XL 曾在这套环境出不了图，已删除。** 当时实测：文件结构完整（2514 张量、数据区精确覆盖）、权重分布与当时可用的 WAI-Illustrious 几乎一致（layernorm mean 1.70 vs 1.71），但 eps 出近全黑图，`ModelSamplingDiscrete(v_prediction)` 的 zsnr 开或关都出纯噪声，cfg=1 也是彩色噪声。以后若要重装，必须选明确标注 eps 或 vpred 的版本。
2. **Anima 不是写实模型。** 官方原话：*will not work well at realism*。不要照搬 SDXL 经验往负向加 `photorealistic, realistic, photo, cgi, 3d render`，在这个模型上有害无益。

3. **score 标签只给 Base 版用。** Anima-Aesthetic 版官方建议不要用 `score_*`，会把画面推成过曝的 slop。

4. **"COMPLETED" 不等于出图正常。** 必须验证像素，见下节。

5. **ModelScope 上的 Anima 量化版是坏文件。** `Abiray/Anima-base-v1.0-FP8` 等仓库的 safetensors 被截断，加载器会报 `incomplete metadata, file not fully covered`。正版从 hf-mirror 的 `circlestone-labs/Anima` 取。

6. **`circlestone-labs/Anima-Base-v1.0-Diffusers` 是陷阱。** 仓库名对，但里面的 `transformer/` 是普通 DiT、`vae/` 是 5 维视频 VAE，都不是 Anima 组件。真正的文件在 `circlestone-labs/Anima` 的 `split_files/` 下。

## 出图后必须验证

工作流返回 `COMPLETED` 只说明执行完，不说明图没问题。用像素统计核对：

```python
from PIL import Image
import statistics
im = Image.open(path).convert('RGB')
v = list(im.convert('L').getdata())
print('meanL=%.1f dark%%=%.1f colors=%d' % (
    statistics.mean(v),
    100 * sum(1 for x in v if x < 30) / len(v),
    len(im.getcolors(maxcolors=8000000) or []),
))
```

| 指标 | 正常 | 异常 |
|---|---|---|
| `meanL` | 100–200 | < 20 或 > 240 |
| `dark%` | < 20 | > 80 |
| `colors` | > 200000 | < 50000 |

异常时的排查顺序：采样器与模型类型是否匹配（v-pred/eps）→ CFG 是否过低 → 提示词是否为空或全被负向抵消。

## 提示词写法

用户自己给了提示词时原样使用，不做这套加工，直接出图。

用户只给角色名或一句需求时，按下表构建完整提示词，然后**先把提示词发给用户确认，不要直接生成**。确认流程：

1. 用代码块把完整提示词贴出来（正向，必要时附上负向）
2. 一句话说明构图或风格取向
3. 停下等回复

用户说「可以」才出图；用户提修改意见就按他的意思改，改完再发一遍确认。这一步不能省。

### 标签顺序模板

```
[质量] masterpiece, best quality, score_7, safe,
[画风] year YYYY, anime screenshot, official art,
[人数] 1girl / 1boy / 2girls,
[角色] 角色罗马音标签,
[系列] 作品罗马音标签,
[画师] @画师名（可选，风格不匹配时不要硬套）,
[外貌] 发色、发型、瞳色、服装、配饰（4–6 个，最关键的辨识点）,
[姿势] 招牌动作,
[构图] camera angle、景别,
[场景] 背景与光照
```

### 角色还原的三条原则

1. **角色标签 + 外貌标签双写**。角色标签负责「像」，外貌标签负责「稳」。只写角色名容易跑偏，只写外貌会得到路人。
2. **罗马音优先用新版 Danbooru 命名，旧版一起写上更保险**。例如承太郎写 `kujo jotaro, kuujou joutarou`；多余的无效标签不会有害。
3. **多角色必须每人都写外貌**，否则模型会把两人的特征搅在一起。

### 画风锁定

现代 TV 动画质感：

- 正向：`year YYYY, anime screenshot, official art, cel shading, clean lineart`
- 负向排除老画风：`manga, comic book, halftone, cross-hatching, retro, oldschool, vintage, sepia`

`year` 用四位年份，如 `year 2014`，能明显把画风往那年度的 TV 动画拉。

**不要单独使用 `flat colors`**：平涂会把体积感一起抹掉，脸会塌成平面。要保留 `cel shading` 的少量明暗。

### 已知崩坏与修法

| 症状 | 修法 |
|---|---|
| 手指朝镜头糊成一坨 | 换姿势：`hand in pocket` / `fist` / `crossed arms`，避开前缩透视 |
| 脸崩、五官错位 | 正向加 `detailed face, symmetrical face`；负向加 `deformed face, distorted face` |
| 画风偏老 | 加 `year YYYY, anime screenshot`，负向排除 `manga, retro, oldschool` |
| 过度平涂没体积 | 去掉 `flat colors`，只留 `cel shading` |
| 配饰悬空、配件错位 | 负向加 `floating objects, disconnected, broken clothing` |
| 手部多余手指 | 负向加 `extra fingers, fewer fingers, fused fingers, missing fingers` |

### 标准负向

```
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration, bad anatomy, bad hands, extra fingers, fewer fingers, missing fingers
```

画风锁定需求下再追加：`manga, comic book, halftone, cross-hatching, retro, oldschool, vintage, sepia`

### 完整示例

用户说「画个承太郎」→ 直接产出：

```
masterpiece, best quality, score_7, safe, year 2014, anime screenshot, official art,
1boy, solo, kujo jotaro, kuujou joutarou, jojo no kimyou na bouken, stardust crusaders,
black cap, black hair, short hair, teal eyes, black long coat, gold chain, tall, muscular, stern expression,
cel shading, clean lineart, detailed face, hand in pocket, standing, from below, low angle, blue sky background
```

第一张出图后自己看一遍，按「已知崩坏与修法」修正，再把最终结果交给用户。

