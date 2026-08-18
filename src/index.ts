/**
 * AI Gateway — Cloudflare Workers AI 的 OpenAI 兼容 API 接口
 *
 * 支持的端点：
 *  - POST /v1/chat/completions        对话（含流式 SSE）
 *  - GET  /v1/models                  模型列表（chat / image / tts / stt / embedding）
 *  - POST /v1/images/generations      文生图
 *  - POST /v1/audio/speech            文本转语音（TTS）
 *  - POST /v1/audio/transcriptions    语音转文字（STT）
 *  - POST /v1/embeddings              向量化
 *
 * 绑定：AI（Workers AI）、API_KEY（secret 鉴权）
 */

interface Env {
  AI: any;
  API_KEY: string;
}

// ---------- 模型清单（Workers AI 当前可用，按 Free plan 实测） ----------
const CHAT_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/qwen/qwq-32b',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/ibm-granite/granite-4.0-h-micro',
  '@cf/mistral/mistral-7b-instruct-v0.2-lora',
  '@cf/google/gemma-7b-it-lora',
  '@cf/google/gemma-2b-it-lora',
  '@cf/meta-llama/llama-2-7b-chat-hf-lora',
];

const IMAGE_MODELS = [
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/leonardo/lucid-origin',
  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  '@cf/bytedance/stable-diffusion-xl-lightning',
  '@cf/lykon/dreamshaper-8-lcm',
  '@cf/leonardo/phoenix-1.0',
];

const TTS_MODELS = [
  '@cf/deepgram/aura-1',
  '@cf/deepgram/aura-2-en',
  '@cf/deepgram/aura-2-es',
  '@cf/myshell-ai/melotts',
];

const STT_MODELS = [
  '@cf/openai/whisper',
  '@cf/openai/whisper-large-v3-turbo',
  '@cf/openai/whisper-tiny-en',
  '@cf/deepgram/flux',
  '@cf/deepgram/nova-3',
];

const EMBEDDING_MODELS = [
  '@cf/baai/bge-m3',
  '@cf/qwen/qwen3-embedding-0.6b',
  '@cf/pfnet/plamo-embedding-1b',
  '@cf/baai/bge-small-en-v1.5',
  '@cf/baai/bge-base-en-v1.5',
  '@cf/google/embeddinggemma-300m',
  '@cf/baai/bge-large-en-v1.5',
];

const DEFAULT_CHAT = '@cf/meta/llama-3.2-3b-instruct';
const DEFAULT_IMG = '@cf/black-forest-labs/flux-1-schnell';
const DEFAULT_TTS = '@cf/deepgram/aura-1';
const DEFAULT_STT = '@cf/openai/whisper';
const DEFAULT_EMB = '@cf/baai/bge-m3';

// ---------- 工具 ----------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkAuth(request: Request, env: Env): { ok: true } | { ok: false; res: Response } {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token || !env.API_KEY || token !== env.API_KEY) {
    return {
      ok: false,
      res: json(
        { error: { message: 'Invalid or missing API key', type: 'invalid_request_error', param: null, code: null } },
        401,
      ),
    };
  }
  return { ok: true };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 把图片类返回（ReadableStream 二进制 / {image:base64} / base64 字符串）统一成 base64
async function imageToBase64(raw: any): Promise<string> {
  if (raw instanceof ReadableStream) return bytesToBase64(await collectStream(raw));
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.image === 'string') return raw.image;
  if (raw && raw.response && typeof raw.response === 'string') return raw.response;
  if (raw instanceof Uint8Array) return bytesToBase64(raw);
  return '';
}

// ---------- Chat ----------
async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as any;
  const model = body.model || DEFAULT_CHAT;
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const stream = body.stream === true;

  const options: Record<string, unknown> = { messages, stream };
  if (body.max_tokens) options.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.top_p !== undefined) options.top_p = body.top_p;

  try {
    if (stream) {
      const aiStream = (await env.AI.run(model, options)) as ReadableStream<Uint8Array>;
      const reader = aiStream.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const rs = new ReadableStream<Uint8Array>({
        async start(controller) {
          let buffer = '';
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
                try {
                  const chunk = JSON.parse(data);
                  const content = chunk.response ?? chunk.delta ?? '';
                  if (content) {
                    const sse = `data: ${JSON.stringify({
                      id: 'chatcmpl-stream',
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [{ index: 0, delta: { content }, finish_reason: null }],
                    })}\n\n`;
                    controller.enqueue(encoder.encode(sse));
                  }
                } catch {
                  /* ignore non-JSON line */
                }
              }
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch (e) {
            console.error('stream error', e);
          } finally {
            reader.releaseLock();
          }
          controller.close();
        },
      });

      return new Response(rs, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const res: any = await env.AI.run(model, { messages, ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}) });
    const content = typeof res?.response === 'string' ? res.response : JSON.stringify(res);
    const usage = res?.usage || {};
    return json({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      },
    });
  } catch (e: any) {
    return json({ error: { message: `Workers AI 调用失败: ${e?.message || e}`, type: 'upstream_error' } }, 502);
  }
}

// ---------- 文生图 ----------
async function handleImages(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'invalid json body', type: 'invalid_request_error' } }, 400);
  }
  const model = body.model || DEFAULT_IMG;
  const prompt = (body.prompt || '').toString();
  if (!prompt) return json({ error: { message: 'prompt is required', type: 'invalid_request_error' } }, 400);
  const n = Math.min(Math.max(1, body.n || 1), 4);

  const opts: Record<string, unknown> = { prompt };
  if (body.num_steps) opts.num_steps = body.num_steps;
  if (body.guidance !== undefined) opts.guidance = body.guidance;
  if (body.width) opts.width = body.width;
  if (body.height) opts.height = body.height;
  if (body.seed !== undefined) opts.seed = body.seed;

  try {
    const data: any[] = [];
    for (let i = 0; i < n; i++) {
      const raw = await env.AI.run(model, opts);
      const b64 = await imageToBase64(raw);
      data.push({ b64_json: b64 });
    }
    return json({ created: Math.floor(Date.now() / 1000), data });
  } catch (e: any) {
    return json({ error: { message: `图片生成失败: ${e?.message || e}`, type: 'upstream_error' } }, 502);
  }
}

// ---------- TTS ----------
async function handleTTS(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'invalid json body', type: 'invalid_request_error' } }, 400);
  }
  const model = body.model || DEFAULT_TTS;
  const text = (body.input || '').toString();
  if (!text) return json({ error: { message: 'input is required', type: 'invalid_request_error' } }, 400);
  const voice = body.voice || 'en';

  // melotts 用 prompt/lang，deepgram aura 用 text
  const opts = model.includes('melotts')
    ? { prompt: text, lang: voice }
    : { text, lang: voice };

  try {
    const raw = await env.AI.run(model, opts);
    if (raw instanceof ReadableStream) {
      return new Response(raw, { headers: { 'Content-Type': 'audio/mpeg' } });
    }
    if (typeof raw === 'string') {
      const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } });
    }
    if (raw && typeof raw.audio === 'string') {
      const bytes = Uint8Array.from(atob(raw.audio), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } });
    }
    return new Response(raw, { headers: { 'Content-Type': 'audio/mpeg' } });
  } catch (e: any) {
    return json({ error: { message: `TTS 失败: ${e?.message || e}`, type: 'upstream_error' } }, 502);
  }
}

// ---------- STT ----------
// 简单 WAV(PCM16) 解码成 16k float 数组（whisper 需要）
function wavBytesToFloat(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 找 "data" chunk
  let offset = 12;
  let dataLen = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataLen = size;
      offset += 8;
      break;
    }
    offset += 8 + size;
  }
  const samples: number[] = [];
  const bytesPerSample = bits / 8;
  for (let i = offset; i + bytesPerSample <= offset + dataLen; i += bytesPerSample) {
    let s = 0;
    if (bits === 16) s = view.getInt16(i, true);
    else if (bits === 8) s = (bytes[i] - 128) * 256;
    samples.push(s / 32768);
  }
  return samples;
}

async function handleSTT(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get('Content-Type') || '';
  let model = DEFAULT_STT;
  let audio: number[] | undefined;

  try {
    if (ct.includes('multipart/form-data')) {
      const form = await request.formData();
      const m = form.get('model');
      if (m) model = m.toString();
      const file = form.get('file');
      if (file && typeof file === 'object' && 'arrayBuffer' in file) {
        const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
        audio = wavBytesToFloat(bytes);
      }
    } else {
      const body = (await request.json()) as any;
      if (body.model) model = body.model;
      if (Array.isArray(body.audio)) audio = body.audio;
      else if (typeof body.audio === 'string') audio = wavBytesToFloat(Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0)));
    }
  } catch (e: any) {
    return json({ error: { message: `请求解析失败: ${e?.message || e}`, type: 'invalid_request_error' } }, 400);
  }

  if (!audio || audio.length === 0) {
    return json({ error: { message: 'audio is required（float 数组或 wav/base64）', type: 'invalid_request_error' } }, 400);
  }

  try {
    const res: any = await env.AI.run(model, { audio });
    return json({ text: res?.text || '' });
  } catch (e: any) {
    return json({ error: { message: `STT 失败: ${e?.message || e}`, type: 'upstream_error' } }, 502);
  }
}

// ---------- Embeddings ----------
async function handleEmbeddings(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as any;
  const model = body.model || DEFAULT_EMB;
  const inputs: string[] = Array.isArray(body.input)
    ? body.input.map((x: any) => (typeof x === 'string' ? x : x?.content || ''))
    : [typeof body.input === 'string' ? body.input : ''];

  try {
    const res: any = await env.AI.run(model, { text: inputs });
    const data = (res?.data ?? []).map((v: number[], i: number) => ({
      object: 'embedding',
      index: i,
      embedding: v,
    }));
    return json({ object: 'list', model, data, usage: { prompt_tokens: 0, total_tokens: 0 } });
  } catch (e: any) {
    return json({ error: { message: `Embedding 调用失败: ${e?.message || e}`, type: 'upstream_error' } }, 502);
  }
}

// ---------- Models ----------
function makeModel(id: string, owned_by: string) {
  return { id, object: 'model', created: 0, owned_by };
}

function handleModels(): Response {
  const data = [
    ...CHAT_MODELS.map((m) => makeModel(m, 'cloudflare-text')),
    ...IMAGE_MODELS.map((m) => makeModel(m, 'cloudflare-image')),
    ...TTS_MODELS.map((m) => makeModel(m, 'cloudflare-tts')),
    ...STT_MODELS.map((m) => makeModel(m, 'cloudflare-stt')),
    ...EMBEDDING_MODELS.map((m) => makeModel(m, 'cloudflare-embedding')),
  ];
  return json({ object: 'list', data });
}

// ---------- Home（在线 API 文档） ----------
function handleHome(): Response {
  const li = (arr: string[]) => arr.map((m) => `<li><code>${m}</code></li>`).join('');
  const total = CHAT_MODELS.length + IMAGE_MODELS.length + TTS_MODELS.length + STT_MODELS.length + EMBEDDING_MODELS.length;

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
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin:12px 0}
.endpoint{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin:16px 0}
.method{display:inline-block;font-weight:700;font-size:12px;padding:2px 10px;border-radius:6px;margin-right:8px;color:#fff}
.get{background:#059669}.post{background:#2563eb}
.path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:15px;font-weight:600}
.desc{color:var(--muted);font-size:13px;margin:6px 0 12px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}
th,td{border:1px solid var(--border);padding:8px 10px;text-align:left}
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
    <span class="badge">共 ${total} 个模型</span>
    <span class="badge">OpenAI 兼容</span>
  </div>
</header>

<h2>快速开始</h2>
<div class="card">
  <p><strong>Base URL：</strong><code>https://api.hakimi.de5.net</code>（换成你的自定义域名或 workers.dev 地址）</p>
  <p><strong>鉴权：</strong>所有 <code>/v1/*</code> 接口都需要请求头 <code>Authorization: Bearer &lt;你的 API_KEY&gt;</code></p>
  <p>验证是否可用：</p>
  <pre>curl https://api.hakimi.de5.net/v1/models -H "Authorization: Bearer YOUR_KEY"</pre>
</div>

<h2>接口文档</h2>

<div class="endpoint">
  <span class="method get">GET</span><span class="path">/v1/models</span>
  <p class="desc">列出全部可用模型（对话 / 文生图 / TTS / STT / 向量）。</p>
  <pre>curl https://api.hakimi.de5.net/v1/models -H "Authorization: Bearer YOUR_KEY"</pre>
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/chat/completions</span>
  <p class="desc">对话补全，兼容 OpenAI 格式，支持流式 <code>stream</code>。</p>
  <table>
    <tr><th>参数</th><th>说明</th></tr>
    <tr><td>model</td><td>模型 ID，默认 <code>@cf/meta/llama-3.2-3b-instruct</code></td></tr>
    <tr><td>messages</td><td>对话数组 <code>[{"role":"user","content":"..."}]</code></td></tr>
    <tr><td>stream</td><td>true 时返回 SSE 流式</td></tr>
    <tr><td>max_tokens / temperature / top_p</td><td>可选生成参数</td></tr>
  </table>
  <pre>curl https://api.hakimi.de5.net/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"@cf/meta/llama-3.2-3b-instruct","messages":[{"role":"user","content":"你好"}]}'</pre>
  <p>流式：加 <code>"stream":true</code> 即可。</p>
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/images/generations</span>
  <p class="desc">文生图，返回 OpenAI images 格式（<code>data[].b64_json</code>）。</p>
  <table>
    <tr><th>参数</th><th>说明</th></tr>
    <tr><td>model</td><td>图片模型，默认 <code>@cf/black-forest-labs/flux-1-schnell</code></td></tr>
    <tr><td>prompt</td><td>图片描述（必填）</td></tr>
    <tr><td>n</td><td>生成张数，1~4</td></tr>
    <tr><td>num_steps / guidance / width / height / seed</td><td>可选生成参数</td></tr>
  </table>
  <pre>curl https://api.hakimi.de5.net/v1/images/generations \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"@cf/black-forest-labs/flux-1-schnell","prompt":"a cute cat","n":1}'</pre>
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/audio/speech</span>
  <p class="desc">文本转语音（TTS），返回音频（audio/mpeg）。</p>
  <table>
    <tr><th>参数</th><th>说明</th></tr>
    <tr><td>model</td><td>TTS 模型，默认 <code>@cf/deepgram/aura-1</code></td></tr>
    <tr><td>input</td><td>要合成的文本（必填）</td></tr>
    <tr><td>voice</td><td>语言/音色，如 <code>zh</code> <code>en</code></td></tr>
  </table>
  <pre>curl https://api.hakimi.de5.net/v1/audio/speech \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"@cf/deepgram/aura-1","input":"你好世界","voice":"zh"}' -o out.mp3</pre>
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/audio/transcriptions</span>
  <p class="desc">语音转文字（STT）。支持 JSON（<code>audio</code> 为 float 数组或 wav 的 base64）或 multipart 上传 wav 文件。</p>
  <table>
    <tr><th>参数</th><th>说明</th></tr>
    <tr><td>model</td><td>STT 模型，默认 <code>@cf/openai/whisper</code></td></tr>
    <tr><td>audio</td><td>float 数组（16k PCM）或 wav 文件 base64</td></tr>
    <tr><td>file</td><td>multipart 上传 wav 文件</td></tr>
  </table>
  <pre>curl https://api.hakimi.de5.net/v1/audio/transcriptions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"@cf/openai/whisper","audio":[0.0,0.01,0.02]}'</pre>
</div>

<div class="endpoint">
  <span class="method post">POST</span><span class="path">/v1/embeddings</span>
  <p class="desc">文本向量化，返回 OpenAI embeddings 格式。</p>
  <pre>curl https://api.hakimi.de5.net/v1/embeddings \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"@cf/baai/bge-m3","input":["你好","hello"]}'</pre>
</div>

<h2>模型清单（${total} 个）</h2>

<h3>对话模型（${CHAT_MODELS.length}）</h3>
<ul class="models">${li(CHAT_MODELS)}</ul>

<h3>文生图模型（${IMAGE_MODELS.length}）</h3>
<ul class="models">${li(IMAGE_MODELS)}</ul>

<h3>TTS 语音合成（${TTS_MODELS.length}）</h3>
<ul class="models">${li(TTS_MODELS)}</ul>

<h3>STT 语音转文字（${STT_MODELS.length}）</h3>
<ul class="models">${li(STT_MODELS)}</ul>

<h3>向量模型（${EMBEDDING_MODELS.length}）</h3>
<ul class="models">${li(EMBEDDING_MODELS)}</ul>

<h2>接入聊天客户端</h2>
<div class="card">
  <p>任选一个 OpenAI 兼容客户端，填：</p>
  <table>
    <tr><th>字段</th><th>值</th></tr>
    <tr><td>API 地址 / Base URL</td><td><code>https://api.hakimi.de5.net</code></td></tr>
    <tr><td>API Key</td><td><code>你的 API_KEY</code></td></tr>
  </table>
  <p>支持 Cherry Studio、LobeChat、Open WebUI、opencode、ChatBox 等，填完自动拉取模型列表。</p>
</div>

<div class="note">
  <strong>注意：</strong>Workers AI 免费套餐不提供 Kimi K2、DeepSeek-v4、GLM-5 等模型；视频生成暂不支持（Cloudflare 无视频模型）。图片/TTS 接口需要客户端具备对应能力。
</div>

<footer>AI Gateway · 基于 Cloudflare Workers AI · 源码见 GitHub 仓库</footer>
</div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------- 路由 ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/v1/')) {
      const auth = checkAuth(request, env);
      if (!auth.ok) return auth.res;
    }

    if (request.method === 'GET' && path === '/') return handleHome();
    if (request.method === 'GET' && path === '/v1/models') return handleModels();
    if (request.method === 'POST' && path === '/v1/chat/completions') return handleChat(request, env);
    if (request.method === 'POST' && path === '/v1/images/generations') return handleImages(request, env);
    if (request.method === 'POST' && path === '/v1/audio/speech') return handleTTS(request, env);
    if (request.method === 'POST' && path === '/v1/audio/transcriptions') return handleSTT(request, env);
    if (request.method === 'POST' && path === '/v1/embeddings') return handleEmbeddings(request, env);

    return json({ error: { message: 'Not Found', type: 'not_found' } }, 404);
  },
};
