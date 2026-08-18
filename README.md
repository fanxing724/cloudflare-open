# AI Gateway — Cloudflare Workers AI 多模态网关

把 [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) 封装成 **OpenAI 兼容** 的多模态 API，零服务器成本，国内可直连（绑定自定义域名）。

支持：对话 / 文生图 / TTS / STT / 文本向量，共 **43 个模型**。

## 功能特性

- ✅ `POST /v1/chat/completions` — 对话补全（含流式 SSE）
- ✅ `POST /v1/images/generations` — 文生图（OpenAI images 格式，返回 `b64_json`）
- ✅ `POST /v1/audio/speech` — 文本转语音 TTS（返回 audio/mpeg）
- ✅ `POST /v1/audio/transcriptions` — 语音转文字 STT
- ✅ `POST /v1/embeddings` — 文本向量化
- ✅ `GET /v1/models` — 模型列表
- ✅ Bearer API Key 鉴权
- ✅ 自带在线文档（访问根路径 `/` 即可查看）

## 快速开始

### 1. 部署到 Cloudflare Workers

前置：Node.js 22+，Cloudflare 账号。

```bash
# 安装依赖
npm install

# 设置你的 API Key（鉴权用，客户端调用时需带上）
npx wrangler secret put API_KEY

# 部署
npx wrangler deploy
```

`wrangler.toml` 里已绑定 `ai = { binding = "AI" }`（Workers AI）。部署后你会得到一个 `https://<你的项目>.workers.dev` 地址。

### 2. 绑定自定义域名（国内直连）

> `*.workers.dev` 在国内无法访问，必须绑定自定义域名。

Cloudflare Dashboard → Workers & Pages → 你的项目 → 设置 → 域和路由 → 添加自定义域。

注意：自定义域名所在的 **zone** 会默认开启 **Browser Integrity Check（BIC）**，它会拦截无标准浏览器 UA 的 API 请求（返回 403 / error 1010）。若用脚本/命令行调用，请在该 zone 的 `Security → Settings` 里关闭 BIC，或建 Configuration Rule 只对你的 API 域名放行。

### 3. 鉴权

所有 `/v1/*` 接口都要求请求头：

```
Authorization: Bearer <你的 API_KEY>
```

## API 文档

Base URL：`https://你的域名`（示例用 `https://api.hakimi.de5.net`）

### GET /v1/models

```bash
curl https://api.hakimi.de5.net/v1/models -H "Authorization: Bearer YOUR_KEY"
```

### POST /v1/chat/completions

```bash
curl https://api.hakimi.de5.net/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/meta/llama-3.2-3b-instruct","messages":[{"role":"user","content":"你好"}]}'
```

流式：请求体加 `"stream":true`。

### POST /v1/images/generations

```bash
curl https://api.hakimi.de5.net/v1/images/generations \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/black-forest-labs/flux-1-schnell","prompt":"a cute cat","n":1}'
```

返回：`{"created":...,"data":[{"b64_json":"..."}]}`。

### POST /v1/audio/speech（TTS）

```bash
curl https://api.hakimi.de5.net/v1/audio/speech \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/deepgram/aura-1","input":"你好世界","voice":"zh"}' -o out.mp3
```

### POST /v1/audio/transcriptions（STT）

```bash
curl https://api.hakimi.de5.net/v1/audio/transcriptions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/openai/whisper","audio":[0.0,0.01,0.02]}'
```

`audio` 支持 float 数组（16k PCM）或 wav 文件 base64；也支持 multipart 上传 wav 文件（字段 `file`）。

### POST /v1/embeddings

```bash
curl https://api.hakimi.de5.net/v1/embeddings \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/baai/bge-m3","input":["你好","hello"]}'
```

## 模型清单

### 对话（21）

- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `@cf/meta/llama-4-scout-17b-16e-instruct`
- `@cf/qwen/qwq-32b`
- `@cf/qwen/qwen2.5-coder-32b-instruct`
- `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`
- `@cf/openai/gpt-oss-120b`
- `@cf/openai/gpt-oss-20b`
- `@cf/nvidia/nemotron-3-120b-a12b`
- `@cf/qwen/qwen3-30b-a3b-fp8`
- `@cf/mistralai/mistral-small-3.1-24b-instruct`
- `@cf/google/gemma-4-26b-a4b-it`
- `@cf/zai-org/glm-4.7-flash`
- `@cf/aisingapore/gemma-sea-lion-v4-27b-it`
- `@cf/meta/llama-3.2-3b-instruct`
- `@cf/meta/llama-3.2-1b-instruct`
- `@cf/meta/llama-3.1-8b-instruct-fp8`
- `@cf/ibm-granite/granite-4.0-h-micro`
- `@cf/mistral/mistral-7b-instruct-v0.2-lora`
- `@cf/google/gemma-7b-it-lora`
- `@cf/google/gemma-2b-it-lora`
- `@cf/meta-llama/llama-2-7b-chat-hf-lora`

### 文生图（6）

- `@cf/black-forest-labs/flux-1-schnell`
- `@cf/leonardo/lucid-origin`
- `@cf/stabilityai/stable-diffusion-xl-base-1.0`
- `@cf/bytedance/stable-diffusion-xl-lightning`
- `@cf/lykon/dreamshaper-8-lcm`
- `@cf/leonardo/phoenix-1.0`

### TTS（4）

- `@cf/deepgram/aura-1`
- `@cf/deepgram/aura-2-en`
- `@cf/deepgram/aura-2-es`
- `@cf/myshell-ai/melotts`

### STT（5）

- `@cf/openai/whisper`
- `@cf/openai/whisper-large-v3-turbo`
- `@cf/openai/whisper-tiny-en`
- `@cf/deepgram/flux`
- `@cf/deepgram/nova-3`

### 向量（7）

- `@cf/baai/bge-m3`
- `@cf/qwen/qwen3-embedding-0.6b`
- `@cf/pfnet/plamo-embedding-1b`
- `@cf/baai/bge-small-en-v1.5`
- `@cf/baai/bge-base-en-v1.5`
- `@cf/google/embeddinggemma-300m`
- `@cf/baai/bge-large-en-v1.5`

## 接入聊天客户端

任选 OpenAI 兼容客户端，填两处即可：

| 字段 | 值 |
|---|---|
| API 地址 / Base URL | `https://你的域名` |
| API Key | `你的 API_KEY` |

支持 Cherry Studio、LobeChat、Open WebUI、opencode、ChatBox 等，填完自动拉取模型列表。

## 已知限制

- Workers AI **免费套餐**不提供 Kimi K2、DeepSeek-v4、GLM-5 等模型（403）。
- `llama-3.2-11b-vision` 需先同意 license。
- **视频生成暂不支持**（Cloudflare 无视频模型）。
- 图片模型返回格式不同（base64 JSON 或二进制），网关已统一兼容。

## 项目结构

```
src/index.ts       # 全部逻辑（单文件）
wrangler.toml      # 部署配置（AI binding）
package.json
```

## License

MIT
