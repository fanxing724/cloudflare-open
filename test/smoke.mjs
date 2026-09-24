/**
 * 离线冒烟测试：用打桩的 AI binding 验证路由、鉴权与「按模型裁剪入参」的映射。
 * 不需要 Cloudflare 账号，也不发真实请求。
 *
 *   npm test
 */
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(mkdtempSync(join(tmpdir(), 'aigw-')), 'worker.mjs');
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: out,
  logLevel: 'silent',
});
const worker = (await import(out)).default;

const KEY = 'test-key';
const sseStream = (chunks) =>
  new ReadableStream({ start(c) { for (const t of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: t })}\n\n`)); c.close(); } });

let calls = [];
const env = {
  API_KEY: KEY,
  ALLOW_ORIGIN: '',
  AI: {
    run(model, input) {
      calls.push({ model, input });
      // gpt-oss-120b 故意不支持流式：即使 stream=true 也只返回普通对象，用来验证降级分支
      if (input.stream === true && model !== '@cf/openai/gpt-oss-120b') return Promise.resolve(sseStream(['你', '好']));
      if (model.includes('whisper')) return Promise.resolve({ text: '你好世界' });
      if (model.includes('bge-m3') || model.includes('bge-small')) return Promise.resolve({ data: [[0.1, 0.2]] });
      if (model.includes('melotts') || model.includes('aura')) return Promise.resolve(new Response('AAAA').body);
      if (model.includes('flux') || model.includes('stable-diffusion') || model.includes('leonardo') || model.includes('dreamshaper')) {
        return Promise.resolve({ image: 'SUJJ' });
      }
      return Promise.resolve({ response: 'ok', usage: { input_tokens: 3, output_tokens: 4 } });
    },
  },
};

let pass = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail === undefined ? '' : `  → 实际 ${JSON.stringify(detail)}`}`);
  }
}

function req(path, init = {}, keyed = true) {
  const headers = new Headers(init.headers || {});
  if (keyed) headers.set('Authorization', `Bearer ${KEY}`);
  return new Request(`https://gw.example.com${path}`, { ...init, headers });
}

async function call(path, init, keyed) {
  calls = [];
  return worker.fetch(req(path, init, keyed), env);
}

const jbody = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const last = () => calls[calls.length - 1];

// ---- 路由与鉴权 ----
{
  const res = await call('/', { method: 'GET' }, false);
  check('GET / 返回文档页', res.status === 200 && (await res.text()).includes('AI Gateway'));

  const health = await call('/health', { method: 'GET' }, false);
  check('GET /health 免鉴权', health.status === 200 && (await health.json()).api_key_configured === true);

  const preflight = await call('/v1/models', { method: 'OPTIONS' }, false);
  check('OPTIONS 预检 204 + CORS', preflight.status === 204 && preflight.headers.get('Access-Control-Allow-Origin') === '*');

  const noKey = await call('/v1/models', { method: 'GET' }, false);
  check('缺 key → 401', noKey.status === 401);
  const badKey = await call('/v1/models', {}, false);
  check('错 key → 401', badKey.status === 401);

  const models = await call('/v1/models', { method: 'GET' });
  const list = (await models.json()).data;
  check('GET /v1/models 全量带 @cf/ 前缀', list.length > 40 && list.every((m) => m.id.startsWith('@cf/')), list.length);
  check('模型列表无重复', new Set(list.map((m) => m.id)).size === list.length);

  const one = await call('/v1/models/gpt-oss-120b', { method: 'GET' });
  check('短名查单个模型', one.status === 200 && (await one.json()).id === '@cf/openai/gpt-oss-120b');

  const wrongMethod = await call('/v1/chat/completions', { method: 'GET' });
  check('方法不匹配 → 405', wrongMethod.status === 405);
  const missing = await call('/v1/nope', { method: 'POST' });
  check('未知端点 → 404', missing.status === 404);

  const noSecret = await worker.fetch(req('/v1/models', { method: 'GET' }), { AI: env.AI });
  check('未配 API_KEY → 500 且提示配置', noSecret.status === 500 && (await noSecret.json()).error.message.includes('secret put'));
}

// ---- chat ----
{
  await call('/v1/chat/completions', jbody({
    model: 'gpt-oss-120b',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.3,
    top_p: 0.9,
    tools: [{ type: 'function' }],
    user: 'should-be-dropped',
  }));
  const { model, input } = last();
  check('短名解析为完整模型 ID', model === '@cf/openai/gpt-oss-120b', model);
  check('非流式也透传 top_p/tools', input.top_p === 0.9 && input.tools !== undefined);
  check('OpenAI 独有字段被丢弃', input.user === undefined && input.stream === undefined);
  check('未传 messages 之外的 model 字段不透传', input.model === undefined);

  const chatRes = await call('/v1/chat/completions', jbody({ model: 'gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }] }));
  const cb = await chatRes.json();
  check('content 取上游 response 字段', cb.choices[0].message.content === 'ok', cb.choices);
  check('usage 按 input/output 汇总总数', cb.usage.prompt_tokens === 3 && cb.usage.completion_tokens === 4 && cb.usage.total_tokens === 7, cb.usage);

  const unknown = await call('/v1/chat/completions', jbody({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }));
  check('未知模型 → 400', unknown.status === 400);

  const empty = await call('/v1/chat/completions', jbody({ model: 'gpt-oss-20b', messages: [] }));
  check('空 messages → 400', empty.status === 400);

  await call('/v1/chat/completions', jbody({
    model: 'llama-3.2-11b-vision-instruct',
    messages: [{ role: 'user', content: [{ type: 'text', text: '这是啥' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }],
  }));
  const vision = last().input.messages[0];
  check('视觉输入转成 CF 的 image 字段', vision.image === 'data:image/png;base64,AA' && vision.content === '这是啥', vision);

  const twoImages = await call('/v1/chat/completions', jbody({
    model: 'llava-1.5-7b-hf',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'a' } }, { type: 'image_url', image_url: { url: 'b' } }] }],
  }));
  check('多图 → 明确 400', twoImages.status === 400 && (await twoImages.json()).error.message.includes('一张'));

  const res = await call('/v1/chat/completions', jbody({ model: 'gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], stream: true }));
  check('流式响应头为 SSE', res.headers.get('Content-Type') === 'text/event-stream');
  check('流式透传 stream=true', last().input.stream === true);
  const text = await new Response(res.body).text();
  const events = text.trim().split('\n\n').filter((l) => l.startsWith('data:'));
  const parsed = events.filter((e) => !e.includes('[DONE]')).map((e) => JSON.parse(e.slice(5)));
  check('首块带 role', parsed[0].choices[0].delta.role === 'assistant', parsed[0]);
  check('逐 token 增量', parsed.filter((p) => p.choices[0].delta.content).map((p) => p.choices[0].delta.content).join('') === '你好', parsed);
  check('末块 finish_reason=stop', parsed.at(-1).choices[0].finish_reason === 'stop');
  check('以 [DONE] 收尾', events.at(-1) === 'data: [DONE]');
  check('同一次流式 id/created 一致', new Set(parsed.map((p) => p.id)).size === 1);

  const degraded = await call('/v1/chat/completions', jbody({ model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], stream: true }));
  const dText = await new Response(degraded.body).text();
  check('模型不支持流式时降级为单块而非崩溃', dText.includes('"content":"ok"') && dText.includes('[DONE]'), dText);
}

// ---- 文生图 ----
{
  await call('/v1/images/generations', jbody({ model: 'flux-1-schnell', prompt: 'cat', num_steps: 6 }));
  check('flux 的 num_steps 映射为 steps', last().input.steps === 6 && last().input.num_steps === undefined, last().input);

  const badFlux = await call('/v1/images/generations', jbody({ model: 'flux-1-schnell', prompt: 'cat', width: 512 }));
  check('flux 传 width 明确报错而非静默忽略', badFlux.status === 400 && (await badFlux.json()).error.message.includes('width'));

  await call('/v1/images/generations', jbody({ model: 'stable-diffusion-xl-base-1.0', prompt: 'cat', size: '768x1024', n: 3 }));
  check('size 解析为 width/height', last().input.width === 768 && last().input.height === 1024, last().input);
  const res = await call('/v1/images/generations', jbody({ model: 'stable-diffusion-xl-base-1.0', prompt: 'cat', n: 3 }));
  check('n=3 并发出 3 张', calls.length === 3 && (await res.json()).data.length === 3);

  const badN = await call('/v1/images/generations', jbody({ model: 'flux-1-schnell', prompt: 'cat', n: 'abc' }));
  check('n 非法时回退 1 而非空数组', badN.status === 200 && (await badN.json()).data.length === 1);

  const noPrompt = await call('/v1/images/generations', jbody({ model: 'flux-1-schnell' }));
  check('缺 prompt → 400', noPrompt.status === 400);

  const badFmt = await call('/v1/images/generations', jbody({ model: 'flux-1-schnell', prompt: 'cat', response_format: 'url' }));
  check('response_format=url 明确拒绝', badFmt.status === 400);
}

// ---- TTS ----
{
  await call('/v1/audio/speech', jbody({ model: 'aura-1', input: 'hello', voice: 'luna', response_format: 'wav' }));
  const aura = last().input;
  check('aura 用 text + speaker，不再发明 lang 字段', aura.text === 'hello' && aura.speaker === 'luna' && aura.lang === undefined, aura);
  check('response_format 映射到 encoding/container', aura.encoding === 'linear16' && aura.container === 'wav');

  await call('/v1/audio/speech', jbody({ model: 'melotts', input: '你好', voice: 'zh' }));
  check('melotts 用 prompt + lang', last().input.prompt === '你好' && last().input.lang === 'zh');

  const res = await call('/v1/audio/speech', jbody({ model: 'aura-1', input: 'hi' }));
  check('TTS 返回音频且默认 mp3', res.status === 200 && res.headers.get('Content-Type') === 'audio/mpeg');
  const empty = await call('/v1/audio/speech', jbody({ model: 'aura-1', input: '' }));
  check('空 input → 400', empty.status === 400);
}

// ---- STT ----
{
  const mp3 = new Uint8Array([1, 2, 3, 250]);
  const form = new FormData();
  form.set('file', new Blob([mp3], { type: 'audio/mpeg' }), 'a.mp3');
  form.set('model', 'whisper-large-v3-turbo');
  await call('/v1/audio/transcriptions', { method: 'POST', body: form });
  check('默认走 base64 形态，mp3 直传', typeof last().input.audio === 'string' && last().model === '@cf/openai/whisper-large-v3-turbo');

  const form2 = new FormData();
  form2.set('file', new Blob([mp3], { type: 'audio/wav' }), 'a.wav');
  form2.set('model', 'whisper');
  await call('/v1/audio/transcriptions', { method: 'POST', body: form2 });
  const bytes = last().input.audio;
  check('老 whisper 走 0-255 字节数组', Array.isArray(bytes) && bytes.length === 4 && bytes[3] === 250, bytes);

  await call('/v1/audio/transcriptions', jbody({ model: 'whisper-tiny-en', audio: [0, 1, 2], language: 'zh', response_format: 'text' }));
  const res = await call('/v1/audio/transcriptions', jbody({ model: 'whisper-tiny-en', audio: [0, 1, 2], language: 'zh', response_format: 'text' }));
  check('采样数组原样透传', JSON.stringify(last().input.audio) === '[0,1,2]' && last().input.language === 'zh');
  check('response_format=text 返回纯文本', res.status === 200 && (await res.text()) === '你好世界');

  const missing = await call('/v1/audio/transcriptions', jbody({ model: 'whisper' }));
  check('无音频 → 400 且提示用法', missing.status === 400 && (await missing.json()).error.message.includes('file'));

  const badB64 = await call('/v1/audio/transcriptions', jbody({ model: 'whisper', audio: '!!!not-base64!!!' }));
  check('坏 base64 → 400 而不是 502', badB64.status === 400 && (await badB64.json()).error.message.includes('base64'));
}

// ---- Embeddings ----
{
  await call('/v1/embeddings', jbody({ model: 'bge-m3', input: ['你好', 'hello'] }));
  check('bge-m3 用 contexts（不再是 text）', JSON.stringify(last().input) === '{"contexts":["你好","hello"]}', last().input);

  await call('/v1/embeddings', jbody({ model: 'bge-small-en-v1.5', input: 'hi' }));
  check('其余向量模型用 text', JSON.stringify(last().input) === '{"text":["hi"]}');

  const res = await call('/v1/embeddings', jbody({ model: 'bge-m3', input: ['a'] }));
  const body = await res.json();
  check('返回 OpenAI 向量格式', body.data[0].embedding[0] === 0.1 && body.data[0].index === 0);
}

// ---- 上游异常 ----
{
  const broken = { ...env, AI: { run: () => Promise.reject(new Error('403 forbidden by plan')) } };
  const res = await worker.fetch(req('/v1/chat/completions', jbody({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] })), broken);
  const body = await res.json();
  check('上游失败 → 502 且带原因', res.status === 502 && body.error.message.includes('403'), body);
  check('错误响应也带 CORS 头', res.headers.get('Access-Control-Allow-Origin') === '*');

  const badJson = await call('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  check('请求体坏 JSON → 400 而非 500', badJson.status === 400);
}

console.log(`\n${failed ? '❌' : '✅'} ${pass} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
