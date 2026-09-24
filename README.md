# AI Gateway — Cloudflare Workers AI 多模态网关

把 [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) 封装成 **OpenAI 兼容** 的多模态 API，零服务器成本，国内可直连（绑定自定义域名）。

支持：对话（含工具调用 / 视觉输入 / 流式）/ 文生图 / TTS / STT / 文本向量，共 **53 个模型**。

## 功能特性

- ✅ `POST /v1/chat/completions` — 对话补全，支持 `stream` SSE、`tools` 函数调用、`response_format`、视觉模型的 `image_url` 内容段
- ✅ `POST /v1/images/generations` — 文生图（返回 `data[].b64_json`），`n` 张并发生成
- ✅ `POST /v1/audio/speech` — 文本转语音，`response_format` 支持 mp3/wav/pcm/opus/aac/flac
- ✅ `POST /v1/audio/transcriptions` — 语音转文字，multipart 直传 mp3/webm/wav
- ✅ `POST /v1/embeddings` — 文本向量化
- ✅ `GET /v1/models`、`GET /v1/models/{id}` — 模型列表
- ✅ `GET /health` — 免鉴权存活探针
- ✅ Bearer API Key 鉴权（SHA-256 摘要后逐位比对，不做短路比较）
- ✅ CORS（含 `OPTIONS` 预检），可用 `ALLOW_ORIGIN` 收紧到指定域名
- ✅ 模型名可用短名：`gpt-oss-120b` 等价于 `@cf/openai/gpt-oss-120b`
- ✅ 自带在线文档（访问根路径 `/`，Base URL 按当前访问域名自动渲染）

## 为什么入参要按模型裁剪

Workers AI 各模型的 input schema **互不相同**，而 Cloudflare 对未声明的键要么报错、要么静默忽略。实测踩过的坑：

| 情况 | 正确写法 |
|---|---|
| `flux-1-schnell` 步数 | `steps`（上限 8），**不是** `num_steps`，且不吃 `width`/`height`/`guidance` |
| SDXL / Leonardo 系步数 | `num_steps` |
| aura 音色 | `speaker`（`luna` `angus` 等枚举），**没有** `lang` 参数 |
| 中文语音 | 只能用 `@cf/myshell-ai/melotts`（`prompt` + `lang: "zh"`） |
| `bge-m3` 向量 | `query` / `contexts[]`，**不是** `text` |
| `whisper`（老版）音频 | 0–255 的字节数组 |
| `whisper-large-v3-turbo` 音频 | 音频文件的 base64 字符串 |

网关按内置的 schema 表为每个模型挑选参数；给某个模型传它不支持的参数会直接返回 400 并列出它接受哪些键，不再出现「请求成功但参数没生效」。清单里没有的 `@cf/` 模型会原样透传，Cloudflare 上新模型后无需改代码。

## 快速开始

### 1. 部署到 Cloudflare Workers

前置：Node.js 22+，Cloudflare 账号。

```bash
npm install
npx wrangler secret put API_KEY   # 网关自身的鉴权 key
npx wrangler deploy
```

`wrangler.toml` 已绑定 `ai = { binding = "AI" }`（Workers AI）。部署后得到一个 `https://<项目>.workers.dev` 地址。

可选：`npx wrangler secret put ALLOW_ORIGIN`，填 `https://a.example.com`（逗号分隔可多个），把 CORS 收紧到指定来源。

### 2. 绑定自定义域名（国内直连）

> `*.workers.dev` 在国内无法访问，必须绑定自定义域名。

Cloudflare Dashboard → Workers & Pages → 你的项目 → 设置 → 域和路由 → 添加自定义域。

注意：自定义域名所在的 **zone** 默认开启 **Browser Integrity Check（BIC）**，它会拦截无标准浏览器 UA 的 API 请求（返回 403 / error 1010）。若用脚本/命令行调用，请在该 zone 的 `Security → Settings` 里关闭 BIC，或建 Configuration Rule 只对 API 域名放行。

### 3. 鉴权

所有 `/v1/*` 接口都要求请求头：

```
Authorization: Bearer <你的 API_KEY>
```

没配 `API_KEY` secret 时接口返回 500 并提示配置命令，不会误判成「key 无效」。

## API 文档

Base URL：`https://你的域名`（下文示例用 `https://api.example.com`）

### POST /v1/chat/completions

```bash
curl https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-oss-120b","messages":[{"role":"user","content":"你好"}]}'
```

| 参数 | 说明 |
|---|---|
| model | 默认 `@cf/meta/llama-3.2-3b-instruct`；支持短名 |
| messages | `content` 传数组时可混排 `text` 与 `image_url`（视觉模型每次一张图） |
| stream | `true` 返回 SSE；上游模型不支持流式时自动降级为单块 |
| max_tokens / temperature / top_p / top_k / min_p / seed / stop | 采样参数，流式与非流式一视同仁透传 |
| tools / tool_choice / response_format / reasoning_effort | 直接透传，需模型本身支持 |
| repetition_penalty / frequency_penalty / presence_penalty / length_penalty / logit_bias / lora | 同上游语义 |

OpenAI 独有、Workers AI 不认的字段（`user`、`metadata`、`service_tier`、`stream_options` 等）会被丢弃而不是转发，避免上游 400。

流式响应是标准 OpenAI chunk 序列：首块带 `role`，中间 `content` 增量（推理模型的思考内容映射为 `reasoning_content`），末块 `finish_reason: "stop"`，以 `data: [DONE]` 收尾。

### POST /v1/images/generations

```bash
curl https://api.example.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"flux-1-schnell","prompt":"a cute cat","steps":4}'
```

返回 `{"created":...,"data":[{"b64_json":"..."}]}`。`n` 支持 1~4（并发生成）；`size: "1024x1024"` 等价于 `width`/`height`。`response_format` 只支持 `b64_json`（Workers AI 不托管图片外链）。

### POST /v1/audio/speech（TTS）

```bash
# 中文
curl https://api.example.com/v1/audio/speech \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"melotts","input":"你好世界","voice":"zh"}' -o out.mp3

# 英文，指定音色与容器格式
curl https://api.example.com/v1/audio/speech \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"aura-2-en","input":"hello world","voice":"luna","response_format":"wav"}' -o out.wav
```

`voice` 对 aura 系列映射为 `speaker`（枚举见 [官方文档](https://developers.cloudflare.com/workers-ai/models/aura-1/)），对 melotts 映射为 `lang`。**aura 只有英文/西班牙语音色，中文必须用 melotts。**

### POST /v1/audio/transcriptions（STT）

```bash
curl https://api.example.com/v1/audio/transcriptions \
  -H "Authorization: Bearer YOUR_KEY" \
  -F file=@demo.mp3 -F model=whisper-large-v3-turbo
```

默认模型 `@cf/openai/whisper-large-v3-turbo` 收 base64，mp3/webm/wav 都能直接上传。也支持 JSON：`{"model":"whisper","audio":"<base64>"}`。可选 `language` / `task` / `vad_filter` / `beam_size` / `initial_prompt`；`response_format: "text"` 返回纯文本。

### POST /v1/embeddings

```bash
curl https://api.example.com/v1/embeddings \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"bge-m3","input":["你好","hello"]}'
```

`input` 支持字符串或字符串数组。网关按模型选 `contexts`（bge-m3）或 `text`（其余）。

### GET /v1/models 与 GET /health

```bash
curl https://api.example.com/v1/models -H "Authorization: Bearer YOUR_KEY"
curl https://api.example.com/health          # 免鉴权，返回模型数与 API_KEY 是否已配置
```

## 模型清单（53）

### 对话（33，含 3 个视觉模型）

- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `@cf/meta/llama-4-scout-17b-16e-instruct`
- `@cf/meta/llama-3.1-8b-instruct-fp8`
- `@cf/meta/llama-3.2-3b-instruct`
- `@cf/meta/llama-3.2-1b-instruct`
- `@cf/meta-llama/llama-2-7b-chat-hf-lora`
- `@cf/meta/llama-guard-3-8b`
- `@cf/qwen/qwq-32b`
- `@cf/qwen/qwen2.5-coder-32b-instruct`
- `@cf/qwen/qwen3-30b-a3b-fp8`
- `@cf/qwen/qwen3.8-27b`
- `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`
- `@cf/deepseek-ai/deepseek-v4-flash-0731`
- `@cf/deepseek-ai/deepseek-v4-pro-0813`
- `@cf/openai/gpt-oss-120b`
- `@cf/openai/gpt-oss-20b`
- `@cf/nvidia/nemotron-3-120b-a12b`
- `@cf/mistralai/mistral-small-3.1-24b-instruct`
- `@cf/mistral/mistral-7b-instruct-v0.2-lora`
- `@cf/google/gemma-4-26b-a4b-it`
- `@cf/google/gemma-7b-it-lora`
- `@cf/google/gemma-2b-it-lora`
- `@cf/aisingapore/gemma-sea-lion-v4-27b-it`
- `@cf/ibm-granite/granite-4.0-h-micro`
- `@cf/zai-org/glm-4.7-flash`
- `@cf/zai-org/glm-5.2`
- `@cf/zai-org/glm-5.3`
- `@cf/zai-org/glm-5.3-flash`
- `@cf/moonshotai/kimi-k2.6`
- `@cf/moonshotai/kimi-k2.7-code`
- `@cf/meta/llama-3.2-11b-vision-instruct` （视觉）
- `@cf/llava-hf/llava-1.5-7b-hf` （视觉）
- `@cf/moondream/moondream3.1-9B-A2B` （视觉）

### 文生图（6）

- `@cf/black-forest-labs/flux-1-schnell`
- `@cf/leonardo/lucid-origin`
- `@cf/leonardo/phoenix-1.0`
- `@cf/stabilityai/stable-diffusion-xl-base-1.0`
- `@cf/bytedance/stable-diffusion-xl-lightning`
- `@cf/lykon/dreamshaper-8-lcm`

### TTS（4）

- `@cf/deepgram/aura-1`
- `@cf/deepgram/aura-2-en`
- `@cf/deepgram/aura-2-es`
- `@cf/myshell-ai/melotts`

### STT（3）

- `@cf/openai/whisper-large-v3-turbo`
- `@cf/openai/whisper`
- `@cf/openai/whisper-tiny-en`

### 向量（7）

- `@cf/baai/bge-m3`
- `@cf/qwen/qwen3-embedding-0.6b`
- `@cf/pfnet/plamo-embedding-1b`
- `@cf/baai/bge-small-en-v1.5`
- `@cf/baai/bge-base-en-v1.5`
- `@cf/google/embeddinggemma-300m`
- `@cf/baai/bge-large-en-v1.5`

## 未封装的官方模型及原因

Cloudflare 目录里还有这些模型，但走不通 OpenAI 兼容端点，故未列入 `GET /v1/models`：

| 模型 | 原因 |
|---|---|
| `@cf/black-forest-labs/flux-2-dev`、`flux-2-klein-4b`、`flux-2-klein-9b` | 入参要求 `multipart` 对象，不是文本生图 JSON |
| `@cf/deepgram/nova-3`、`@cf/deepgram/flux` | 实时流式识别，入参是 `audio.body` + `contentType` |
| `@cf/runwayml/stable-diffusion-v1-5-inpainting` | 必须同时传 `image` + `mask` |
| `@cf/microsoft/resnet-50` | 图像分类，OpenAI 无对应端点 |
| `@cf/meta/m2m100-1.2b`、`@cf/ai4bharat/indictrans2-en-indic-1B` | 翻译 |
| `@cf/huggingface/distilbert-sst-2-int8` | 情感分类 |
| `@cf/baai/bge-reranker-base` | 重排序，可另加 `/v1/rerank` |
| `@cf/pipecat-ai/smart-turn-v2` | 语音轮次检测 |

需要的话可以为它们各加一个非标准端点，但那就不再是 OpenAI 兼容接口了。

## 接入聊天客户端

任选 OpenAI 兼容客户端，填两处即可：

| 字段 | 值 |
|---|---|
| API 地址 / Base URL | `https://你的域名` |
| API Key | `你的 API_KEY` |

支持 Cherry Studio、LobeChat、Open WebUI、opencode、ChatBox 等，填完自动拉取模型列表。

## 什么时候其实不需要这个网关

Cloudflare 从 2026 年起 **自带** OpenAI 兼容端点了：

```
https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/chat/completions
```

用 Cloudflare API Token 当 `apiKey` 即可直连，覆盖 Chat Completions、Embeddings，以及 gpt-oss 系列的 Responses API（见 [官方说明](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)）。如果你的需求只是「让某个客户端调 Workers AI 的文本模型」，直连更省事，不用维护 Worker。

本网关仍然有价值的场景：

- 不想把 Cloudflare API Token（能操作整个账号）交给客户端 —— 网关只暴露一个自定义 key
- 需要 **图片 / TTS / STT**，官方兼容端点不覆盖这三类
- 需要浏览器直调（自定义 CORS）、免鉴权健康检查、短名模型、在线文档页
- 需要绑自定义域名绕开 `workers.dev` 的连通性问题

## 开发

```bash
npm run check   # tsc --noEmit，纯类型检查
npm test        # 离线冒烟测试：打桩 AI binding，校验路由/鉴权/按模型裁剪入参/流式转换
```

`test/smoke.mjs` 不发真实请求、不需要 Cloudflare 账号，53 项断言里包含若干历史回归用例（`num_steps` 对 flux、`voice` 对 aura、`contexts` 对 bge-m3 等）。改 schema 表时先跑它。

## 已知限制

- 免费额度实际可调用哪些模型以真实响应为准；付费限定模型返回 403，网关原样透出为 502。清单核对自官方目录，但不等于免费套餐都能用。
- **视频生成不支持**（Cloudflare 无视频模型）。
- `@cf/meta/llama-3.2-11b-vision-instruct` 等带 license 的模型需先在 Dashboard 同意条款。
- 单次视觉对话只接受一张图片（Workers AI 的限制）。
- 图片以 base64 返回，`n: 4` 的大图响应可能超过客户端的 body 限制。

## 项目结构

```
src/index.ts       # 全部逻辑（单文件）
test/smoke.mjs     # 离线冒烟测试
wrangler.toml      # 部署配置（AI binding）
package.json
```

## License

MIT
