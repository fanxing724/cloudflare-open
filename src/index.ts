/**
 * AI Gateway — Cloudflare Workers AI 的 OpenAI 兼容接口
 *
 * 端点：
 *  - GET  /                        在线文档
 *  - GET  /health                  存活探针（免鉴权）
 *  - GET  /v1/models               模型列表
 *  - GET  /v1/models/{id}          单个模型
 *  - POST /v1/chat/completions     对话（流式 SSE / 工具调用 / 视觉输入）
 *  - POST /v1/images/generations   文生图
 *  - POST /v1/audio/speech         文本转语音
 *  - POST /v1/audio/transcriptions 语音转文字
 *  - POST /v1/embeddings           向量化
 *
 * 绑定：AI（Workers AI）、API_KEY（secret 鉴权）、ALLOW_ORIGIN（可选 CORS 白名单）
 *
 * 模型清单校对自 https://developers.cloudflare.com/workers-ai/llms.txt，
 * 各模型入参校对自同目录下的 schema-input.json。
 */

type Task = 'chat' | 'image' | 'tts' | 'stt' | 'embedding';
type Shape = 'aura' | 'melotts' | 'bytes' | 'base64' | 'text' | 'contexts';

interface ModelSpec {
  id: string;
  task: Task;
  /** 该模型接受的生成参数；Cloudflare 对未声明的键会报错或静默忽略，因此必须按模型裁剪 */
  params?: readonly string[];
  /** 同一 task 下不同模型的输入形态差异 */
  shape?: Shape;
}

interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  API_KEY?: string;
  ALLOW_ORIGIN?: string;
}

// ---------- 模型清单 ----------

const CHAT_IDS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/meta-llama/llama-2-7b-chat-hf-lora',
  '@cf/meta/llama-guard-3-8b',
  '@cf/qwen/qwq-32b',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/qwen/qwen3.8-27b',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/mistral/mistral-7b-instruct-v0.2-lora',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/google/gemma-7b-it-lora',
  '@cf/google/gemma-2b-it-lora',
  '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  '@cf/ibm-granite/granite-4.0-h-micro',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-5.3',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  // 视觉对话：走 /v1/chat/completions，图片以 image_url 内容段传入
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/llava-hf/llava-1.5-7b-hf',
  '@cf/moondream/moondream3.1-9B-A2B',
];

const SDXL_PARAMS = ['negative_prompt', 'width', 'height', 'num_steps', 'guidance', 'seed', 'strength', 'image_b64'] as const;
const LEONARDO_PARAMS = ['negative_prompt', 'width', 'height', 'num_steps', 'guidance', 'seed'] as const;

const IMAGE_SPECS: ModelSpec[] = [
  // flux-1-schnell 的步数键是 steps，且不吃 width/height/guidance
  { id: '@cf/black-forest-labs/flux-1-schnell', task: 'image', params: ['steps'] },
  { id: '@cf/leonardo/lucid-origin', task: 'image', params: LEONARDO_PARAMS },
  { id: '@cf/leonardo/phoenix-1.0', task: 'image', params: LEONARDO_PARAMS },
  { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', task: 'image', params: SDXL_PARAMS },
  { id: '@cf/bytedance/stable-diffusion-xl-lightning', task: 'image', params: SDXL_PARAMS },
  { id: '@cf/lykon/dreamshaper-8-lcm', task: 'image', params: SDXL_PARAMS },
];

const TTS_SPECS: ModelSpec[] = [
  // aura 系列用 speaker 选音色，没有 lang 参数；英文/西班牙语，中文要用 melotts
  { id: '@cf/deepgram/aura-1', task: 'tts', shape: 'aura' },
  { id: '@cf/deepgram/aura-2-en', task: 'tts', shape: 'aura' },
  { id: '@cf/deepgram/aura-2-es', task: 'tts', shape: 'aura' },
  { id: '@cf/myshell-ai/melotts', task: 'tts', shape: 'melotts' },
];

const STT_SPECS: ModelSpec[] = [
  // whisper / whisper-tiny-en 的 audio 是 0-255 的字节数组；large-v3-turbo 收 base64 字符串
  { id: '@cf/openai/whisper-large-v3-turbo', task: 'stt', shape: 'base64' },
  { id: '@cf/openai/whisper', task: 'stt', shape: 'bytes' },
  { id: '@cf/openai/whisper-tiny-en', task: 'stt', shape: 'bytes' },
];

const EMBEDDING_SPECS: ModelSpec[] = [
  // bge-m3 收 query/contexts，其余收 text（qwen3 的 text 是 documents 的别名）
  { id: '@cf/baai/bge-m3', task: 'embedding', shape: 'contexts' },
  { id: '@cf/qwen/qwen3-embedding-0.6b', task: 'embedding', shape: 'text' },
  { id: '@cf/pfnet/plamo-embedding-1b', task: 'embedding', shape: 'text' },
  { id: '@cf/baai/bge-small-en-v1.5', task: 'embedding', shape: 'text' },
  { id: '@cf/baai/bge-base-en-v1.5', task: 'embedding', shape: 'text' },
  { id: '@cf/baai/bge-large-en-v1.5', task: 'embedding', shape: 'text' },
  { id: '@cf/google/embeddinggemma-300m', task: 'embedding', shape: 'text' },
];

const ALL_MODELS: ModelSpec[] = [
  ...CHAT_IDS.map((id): ModelSpec => ({ id, task: 'chat' })),
  ...IMAGE_SPECS,
  ...TTS_SPECS,
  ...STT_SPECS,
  ...EMBEDDING_SPECS,
];

const BY_ID = new Map(ALL_MODELS.map((m) => [m.id, m]));
const BY_SLUG = new Map(ALL_MODELS.map((m) => [m.id.split('/').pop()!.toLowerCase(), m]));

const DEFAULT_CHAT = '@cf/meta/llama-3.2-3b-instruct';
const DEFAULT_IMG = '@cf/black-forest-labs/flux-1-schnell';
const DEFAULT_TTS = '@cf/deepgram/aura-1';
const DEFAULT_STT = '@cf/openai/whisper-large-v3-turbo';
const DEFAULT_EMB = '@cf/baai/bge-m3';

/** 允许透传给 Workers AI 的采样/生成参数；OpenAI 独有或不支持的字段一律丢弃 */
const CHAT_PARAMS: Record<string, string> = {
  max_tokens: 'max_tokens',
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  seed: 'seed',
  stop: 'stop',
  repetition_penalty: 'repetition_penalty',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  length_penalty: 'length_penalty',
  response_format: 'response_format',
  tools: 'tools',
  tool_choice: 'tool_choice',
  reasoning_effort: 'reasoning_effort',
  logit_bias: 'logits_bias',
  lora: 'lora',
  raw: 'raw',
};

// ---------- 工具 ----------

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly type = 'invalid_request_error') {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fail(status: number, message: string, type = 'invalid_request_error'): Response {
  return json({ error: { message, type, param: null, code: null } }, status);
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 可选数值参数：字符串数字（"7.5"）也接受，其余一律当作未传 */
function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allow = env.ALLOW_ORIGIN?.trim() || '*';
  // 配了白名单且命中时回填真实 Origin，这样带 credentials 的请求也能用
  let value = allow;
  if (allow !== '*' && origin && allow.split(/\s*,\s*/).includes(origin)) value = origin;
  return {
    'Access-Control-Allow-Origin': value,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

/** 走 hash 再比对，避免逐字节短路比较泄漏时序 */
async function checkAuth(request: Request, env: Env): Promise<Response | null> {
  if (!env.API_KEY) {
    return fail(500, '服务端未配置 API_KEY secret：先执行 npx wrangler secret put API_KEY', 'server_misconfigured');
  }
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return fail(401, 'Missing API key', 'invalid_request_error');

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const expected = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.API_KEY));
  const a = new Uint8Array(digest);
  const b = new Uint8Array(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return fail(401, 'Invalid API key', 'invalid_request_error');
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readBodyBytes(body: unknown): Promise<Uint8Array> {
  if (typeof body === 'string') return base64ToBytes(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ReadableStream) return new Uint8Array(await new Response(body).arrayBuffer());
  throw new ApiError(502, `无法识别图片返回类型: ${Object.prototype.toString.call(body)}`, 'upstream_error');
}

/** 图片返回有 ReadableStream / {image:base64} / {result:{image}} / 裸 base64 四种形态 */
async function imageToBase64(raw: unknown): Promise<string> {
  if (typeof raw === 'string') return raw.startsWith('data:') ? raw.split(',', 2)[1] : raw;
  if (raw instanceof Uint8Array) return bytesToBase64(raw);
  if (raw instanceof ArrayBuffer || raw instanceof ReadableStream) return bytesToBase64(await readBodyBytes(raw));
  const obj = raw as Record<string, unknown>;
  for (const key of ['image', 'b64_json']) {
    if (typeof obj?.[key] === 'string') return obj[key] as string;
  }
  const inner = obj?.response ?? obj?.result;
  if (inner && inner !== raw) return imageToBase64(inner);
  throw new ApiError(502, `无法解析图片返回: ${JSON.stringify(obj)?.slice(0, 200)}`, 'upstream_error');
}

/** 解析出模型；目录外的 ID 原样放行，Cloudflare 上新模型时无需改代码 */
function resolveModel(input: unknown, task: Task, fallback: string): ModelSpec {
  const wanted = typeof input === 'string' && input.trim() ? input.trim() : fallback;
  const direct = BY_ID.get(wanted);
  if (direct) {
    if (direct.task !== task) throw new ApiError(400, `${wanted} 不是 ${task} 模型`);
    return direct;
  }
  if (wanted.startsWith('@cf/')) return { id: wanted, task };
  const bySlug = BY_SLUG.get(wanted.toLowerCase());
  if (bySlug) {
    if (bySlug.task !== task) throw new ApiError(400, `${wanted} 不是 ${task} 模型`);
    return bySlug;
  }
  throw new ApiError(400, `未知模型 ${wanted}，先用 GET /v1/models 查看可用列表`);
}

function openAiContent(res: unknown): string {
  if (typeof res === 'string') return res;
  const obj = res as Record<string, unknown>;
  if (typeof obj?.response === 'string') return obj.response;
  if (typeof obj?.result === 'string') return obj.result;
  return JSON.stringify(res);
}

// ---------- Chat ----------

/** OpenAI 的多模态 content 段落成 Cloudflare 的 content + image 字段 */
function toWorkerMessages(messages: unknown[]): Record<string, unknown>[] {
  return messages.map((raw) => {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const content = msg.content;
    if (typeof content === 'string' || content == null) return msg;
    if (!Array.isArray(content)) return { ...msg, content: String(content) };

    let text = '';
    const images: string[] = [];
    for (const part of content as Record<string, unknown>[]) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') text += typeof part.text === 'string' ? part.text : '';
      else if (part.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url as Record<string, unknown>)?.url;
        if (typeof url === 'string') images.push(url);
      } else if (part.type === 'image' && typeof part.image === 'string') images.push(part.image);
    }
    if (images.length > 1) throw new ApiError(400, 'Workers AI 视觉模型单次只接受一张图片');
    const out: Record<string, unknown> = { ...msg, content: text };
    if (images.length === 1) out.image = images[0];
    else delete out.image;
    return out;
  });
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON');
  }
  const spec = resolveModel(body.model, 'chat', DEFAULT_CHAT);
  const stream = body.stream === true;

  const messages = Array.isArray(body.messages)
    ? toWorkerMessages(body.messages)
    : typeof body.prompt === 'string'
      ? [{ role: 'user', content: body.prompt }]
      : null;
  if (!messages?.length) throw new ApiError(400, 'messages 不能为空');

  const input: Record<string, unknown> = { messages };
  for (const [from, to] of Object.entries(CHAT_PARAMS)) {
    if (body[from] !== undefined) input[to] = body[from];
  }
  if (stream) input.stream = true;

  if (!stream) {
    const res = await env.AI.run(spec.id, input);
    const obj = (res ?? {}) as Record<string, unknown>;
    const usage = (obj.usage ?? {}) as Record<string, number>;
    const message: Record<string, unknown> = { role: 'assistant', content: openAiContent(res) };
    if (obj.tool_calls) message.tool_calls = obj.tool_calls;
    if (typeof obj.thinking === 'string') message.reasoning_content = obj.thinking;
    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    return json({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: spec.id,
      choices: [{ index: 0, message, finish_reason: obj.tool_calls ? 'tool_calls' : 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
      },
    });
  }

  const aiResult = await env.AI.run(spec.id, input);
  // 并非所有模型都支持 stream，绑定返回非流时降级成单块 SSE，别让客户端拿到半个响应
  const aiStream = aiResult instanceof ReadableStream
    ? aiResult as ReadableStream<Uint8Array>
    : new ReadableStream<Uint8Array>({
        start(controller) {
          const text = typeof (aiResult as Record<string, unknown>)?.response === 'string' ? (aiResult as Record<string, string>).response : '';
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: text })}\n\n`));
          controller.close();
        },
      });
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = spec.id;

  const send = (delta: Record<string, unknown>, finish: string | null): Uint8Array =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );

  const rs = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = aiStream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sentRole = false;
      const ensureRole = () => {
        if (sentRole) return;
        sentRole = true;
        controller.enqueue(send({ role: 'assistant' }, null));
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            const content = typeof chunk.response === 'string' ? chunk.response : chunk.delta;
            const thinking = typeof chunk.thinking === 'string' ? chunk.thinking : null;
            if (chunk.tool_calls) {
              ensureRole();
              controller.enqueue(send({ tool_calls: chunk.tool_calls }, null));
            }
            if (thinking) {
              ensureRole();
              controller.enqueue(send({ reasoning_content: thinking }, null));
            }
            if (content) {
              ensureRole();
              controller.enqueue(send({ content }, null));
            }
          }
        }
        ensureRole();
        controller.enqueue(send({}, 'stop'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  return new Response(rs, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ---------- 文生图 ----------

/** OpenAI 的 size="1024x768" 与 Cloudflare 的 width/height 对齐 */
function imageInput(spec: ModelSpec, body: Record<string, unknown>): Record<string, unknown> {
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) throw new ApiError(400, 'prompt is required');

  const wanted: Record<string, unknown> = {
    prompt,
    negative_prompt: typeof body.negative_prompt === 'string' ? body.negative_prompt : undefined,
    width: num(body.width),
    height: num(body.height),
    num_steps: num(body.num_steps ?? body.steps),
    guidance: num(body.guidance),
    seed: num(body.seed),
    strength: num(body.strength),
    image_b64: typeof body.image === 'string' ? body.image : body.image_b64,
  };
  const size = typeof body.size === 'string' ? body.size.match(/^(\d+)\s*[x×]\s*(\d+)$/i) : null;
  if (size) {
    wanted.width = parseInt(size[1], 10);
    wanted.height = parseInt(size[2], 10);
  }

  // 未收录的新模型不知道 schema，原样透传给 Cloudflare 校验
  if (!spec.params) {
    const out: Record<string, unknown> = { prompt };
    for (const [k, v] of Object.entries(body)) {
      if (['model', 'prompt', 'n', 'response_format', 'user', 'size'].includes(k) || v === undefined) continue;
      out[k] = v;
    }
    return out;
  }

  const allow = new Set<string>(spec.params);
  const out: Record<string, unknown> = { prompt };
  for (const key of allow) {
    let value = wanted[key];
    if (key === 'steps') value = wanted.num_steps;
    if (value !== undefined) out[key] = value;
  }
  const dropped = Object.keys(wanted).filter((k) => wanted[k] !== undefined && k !== 'prompt' && !allow.has(k) && !(k === 'num_steps' && allow.has('steps')));
  if (dropped.length) {
    throw new ApiError(400, `${spec.id} 不支持参数 ${dropped.join(', ')}；该模型只接受 ${[...allow].join(', ') || '（仅 prompt）'}`);
  }
  return out;
}

async function handleImages(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON');
  }
  if (body.response_format && body.response_format !== 'b64_json') {
    throw new ApiError(400, '只支持 response_format=b64_json（Workers AI 不托管图片外链）');
  }
  const spec = resolveModel(body.model, 'image', DEFAULT_IMG);
  const n = Math.min(Math.max(1, toInt(body.n, 1)), 4);
  const input = imageInput(spec, body);

  const results = await Promise.all(
    Array.from({ length: n }, () => env.AI.run(spec.id, input).then(imageToBase64)),
  );
  return json({
    created: Math.floor(Date.now() / 1000),
    data: results.map((b64_json) => ({ b64_json })),
  });
}

// ---------- TTS ----------

const TTS_FORMAT: Record<string, { encoding: string; container: string; mime: string }> = {
  mp3: { encoding: 'mp3', container: 'none', mime: 'audio/mpeg' },
  wav: { encoding: 'linear16', container: 'wav', mime: 'audio/wav' },
  pcm: { encoding: 'linear16', container: 'none', mime: 'audio/L16' },
  opus: { encoding: 'opus', container: 'ogg', mime: 'audio/ogg' },
  aac: { encoding: 'aac', container: 'none', mime: 'audio/aac' },
  flac: { encoding: 'flac', container: 'none', mime: 'audio/flac' },
};

async function handleTTS(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON');
  }
  const spec = resolveModel(body.model, 'tts', DEFAULT_TTS);
  const text = String(body.input ?? '').trim();
  if (!text) throw new ApiError(400, 'input is required');

  const format = TTS_FORMAT[String(body.response_format ?? 'mp3')] ?? TTS_FORMAT.mp3;
  let input: Record<string, unknown>;
  let mime = format.mime;

  if (spec.shape === 'melotts') {
    // melotts 只出 mpeg；voice 语义是语言码（zh / en / ja ...）
    input = { prompt: text, lang: String(body.voice ?? body.lang ?? 'en') };
    mime = 'audio/mpeg';
  } else {
    input = { text, encoding: format.encoding, container: format.container };
    const speaker = body.speaker ?? body.voice;
    if (typeof speaker === 'string' && speaker) input.speaker = speaker;
    const sampleRate = num(body.sample_rate);
    if (sampleRate !== undefined) input.sample_rate = sampleRate;
    const bitRate = num(body.bit_rate);
    if (bitRate !== undefined) input.bit_rate = bitRate;
  }

  const raw = await env.AI.run(spec.id, input);
  const toResponse = (bytes: Uint8Array) =>
    new Response(bytes, { headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length) } });

  if (raw instanceof ReadableStream) return new Response(raw as ReadableStream, { headers: { 'Content-Type': mime } });
  if (raw instanceof Uint8Array) return toResponse(raw);
  if (typeof raw === 'string') return toResponse(base64ToBytes(raw));
  const audio = (raw as Record<string, unknown>)?.audio;
  if (typeof audio === 'string') return toResponse(base64ToBytes(audio));
  throw new ApiError(502, `无法解析 TTS 返回: ${JSON.stringify(raw)?.slice(0, 200)}`, 'upstream_error');
}

// ---------- STT ----------

const STT_PARAMS = ['language', 'task', 'vad_filter', 'beam_size', 'initial_prompt', 'prefix'];

async function handleSTT(request: Request, env: Env): Promise<Response> {
  const query = new URL(request.url).searchParams;
  let model: unknown = query.get('model') ?? undefined;
  let raw: unknown;
  let responseFormat = query.get('response_format') ?? '';
  const extra: Record<string, unknown> = {};

  const isMultipart = (request.headers.get('Content-Type') || '').includes('multipart/form-data');
  try {
    if (isMultipart) {
      const form = await request.formData();
      const pick = (key: string) => {
        const v = form.get(key);
        return typeof v === 'string' && v ? v : undefined;
      };
      model = pick('model') ?? model;
      responseFormat = pick('response_format') ?? responseFormat;
      const file = form.get('file');
      if (file && typeof file !== 'string') raw = new Uint8Array(await (file as Blob).arrayBuffer());
      else if (pick('audio')) raw = pick('audio');
      for (const key of STT_PARAMS) {
        const v = pick(key);
        if (v !== undefined) extra[key] = key === 'vad_filter' ? v === 'true' : v;
      }
    } else {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.model) model = body.model;
      if (typeof body.response_format === 'string') responseFormat = body.response_format;
      raw = body.audio;
      for (const key of STT_PARAMS) {
        if (body[key] !== undefined) extra[key] = body[key];
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, '请求体既不是 multipart 也不是合法 JSON');
  }

  const spec = resolveModel(model, 'stt', DEFAULT_STT);
  let audio: unknown;
  if (Array.isArray(raw)) {
    audio = raw; // 调用方自备采样数组，原样交给 Cloudflare 校验
  } else if (typeof raw === 'string' && raw) {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(raw);
    } catch {
      throw new ApiError(400, 'audio 不是合法的 base64 字符串');
    }
    audio = spec.shape === 'bytes' ? Array.from(bytes) : bytesToBase64(bytes);
  } else if (raw instanceof Uint8Array) {
    audio = spec.shape === 'bytes' ? Array.from(raw) : bytesToBase64(raw);
  }
  if (audio == null) {
    throw new ApiError(400, 'audio 不能为空：multipart 用 file 字段上传音频，JSON 用 base64 字符串或采样数组');
  }

  const res = (await env.AI.run(spec.id, { audio, ...extra })) as Record<string, unknown>;
  const text = typeof res?.text === 'string' ? res.text : openAiContent(res);
  if (responseFormat === 'text') {
    return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return json({
    text,
    ...(res?.segments ? { segments: res.segments } : {}),
    ...(res?.language ? { language: res.language } : {}),
  });
}

// ---------- Embeddings ----------

async function handleEmbeddings(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON');
  }
  const spec = resolveModel(body.model, 'embedding', DEFAULT_EMB);
  const raw = body.input;
  const inputs = (Array.isArray(raw) ? raw : [raw]).map((x) =>
    typeof x === 'string' ? x : String((x as Record<string, unknown>)?.content ?? ''),
  );
  if (!inputs.length || inputs.some((s) => !s)) throw new ApiError(400, 'input 不能为空');

  const input: Record<string, unknown> =
    spec.shape === 'contexts' ? { contexts: inputs } : { text: inputs };
  if (typeof body.instruction === 'string') input.instruction = body.instruction;

  const res = (await env.AI.run(spec.id, input)) as Record<string, unknown>;
  const vectors = (res?.data ?? res?.embedding ?? []) as number[][];
  return json({
    object: 'list',
    model: spec.id,
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
}

// ---------- Models ----------

const OWNED_BY: Record<Task, string> = {
  chat: 'cloudflare-text',
  image: 'cloudflare-image',
  tts: 'cloudflare-tts',
  stt: 'cloudflare-stt',
  embedding: 'cloudflare-embedding',
};

const toModelObject = (m: ModelSpec) => ({ id: m.id, object: 'model', created: 0, owned_by: OWNED_BY[m.task] });

function handleModels(): Response {
  return json({ object: 'list', data: ALL_MODELS.map(toModelObject) });
}

function handleModel(id: string): Response {
  const m = BY_ID.get(id) ?? BY_SLUG.get(id.toLowerCase());
  if (!m) return fail(404, `model ${id} not found`, 'not_found');
  return json(toModelObject(m));
}

// ---------- Home ----------

function handleHome(host: string): Response {
  const base = `https://${host}`;
  const li = (arr: ModelSpec[]) => arr.map((m) => `<li><code>${m.id}</code></li>`).join('');
  const by = (task: Task) => ALL_MODELS.filter((m) => m.task === task);
  const curl = (path: string, payload: string) =>
    `<pre>curl ${base}${path} \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${payload}'</pre>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Gateway — Cloudflare Workers AI 多模态网关</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--border:#e5e7eb;--text:#111827;--muted:#6b7280;--accent:#6366f1;--code:#0f172a}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);line-height:1.65}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 80px}
header{text-align:center;padding:24px 0 8px}
header h1{font-size:28px;margin:0 0 6px}
header .sub{color:var(--muted);font-size:14px}
.badges{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:16px 0}
.badge{background:var(--accent);color:#fff;border-radius:999px;padding:4px 14px;font-size:12px;font-weight:600}
h2{font-size:20px;margin:40px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--border)}
h3{font-size:16px;margin:24px 0 8px}
.card,.endpoint{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin:12px 0}
.method{display:inline-block;font-weight:700;font-size:12px;padding:2px 10px;border-radius:6px;margin-right:8px;color:#fff}
.get{background:#059669}.post{background:#2563eb}
.path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:15px;font-weight:600}
.desc{color:var(--muted);font-size:13px;margin:6px 0 12px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}
th,td{border:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f3f4f6}
code{background:#eef2ff;color:#4f46e5;padding:1px 6px;border-radius:4px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
pre{background:var(--code);color:#e2e8f0;border-radius:10px;padding:16px;overflow-x:auto;font-size:12.5px;line-height:1.6}
pre code{background:none;color:#e2e8f0;padding:0;font-size:12.5px}
ul.models{columns:2;column-gap:24px;list-style:none;padding:0;margin:8px 0;font-size:12.5px}
ul.models li{margin:4px 0;break-inside:avoid}
.note{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;font-size:13px;color:#92400e;margin:12px 0}
a{color:var(--accent)}
footer{text-align:center;color:var(--muted);font-size:12px;margin-top:48px}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>AI Gateway</h1>
  <div class="sub">Cloudflare Workers AI — OpenAI 兼容多模态网关</div>
  <div class="badges">
    <span class="badge">对话 / 文生图 / TTS / STT / 向量</span>
    <span class="badge">共 ${ALL_MODELS.length} 个模型</span>
    <span class="badge">OpenAI 兼容</span>
  </div>
</header>

<h2>快速开始</h2>
<div class="card">
  <p><strong>Base URL：</strong><code>${base}</code></p>
  <p><strong>鉴权：</strong>所有 <code>/v1/*</code> 接口都需要请求头 <code>Authorization: Bearer &lt;你的 API_KEY&gt;</code></p>
  <p><strong>模型名：</strong>可以用完整 ID，也可以只写短名（<code>gpt-oss-120b</code> 等价于 <code>@cf/openai/gpt-oss-120b</code>）</p>
  <p>验证是否可用：</p>
  <pre>curl ${base}/v1/models -H "Authorization: Bearer YOUR_KEY"</pre>
</div>

<h2>接口文档</h2>

<div class="endpoint">
  <span class="method get">GET</span><span class="path">/v1/models</span>
  <p class="desc">列出全部可用模型；<code>GET /v1/models/{id}</code> 查单个。</p>
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/chat/completions</span>
  <p class="desc">对话补全，兼容 OpenAI 格式，支持流式 <code>stream</code>、<code>tools</code> 工具调用与视觉输入。</p>
  <table>
    <tr><th>参数</th><th>说明</th></tr>
    <tr><td>model</td><td>模型 ID，默认 <code>${DEFAULT_CHAT}</code></td></tr>
    <tr><td>messages</td><td>对话数组；<code>content</code> 传数组时可混排 <code>text</code> 与 <code>image_url</code>（视觉模型每次一张图）</td></tr>
    <tr><td>stream</td><td>true 时返回 SSE 流式</td></tr>
    <tr><td>max_tokens / temperature / top_p / top_k / seed / stop</td><td>采样参数，原样透传给 Workers AI</td></tr>
    <tr><td>tools / tool_choice / response_format / reasoning_effort</td><td>需模型本身支持，网关不做裁剪</td></tr>
  </table>
  ${curl('/v1/chat/completions', `{"model":"gpt-oss-120b","messages":[{"role":"user","content":"你好"}]}`)}
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/images/generations</span>
  <p class="desc">文生图，返回 OpenAI images 格式（<code>data[].b64_json</code>）。<strong>各模型入参不同，网关按模型裁剪，传了它不支持的参数会直接报 400 而不是静默忽略。</strong></p>
  <table>
    <tr><th>参数</th><th>说明</th></tr>
    <tr><td>model</td><td>图片模型，默认 <code>${DEFAULT_IMG}</code></td></tr>
    <tr><td>prompt</td><td>图片描述（必填）</td></tr>
    <tr><td>n</td><td>生成张数 1~4，并发生成</td></tr>
    <tr><td>size</td><td><code>"1024x1024"</code>，等价于 width/height（仅 SDXL / Leonardo 系）</td></tr>
    <tr><td>steps / num_steps</td><td>步数。<code>flux-1-schnell</code> 只认 <code>steps</code> 且上限 8，SDXL 系用 <code>num_steps</code></td></tr>
    <tr><td>negative_prompt / guidance / seed</td><td>按模型支持情况透传</td></tr>
  </table>
  ${curl('/v1/images/generations', `{"model":"flux-1-schnell","prompt":"a cute cat","steps":4}`)}
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/audio/speech</span>
  <p class="desc">文本转语音，返回音频二进制。</p>
  <table>
    <tr><th>参数</th><th>说明</th></tr>
    <tr><td>model</td><td>TTS 模型，默认 <code>${DEFAULT_TTS}</code></td></tr>
    <tr><td>input</td><td>要合成的文本（必填）</td></tr>
    <tr><td>voice</td><td>aura 系映射到 <code>speaker</code>（如 <code>luna</code> <code>angus</code>）；melotts 映射到 <code>lang</code>（如 <code>zh</code>）</td></tr>
    <tr><td>response_format</td><td>mp3 / wav / pcm / opus / aac / flac（melotts 固定 mp3）</td></tr>
  </table>
  <p class="desc">中文语音请用 <code>@cf/myshell-ai/melotts</code> + <code>"voice":"zh"</code>；Deepgram aura 只有英文/西班牙语音色。</p>
  ${curl('/v1/audio/speech', `{"model":"melotts","input":"你好世界","voice":"zh"}`)}
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/audio/transcriptions</span>
  <p class="desc">语音转文字。multipart 上传任意常见音频格式（mp3/webm/wav），或 JSON 传 base64。</p>
  <table>
    <tr><th>参数</th><th>说明</th></tr>
    <tr><td>model</td><td>STT 模型，默认 <code>${DEFAULT_STT}</code>（收 base64，支持多格式）</td></tr>
    <tr><td>file</td><td>multipart 音频文件字段</td></tr>
    <tr><td>language / task / vad_filter</td><td>可选识别参数</td></tr>
  </table>
  <pre>curl ${base}/v1/audio/transcriptions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -F file=@demo.mp3 -F model=whisper-large-v3-turbo</pre>
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/embeddings</span>
  <p class="desc">文本向量化，返回 OpenAI embeddings 格式。</p>
  ${curl('/v1/embeddings', `{"model":"bge-m3","input":["你好","hello"]}`)}
</div>

<h2>模型清单（${ALL_MODELS.length} 个）</h2>

<h3>对话模型（${by('chat').length}，含 3 个视觉模型）</h3>
<ul class="models">${li(by('chat'))}</ul>

<h3>文生图模型（${by('image').length}）</h3>
<ul class="models">${li(by('image'))}</ul>

<h3>TTS 语音合成（${by('tts').length}）</h3>
<ul class="models">${li(by('tts'))}</ul>

<h3>STT 语音转文字（${by('stt').length}）</h3>
<ul class="models">${li(by('stt'))}</ul>

<h3>向量模型（${by('embedding').length}）</h3>
<ul class="models">${li(by('embedding'))}</ul>

<h2>接入聊天客户端</h2>
<div class="card">
  <p>任选一个 OpenAI 兼容客户端，填：</p>
  <table>
    <tr><th>字段</th><th>值</th></tr>
    <tr><td>API 地址 / Base URL</td><td><code>${base}</code></td></tr>
    <tr><td>API Key</td><td><code>你的 API_KEY</code></td></tr>
  </table>
  <p>支持 Cherry Studio、LobeChat、Open WebUI、opencode、ChatBox 等，填完自动拉取模型列表。</p>
</div>

<div class="note">
  <strong>注意：</strong>Workers AI 免费额度的可用模型以实际调用返回为准，付费限定模型会返回 403。视频生成、重排序（bge-reranker）、翻译（m2m100）、需 multipart 入参的模型（FLUX.2 系列、Deepgram 流式识别）未在本网关封装。
</div>

<footer>AI Gateway · 基于 Cloudflare Workers AI · 源码见 GitHub 仓库</footer>
</div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------- 路由 ----------

const ROUTES: Record<string, { method: string; auth: boolean; run: (req: Request, env: Env, m: RegExpMatchArray) => Promise<Response> | Response }> = {
  '^models$': { method: 'GET', auth: true, run: () => handleModels() },
  '^models/(.+)$': { method: 'GET', auth: true, run: (_req, _env, m) => handleModel(decodeURIComponent(m[1])) },
  '^chat/completions$': { method: 'POST', auth: true, run: (req, env) => handleChat(req, env) },
  '^images/generations$': { method: 'POST', auth: true, run: (req, env) => handleImages(req, env) },
  '^audio/speech$': { method: 'POST', auth: true, run: (req, env) => handleTTS(req, env) },
  '^audio/transcriptions$': { method: 'POST', auth: true, run: (req, env) => handleSTT(req, env) },
  '^embeddings$': { method: 'POST', auth: true, run: (req, env) => handleEmbeddings(req, env) },
};

const ROUTE_TABLE = Object.entries(ROUTES).map(([pattern, r]) => ({ pattern: new RegExp(pattern), ...r }));

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return request.method === 'GET' ? handleHome(url.host) : fail(405, '/ 只支持 GET');
  }
  if (url.pathname === '/health') {
    if (request.method !== 'GET') return fail(405, '/health 只支持 GET');
    return json({ status: 'ok', models: ALL_MODELS.length, api_key_configured: Boolean(env.API_KEY) });
  }
  if (!url.pathname.startsWith('/v1/')) return fail(404, 'Not Found', 'not_found');

  const path = url.pathname.slice('/v1/'.length);
  for (const route of ROUTE_TABLE) {
    const m = path.match(route.pattern);
    if (!m) continue;
    if (request.method !== route.method) {
      return fail(405, `${url.pathname} 只支持 ${route.method}`, 'invalid_request_error');
    }
    if (route.auth) {
      const denied = await checkAuth(request, env);
      if (denied) return denied;
    }
    return route.run(request, env, m);
  }
  return fail(404, 'Not Found', 'not_found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env, request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const known = e instanceof ApiError;
      const message = e instanceof Error ? e.message : String(e);
      if (!known) console.error('unhandled error:', message);
      return json(
        {
          error: {
            message: known ? message : `Workers AI 调用失败: ${message}`,
            type: known ? e.type : 'upstream_error',
            param: null,
            code: null,
          },
        },
        known ? e.status : 502,
        cors,
      );
    }
  },
};
