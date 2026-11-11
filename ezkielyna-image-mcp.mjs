#!/usr/bin/env node
// Ezkielyna Image MCP: create and edit images through the Ezkielyna API gateway from OpenCode,
// Claude Desktop, Claude Code, Cursor and other MCP clients. One file, no dependencies, Node >= 18. MCP over stdio (newline-delimited JSON-RPC).
// Logs go to stderr only; stdout carries protocol messages. The API key is never printed.
//
// Env:
//   EZKIELYNA_API_KEY      required, a key in gateway group "Media"
//   EZKIELYNA_BASE_URL     default https://api.ezkielyna.store/v1
//   EZKIELYNA_IMAGE_DIR    where results are saved, default ~/Pictures/Ezkielyna (created if missing)
//   EZKIELYNA_MAX_IMAGES   paid calls allowed per session (per MCP process), default 30
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.2';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const TOPUP_URL = 'https://ezkielyna.store';

// Models that take reference images, how they take them, and how many. "edits" = multipart /images/edits
// (field image for one, image[] repeated for several); "chat" = /chat/completions with image_url data URLs.
// Change the limits here when a live test says otherwise.
const EDIT_MODELS = {
  'gpt-image-2.5': { via: 'edits', max: 4 },
  'nano-banana-pro': { via: 'chat', max: 4 },
};
const DEFAULT_MODEL = 'gpt-image-2.5';

const INPUT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 60 * 1024 * 1024;
const INLINE_MAX_BYTES = 3.5 * 1024 * 1024;
// api.ezkielyna.store accepts request bodies up to 32 MB (nginx); keep room for the form/JSON around the images.
const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const TOO_BIG = 'Total gambar terlalu besar (maks ±30 MB per permintaan, untuk nano-banana-pro ±22 MB karena base64). '
  + 'Kecilkan/kompres foto (mis. 2000 px JPEG) lalu coba lagi. / The images are too large in total (max ~30 MB per request, '
  + '~22 MB for nano-banana-pro because of base64): resize or compress them (e.g. 2000 px JPEG) and try again.';
const PRICING_TTL_MS = 10 * 60 * 1000;

const env = process.env;
const API_KEY = (env.EZKIELYNA_API_KEY || '').trim();
const BASE_URL = (env.EZKIELYNA_BASE_URL || 'https://api.ezkielyna.store/v1').trim().replace(/\/+$/, '');
const IMAGE_DIR = path.resolve(expandHome(env.EZKIELYNA_IMAGE_DIR || path.join(os.homedir(), 'Pictures', 'Ezkielyna')));
const MAX_IMAGES = positiveInt(env.EZKIELYNA_MAX_IMAGES, 30);
const TIMEOUT_MS = positiveInt(env.EZKIELYNA_TIMEOUT_MS, 300000);

let used = 0; // paid calls sent (or possibly charged) in this session
let pricingCache = null;

function positiveInt(v, dflt) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function expandHome(p) {
  return p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p;
}

function log(...args) {
  process.stderr.write('[ezkielyna-image] ' + args.map(a => scrub(String(a))).join(' ') + '\n');
}

// Removes the key (and anything that looks like an API key) from text shown to the user or the log.
function scrub(text) {
  let t = String(text);
  if (API_KEY) t = t.split(API_KEY).join('sk-***');
  return t.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

class ToolError extends Error {}

// ---------- tools ----------

const TOOLS = [
  {
    name: 'generate_image',
    title: 'Buat gambar / Generate image',
    description: 'Membuat gambar baru dari teks dan menyimpannya di komputer. Creates a new image from a text prompt with the Ezkielyna API and saves it locally. '
      + 'Returns the saved file path (use it in edit_image to keep editing). Every call is paid (see list_image_models for prices).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image should show.' },
        model: { type: 'string', description: `Image model id (default ${DEFAULT_MODEL}). See list_image_models.`, default: DEFAULT_MODEL },
        size: { type: 'string', description: 'Optional size, e.g. 1024x1024, 1536x1024, 1024x1536. Leave empty for the model default.' },
        filename: { type: 'string', description: 'Optional file name (no folder). The extension is set from the image type; existing files are never overwritten.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    title: 'Edit gambar / Edit image',
    description: 'Mengedit gambar dari file lokal atau link https (misalnya tambah logo, ganti latar). Edits or combines 1-4 reference images (local paths or https URLs) '
      + 'following the prompt and saves the result locally. To keep editing, pass the previous result path again. '
      + `Models: ${Object.entries(EDIT_MODELS).map(([m, c]) => `${m} (max ${c.max})`).join(', ')}. Every call is paid.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The change to make, e.g. "Put the logo from the second image on the mug in the first image".' },
        images: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4, description: 'Absolute local paths (.png/.jpg/.jpeg/.webp, max 20 MB) or https URLs. Order matters: the first is the main image.' },
        model: { type: 'string', enum: Object.keys(EDIT_MODELS), default: DEFAULT_MODEL, description: `Edit model (default ${DEFAULT_MODEL}).` },
        quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'gpt-image only. Default high (most detail, same price per image).' },
        size: { type: 'string', description: 'Optional output size, e.g. 1024x1024, 1536x1024, 1024x1536. Leave empty for the model default.' },
        filename: { type: 'string', description: 'Optional file name (no folder). Existing files are never overwritten.' },
      },
      required: ['prompt', 'images'],
    },
  },
  {
    name: 'list_image_models',
    title: 'Daftar model gambar / List image models',
    description: 'Lists the image models this API key can use, the price per image, and which ones can edit reference images (and how many). Free.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  if (name === 'list_image_models') return listImageModels();
  if (name === 'generate_image') return generateImage(args);
  if (name === 'edit_image') return editImage(args);
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}

async function generateImage(args) {
  const prompt = requireText(args.prompt, 'prompt');
  const model = optText(args.model) || DEFAULT_MODEL;
  checkModelId(model);
  const payload = { model, prompt, n: 1, response_format: 'b64_json' };
  const size = optText(args.size);
  if (size) {
    if (!/^[0-9a-z:@x.-]{1,24}$/i.test(size)) throw new ToolError('Ukuran tidak valid / Invalid size. Example: 1024x1024');
    payload.size = size;
  }
  return paid(model, args.filename, async () => {
    const r = await gateway('/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return imageFromImagesApi(await r.json());
  });
}

async function editImage(args) {
  const prompt = requireText(args.prompt, 'prompt');
  const model = optText(args.model) || DEFAULT_MODEL;
  const cap = EDIT_MODELS[model];
  if (!cap) throw new ToolError(`Model ${model} belum bisa edit gambar di sini / cannot edit images here. Pilih / use: ${Object.keys(EDIT_MODELS).join(', ')}.`);
  const list = Array.isArray(args.images) ? args.images : typeof args.images === 'string' ? [args.images] : [];
  if (!list.length) throw new ToolError('Isi minimal 1 gambar / Give at least one image in "images".');
  if (list.length > cap.max) throw new ToolError(`${model} menerima maksimal ${cap.max} gambar / accepts at most ${cap.max} image(s); you gave ${list.length}.`);
  // Read and check every input before anything is sent (and before a paid slot is taken).
  const refs = [];
  for (const item of list) refs.push(await loadInput(item));
  // The chat route sends base64 (4/3 of the bytes); refuse before a paid slot is taken instead of hitting the 32 MB limit.
  const body = refs.reduce((n, x) => n + (cap.via === 'chat' ? Math.ceil(x.data.length / 3) * 4 : x.data.length), 0);
  if (body > MAX_REQUEST_BYTES) throw new ToolError(TOO_BIG);
  const quality = optText(args.quality);
  if (quality && !['low', 'medium', 'high'].includes(quality)) throw new ToolError('quality: low, medium atau high.');
  const size = optText(args.size);
  if (size && !/^[0-9a-z:@x.-]{1,24}$/i.test(size)) throw new ToolError('Ukuran tidak valid / Invalid size. Example: 1024x1024');

  return paid(model, args.filename, async () => {
    if (cap.via === 'chat') {
      const content = [{ type: 'text', text: prompt }, ...refs.map(x => ({ type: 'image_url', image_url: { url: `data:${x.mime};base64,${x.data.toString('base64')}` } }))];
      const r = await gateway('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content }] }) });
      return imageFromChat(await r.json());
    }
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('response_format', 'b64_json');
    if (size) form.append('size', size);
    // v1.0.2 (9 Nov 2026): gpt-image edits default to high quality + high input fidelity (keeps the original's detail,
    // like ChatGPT). Measured upstream: same price per image, about 4x more output detail.
    if (/^gpt-image/.test(model)) { form.append('quality', quality || 'high'); form.append('input_fidelity', 'high'); }
    // One image keeps the plain field; several go as image[] (OpenAI multi-image edit), as Studio sends them.
    refs.forEach((x, i) => form.append(refs.length > 1 ? 'image[]' : 'image', new Blob([x.data], { type: x.mime }), `reference-${i + 1}.${x.ext}`));
    const r = await gateway('/images/edits', { method: 'POST', body: form });
    return imageFromImagesApi(await r.json());
  });
}

async function listImageModels() {
  const r = await gateway('/models', { method: 'GET' });
  const ids = ((await r.json())?.data || []).map(m => m && m.id).filter(id => typeof id === 'string');
  const prices = await pricing();
  const imageIds = ids.filter(id => prices.image.has(id) || EDIT_MODELS[id] || (/image|banana|imagen|flux|seedream|ideogram|dall-e/i.test(id) && !/video/i.test(id)));
  imageIds.sort((a, b) => (EDIT_MODELS[b] ? 1 : 0) - (EDIT_MODELS[a] ? 1 : 0) || a.localeCompare(b));
  if (!imageIds.length) {
    return text(`Key ini tidak punya model gambar. Buat key grup Media di ${TOPUP_URL} / This key has no image models: create a key in group "Media".`, true);
  }
  const lines = imageIds.map(id => {
    const p = prices.byModel.get(id);
    const cap = EDIT_MODELS[id];
    return `- ${id}: ${p != null ? fmtUsd(p) + '/gambar (image)' : 'harga / price: lihat / see ' + TOPUP_URL}`
      + (cap ? ` | edit: ya / yes, max ${cap.max} gambar referensi (reference images)` : ' | edit: tidak / no (generate only)');
  });
  return text([
    'Model gambar untuk key ini / Image models for this key:',
    ...lines,
    '',
    `Default: ${DEFAULT_MODEL}. Jatah sesi / Session cap: ${used}/${MAX_IMAGES} dipakai (used).`,
    `Folder hasil / Output folder: ${IMAGE_DIR}`,
  ].join('\n'));
}

// ---------- paid-call bookkeeping ----------

// Reserves one paid slot, runs the call, saves the image. A slot is given back only when the gateway clearly
// refused the request (it refunds those); network failures after sending count, since they may have been charged.
async function paid(model, filename, run) {
  if (!API_KEY) throw new ToolError('EZKIELYNA_API_KEY belum diisi di konfigurasi MCP / is not set in the MCP config. Buat key grup Media di ' + TOPUP_URL + '.');
  if (used >= MAX_IMAGES) {
    throw new ToolError(`Batas ${MAX_IMAGES} gambar per sesi tercapai (EZKIELYNA_MAX_IMAGES). Mulai ulang MCP / aplikasi untuk lanjut. `
      + `Session limit of ${MAX_IMAGES} paid images reached; restart the MCP server (or raise EZKIELYNA_MAX_IMAGES) to continue.`);
  }
  used++;
  let img;
  try {
    img = await run();
  } catch (e) {
    if (e instanceof GatewayError) used--;
    throw e;
  }
  const saved = saveImage(img.data, filename, model);
  const price = (await pricing().catch(() => null))?.byModel.get(model);
  const out = [
    `Tersimpan / Saved: ${saved}`,
    `Model: ${model}`,
    `Harga / Price: ${price != null ? fmtUsd(price) + ' (per gambar / per image)' : 'lihat / see ' + TOPUP_URL}`,
    `Jatah sesi / Session: ${used}/${MAX_IMAGES}`,
    'Untuk edit lagi, kirim path di atas ke edit_image. / To edit again, pass the path above to edit_image.',
  ].join('\n');
  const content = [{ type: 'text', text: out }];
  if (img.data.length <= INLINE_MAX_BYTES) content.push({ type: 'image', data: img.data.toString('base64'), mimeType: img.mime });
  return { content };
}

// ---------- gateway ----------

class GatewayError extends ToolError {}

async function gateway(p, init) {
  if (!API_KEY) throw new ToolError('EZKIELYNA_API_KEY belum diisi di konfigurasi MCP / is not set in the MCP config. Buat key grup Media di ' + TOPUP_URL + '.');
  const headers = { Authorization: 'Bearer ' + API_KEY, 'User-Agent': 'ezkielyna-image-mcp/' + VERSION, ...(init.headers || {}) };
  if (init.method === 'POST') headers['Idempotency-Key'] = crypto.randomUUID();
  let r;
  try {
    r = await fetch(BASE_URL + p, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ToolError((timeout ? 'Gateway terlalu lama menjawab / Gateway timed out.' : 'Tidak bisa menghubungi gateway / Could not reach the gateway.')
      + ` (${BASE_URL}) Cek koneksi internet, lalu coba lagi. Check your connection and try again.`
      + (init.method === 'POST' ? ' Jika gambar sudah ditagih, cek riwayat pemakaian di dashboard. / If it was charged, check your usage log.' : ''));
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new GatewayError(friendlyError(r.status, body));
  }
  return r;
}

function friendlyError(status, body) {
  let msg = '';
  let code = '';
  try {
    const v = JSON.parse(body);
    const e = v && typeof v.error === 'object' ? v.error : v;
    msg = String((e && (e.message || e.msg)) || (typeof v.error === 'string' ? v.error : '') || '');
    code = String((e && (e.code || e.type)) || '');
  } catch { msg = body; }
  const all = (msg + ' ' + code).toLowerCase();
  const detail = scrub(msg).replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[.\s]+$/, '');
  if (status === 401) return 'Key API salah atau tidak aktif. Cek EZKIELYNA_API_KEY. / Wrong or inactive API key: check EZKIELYNA_API_KEY.';
  const balance = `Saldo API tidak cukup. Top up di ${TOPUP_URL} lalu coba lagi. / Insufficient API balance: top up at ${TOPUP_URL} and try again.`;
  const group = `Key ini tidak boleh memakai model ini. Buat key grup Media di ${TOPUP_URL} (menu API key) lalu pakai key itu. `
    + `/ This key's group cannot use this model: create a key in group "Media" and use it.` + (detail ? ` [${detail}]` : '');
  if (status === 402) return balance;
  if (status === 413) return TOO_BIG;
  // New API answers "no available channel for this model in group X" with 503: that is a wrong-group key, not a busy server.
  const groupText = /group|not allowed|forbidden|no available channel|分组|无权|权限|无可用渠道/.test(all);
  if (status === 429 || (status === 503 && !groupText)) return 'Server gambar sedang sibuk. Tunggu sebentar lalu coba lagi. / The image service is busy: wait a moment and retry.';
  if (/insufficient|quota|balance|额度|余额|saldo/.test(all)) return balance;
  if (status === 403 || groupText) return group;
  if (status === 404 || /model_not_found|not found|不存在/.test(all)) {
    return 'Model tidak tersedia untuk key ini. Jalankan list_image_models untuk melihat pilihan. / Model not available for this key: run list_image_models.' + (detail ? ` [${detail}]` : '');
  }
  return `Gateway error ${status}` + (detail ? `: ${detail}` : '') + '. Coba lagi nanti / Try again later.';
}

async function pricing() {
  if (pricingCache && Date.now() - pricingCache.at < PRICING_TTL_MS) return pricingCache;
  const byModel = new Map();
  const image = new Set();
  try {
    const r = await fetch(new URL(BASE_URL).origin + '/api/pricing', { signal: AbortSignal.timeout(20000) });
    const v = r.ok ? await r.json() : null;
    const ratio = Number(v?.group_ratio?.media) || 1;
    for (const m of Array.isArray(v?.data) ? v.data : []) {
      if (!m || typeof m.model_name !== 'string') continue;
      const isImage = /image/i.test(String(m.tags || '')) || (Array.isArray(m.supported_endpoint_types) && m.supported_endpoint_types.includes('image-generation'));
      if (isImage) image.add(m.model_name);
      if (m.quota_type === 1 && Number(m.model_price) > 0) byModel.set(m.model_name, Number(m.model_price) * ratio);
    }
    pricingCache = { at: Date.now(), byModel, image };
  } catch (e) {
    log('pricing unavailable:', e && e.message);
    return pricingCache || { at: 0, byModel, image };
  }
  return pricingCache;
}

function fmtUsd(n) {
  return '$' + Number(n.toPrecision(3)).toString();
}

// ---------- images in / out ----------

function sniff(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

async function loadInput(item) {
  const ref = optText(item);
  if (!ref) throw new ToolError('Path gambar kosong / Empty image path.');
  let data;
  if (/^https?:\/\//i.test(ref)) {
    if (!/^https:\/\//i.test(ref)) throw new ToolError(`Hanya link https yang diterima / Only https links are accepted: ${ref}`);
    data = await download(ref, MAX_INPUT_BYTES, 'input');
  } else {
    if (/^data:/i.test(ref)) throw new ToolError('Kirim path file atau link https, bukan data URL. / Pass a file path or https URL, not a data URL.');
    let p = path.resolve(expandHome(ref.startsWith('file://') ? fileURLToPath(ref) : ref));
    if (!fs.existsSync(p) && !path.isAbsolute(expandHome(ref))) {
      const inDir = path.resolve(IMAGE_DIR, ref);
      if (fs.existsSync(inDir)) p = inDir;
    }
    if (!INPUT_EXT.has(path.extname(p).toLowerCase())) {
      throw new ToolError(`Hanya file .png/.jpg/.jpeg/.webp / Only .png, .jpg, .jpeg or .webp files are accepted: ${p}`);
    }
    let st;
    try { st = fs.statSync(p); } catch { throw new ToolError(`File tidak ditemukan / File not found: ${p} (pakai path lengkap / use the full path)`); }
    if (!st.isFile()) throw new ToolError(`Bukan file / Not a file: ${p}`);
    if (st.size > MAX_INPUT_BYTES) throw new ToolError(`File lebih dari 20 MB / File is larger than 20 MB: ${p}`);
    data = fs.readFileSync(p);
  }
  const kind = sniff(data);
  if (!kind) throw new ToolError(`Isi file bukan gambar PNG/JPEG/WebP / The content is not a PNG, JPEG or WebP image: ${ref}`);
  return { data, ...kind };
}

// Downloads a public image. Inputs must be https; results may also come from the gateway's own origin (for local setups).
async function download(url, limit, what) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.origin !== new URL(BASE_URL).origin) throw new ToolError(`Link tidak diizinkan / Link not allowed: ${u.origin}`);
  let r;
  try {
    r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'ezkielyna-image-mcp/' + VERSION } });
  } catch {
    throw new ToolError(`Gagal mengunduh ${what === 'input' ? 'gambar' : 'hasil'} / Download failed: ${u.origin}${u.pathname}`);
  }
  if (!r.ok) throw new ToolError(`Gagal mengunduh / Download failed (HTTP ${r.status}): ${u.origin}${u.pathname}`);
  if (Number(r.headers.get('content-length')) > limit) throw new ToolError(`Gambar lebih dari ${Math.round(limit / 1048576)} MB / Image too large.`);
  const chunks = [];
  let size = 0;
  for await (const c of r.body) {
    size += c.length;
    if (size > limit) throw new ToolError(`Gambar lebih dari ${Math.round(limit / 1048576)} MB / Image too large.`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

async function imageFromImagesApi(v) {
  const item = Array.isArray(v?.data) ? v.data[0] : null;
  if (item && typeof item.b64_json === 'string' && item.b64_json) return asImage(Buffer.from(item.b64_json, 'base64'));
  if (item && typeof item.url === 'string' && item.url) return asImage(await download(item.url, MAX_OUTPUT_BYTES, 'output'));
  throw new ToolError('Gateway tidak mengirim gambar (mungkin ditolak filter konten). Ubah prompt lalu coba lagi. / No image in the answer (maybe blocked by a content filter): change the prompt and retry.');
}

// nano-banana-pro answers in Markdown: a gateway-hosted link ![..](https://api.ezkielyna.store/media/<id>.png) or a data: URL.
async function imageFromChat(v) {
  const t = String(v?.choices?.[0]?.message?.content || '');
  const link = t.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  if (link) return asImage(await download(link[1], MAX_OUTPUT_BYTES, 'output'));
  const inline = t.match(/data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/i);
  if (inline) return asImage(Buffer.from(inline[1], 'base64'));
  const said = scrub(t).replace(/\s+/g, ' ').trim().slice(0, 300);
  throw new ToolError('Model tidak mengirim gambar / The model did not return an image.' + (said ? ` Jawaban / Answer: "${said}"` : '') + ' Ubah prompt lalu coba lagi. / Rephrase and retry.');
}

function asImage(data) {
  const kind = sniff(data);
  if (!kind) throw new ToolError('Jawaban gateway bukan gambar PNG/JPEG/WebP / The gateway answer is not an image.');
  return { data, ...kind };
}

function safeBase(filename, model) {
  let base = path.basename(String(filename || '').replace(/\\/g, '/')).replace(/\.(png|jpe?g|webp)$/i, '');
  base = base.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80);
  if (!base) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    base = `ezk-${model.replace(/[^A-Za-z0-9.-]+/g, '-')}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  return base;
}

// Writes inside IMAGE_DIR only, never over an existing file (name.png, name-1.png, name-2.png, ...).
function saveImage(data, filename, model) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const dir = fs.realpathSync(IMAGE_DIR);
  const base = safeBase(filename, model);
  const ext = sniff(data).ext;
  for (let i = 0; i < 10000; i++) {
    const p = path.join(dir, `${base}${i ? '-' + i : ''}.${ext}`);
    if (path.dirname(p) !== dir) throw new ToolError('Nama file tidak valid / Invalid file name.');
    try {
      fs.writeFileSync(p, data, { flag: 'wx' });
      return p;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new ToolError(`Gagal menyimpan / Could not save in ${dir}: ${e.code || e.message}`);
    }
  }
  throw new ToolError('Terlalu banyak file dengan nama sama / Too many files with this name.');
}

// ---------- argument helpers ----------

function optText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function requireText(v, name) {
  const t = optText(v);
  if (!t) throw new ToolError(`"${name}" wajib diisi / is required.`);
  if (t.length > 32000) throw new ToolError(`"${name}" terlalu panjang / is too long.`);
  return t;
}

function checkModelId(m) {
  if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(m)) throw new ToolError('Nama model tidak valid / Invalid model id.');
}

function text(t, isError = false) {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!isRequest) return; // notifications (notifications/initialized, cancelled, ...) need no answer
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        result = {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ezkielyna-image', title: 'Ezkielyna Image', version: VERSION },
          instructions: 'Create images with generate_image and edit local images with edit_image (paths or https URLs, 1-4 images). '
            + 'Results are saved locally; pass a result path back to edit_image to keep editing. Calls cost money: check list_image_models.',
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'resources/list': result = { resources: [] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some(t => t.name === name)) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${scrub(String(name))}` } });
          return;
        }
        // Image calls take 10-120 s; progress notifications keep clients that reset their timeout on progress waiting.
        const token = params && params._meta && params._meta.progressToken;
        let tick = 0;
        const timer = token !== undefined && token !== null
          ? setInterval(() => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++tick, message: 'Membuat gambar... / Working...' } }), 10000)
          : null;
        try {
          result = await callTool(name, (params && typeof params.arguments === 'object' && params.arguments) || {});
        } catch (e) {
          if (!(e instanceof ToolError)) log('tool failed:', e && e.stack || e);
          result = text(scrub(e instanceof ToolError ? e.message : 'Terjadi kesalahan / Unexpected error: ' + (e && e.message)), true);
        } finally {
          if (timer) clearInterval(timer);
        }
        break;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    log('request failed:', e && e.stack || e);
    send({ jsonrpc: '2.0', id, error: { code: e.rpcCode || -32603, message: scrub(e.message || 'Internal error') } });
  }
}

function main() {
  if (!API_KEY) log('warning: EZKIELYNA_API_KEY is not set; image tools will answer with setup instructions.');
  log(`v${VERSION} ready; base ${BASE_URL}; images saved to ${IMAGE_DIR}; session cap ${MAX_IMAGES}`);
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      const p = handle(m && typeof m === 'object' ? m : {}).catch(e => log('fatal handler error:', e && e.stack || e));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

main();
