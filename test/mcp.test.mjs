// End-to-end tests: a local mock gateway (http server) and the MCP server spawned over stdio. No network, no paid calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ezkielyna-image-mcp.mjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const MEDIA_ID = 'a'.repeat(32);
const GOOD_KEY = 'sk-test-good-key';

let gw;
let base;
const seen = [];
let tmp;

function json(res, status, v) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(v));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezk-image-mcp-'));
  fs.writeFileSync(path.join(tmp, 'mug.png'), PNG);
  fs.writeFileSync(path.join(tmp, 'logo.jpg'), JPG);
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(tmp, 'fake.png'), 'not really a png');
  // 12 MB "photos": a PNG signature padded with zeros (fine for the size checks, never decoded).
  fs.writeFileSync(path.join(tmp, 'big1.png'), Buffer.concat([PNG, Buffer.alloc(12 * 1024 * 1024)]));
  fs.writeFileSync(path.join(tmp, 'big2.png'), Buffer.concat([PNG, Buffer.alloc(12 * 1024 * 1024)]));
  gw = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const rec = { method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'] || '' };
    seen.push(rec);
    if (req.url === '/api/pricing') {
      return json(res, 200, { success: true, group_ratio: { media: 1 }, data: [
        { model_name: 'gpt-image-2.5', tags: 'Image', quota_type: 1, model_price: 0.00825, supported_endpoint_types: ['image-generation', 'openai'] },
        { model_name: 'nano-banana-pro', tags: 'Image', quota_type: 1, model_price: 0.033, supported_endpoint_types: ['openai', 'image-generation'] },
        { model_name: 'flux-3-image', tags: 'Image', quota_type: 1, model_price: 0.163, supported_endpoint_types: ['image-generation'] },
        { model_name: 'deepseek-v4', quota_type: 0, model_ratio: 1, supported_endpoint_types: ['openai'] },
      ] });
    }
    if (req.url === `/media/${MEDIA_ID}.png`) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    const key = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (key === 'sk-wrong-401') return json(res, 401, { error: { message: `invalid token ${key}`, type: 'new_api_error' } });
    if (key === 'sk-group-403') return json(res, 403, { error: { message: 'model gpt-image-2.5 is not allowed for group default', type: 'new_api_error' } });
    if (key === 'sk-broke-402') return json(res, 402, { error: { message: 'insufficient user quota', type: 'new_api_error' } });
    if (key === 'sk-big-413') return json(res, 413, { error: { message: 'Request body is larger than 32 MB. Send fewer or smaller images.' } });
    if (key === 'sk-busy-429') return json(res, 429, { error: { message: 'too many requests' } });
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'gpt-image-2.5' }, { id: 'nano-banana-pro' }, { id: 'flux-3-image' }, { id: 'deepseek-v4' }, { id: 'sora-2-video' }] });
    if (req.url === '/v1/images/generations') {
      rec.json = JSON.parse(body.toString());
      return json(res, 200, { created: 1, data: [{ b64_json: PNG.toString('base64') }] });
    }
    if (req.url === '/v1/images/edits') {
      const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': rec.type }, body }).formData();
      rec.fields = [...form.keys()];
      rec.form = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
      rec.files = [...form.entries()].filter(([, v]) => typeof v !== 'string').map(([k, v]) => ({ field: k, type: v.type, size: v.size }));
      return json(res, 200, { created: 1, data: [{ b64_json: PNG.toString('base64') }] });
    }
    if (req.url === '/v1/chat/completions') {
      rec.json = JSON.parse(body.toString());
      const prompt = rec.json.messages[0].content[0].text;
      const content = prompt.includes('inline')
        ? `Here you go ![image](data:image/png;base64,${PNG.toString('base64')})`
        : prompt.includes('noimage') ? 'Sorry, I cannot do that.' : `![image](${base}/media/${MEDIA_ID}.png)`;
      return json(res, 200, { choices: [{ message: { role: 'assistant', content } }] });
    }
    json(res, 404, { error: { message: 'not found' } });
  });
  await new Promise(r => gw.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gw.address().port}`;
});

after(() => {
  gw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Spawns the MCP server and talks to it line by line.
function startMcp(extraEnv = {}) {
  const outDir = fs.mkdtempSync(path.join(tmp, 'out-'));
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOME: tmp, EZKIELYNA_API_KEY: GOOD_KEY, EZKIELYNA_BASE_URL: `${base}/v1`, EZKIELYNA_IMAGE_DIR: outDir, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const waiting = new Map();
  child.stdout.on('data', d => {
    stdout += d;
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be JSON-RPC
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  child.stderr.on('data', d => { stderr += d; });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    waiting.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const stop = () => new Promise(r => { child.on('exit', r); child.stdin.end(); });
  return { child, request, notify, call, stop, outDir, logs: () => stdout + stderr };
}

async function initialized(env) {
  const mcp = startMcp(env);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  mcp.notify('notifications/initialized');
  return mcp;
}

const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const savedPath = r => textOf(r).match(/Saved: (.+)/)[1].trim();

test('handshake, ping and tools/list', async () => {
  const mcp = startMcp();
  const init = await mcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.ok(init.result.capabilities.tools);
  assert.equal(init.result.serverInfo.name, 'ezkielyna-image');
  mcp.notify('notifications/initialized');
  assert.deepEqual((await mcp.request('ping')).result, {});
  const odd = await mcp.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(odd.result.protocolVersion, '2025-06-18');
  const list = await mcp.request('tools/list', {});
  assert.deepEqual(list.result.tools.map(t => t.name).sort(), ['edit_image', 'generate_image', 'list_image_models']);
  assert.deepEqual(list.result.tools.find(t => t.name === 'edit_image').inputSchema.properties.model.enum, ['gpt-image-2.5', 'nano-banana-pro']);
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');
  assert.equal((await mcp.request('no/such')).error.code, -32601);
  assert.equal((await mcp.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  await mcp.stop();
});

test('generate_image saves the image, returns it inline, never overwrites', async () => {
  const mcp = await initialized();
  const r1 = await mcp.call('generate_image', { prompt: 'a white mug', filename: '../../etc/my mug!.png' });
  assert.ok(!r1.isError, textOf(r1));
  const p1 = savedPath(r1);
  assert.equal(path.dirname(p1), fs.realpathSync(mcp.outDir));
  assert.equal(path.basename(p1), 'my-mug.png');
  assert.deepEqual(fs.readFileSync(p1), PNG);
  assert.match(textOf(r1), /Model: gpt-image-2\.5/);
  assert.match(textOf(r1), /\$0\.00825/);
  const img = r1.content.find(c => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.equal(img.data, PNG.toString('base64'));
  const req = seen.filter(s => s.url === '/v1/images/generations').at(-1);
  assert.deepEqual(req.json, { model: 'gpt-image-2.5', prompt: 'a white mug', n: 1, response_format: 'b64_json' });
  assert.equal(req.auth, `Bearer ${GOOD_KEY}`);
  const r2 = await mcp.call('generate_image', { prompt: 'again', filename: 'my mug', size: '1024x1024' });
  assert.equal(path.basename(savedPath(r2)), 'my-mug-1.png');
  assert.equal(seen.filter(s => s.url === '/v1/images/generations').at(-1).json.size, '1024x1024');
  await mcp.stop();
});

test('edit_image with one image sends field "image"', async () => {
  const mcp = await initialized();
  const r = await mcp.call('edit_image', { prompt: 'add a plant', images: [path.join(tmp, 'mug.png')] });
  assert.ok(!r.isError, textOf(r));
  const req = seen.filter(s => s.url === '/v1/images/edits').at(-1);
  assert.match(req.type, /^multipart\/form-data/);
  assert.deepEqual(req.form, { model: 'gpt-image-2.5', prompt: 'add a plant', n: '1', response_format: 'b64_json', quality: 'high', input_fidelity: 'high' });
  assert.deepEqual(req.files, [{ field: 'image', type: 'image/png', size: PNG.length }]);
  // Chaining: the result path is a valid input for the next edit.
  const r2 = await mcp.call('edit_image', { prompt: 'marble table', images: [savedPath(r)] });
  assert.ok(!r2.isError, textOf(r2));
  await mcp.stop();
});

test('edit_image with four images sends image[] four times', async () => {
  const mcp = await initialized();
  const imgs = [path.join(tmp, 'mug.png'), path.join(tmp, 'logo.jpg'), path.join(tmp, 'mug.png'), path.join(tmp, 'logo.jpg')];
  const r = await mcp.call('edit_image', { prompt: 'combine', images: imgs, filename: 'combo' });
  assert.ok(!r.isError, textOf(r));
  const req = seen.filter(s => s.url === '/v1/images/edits').at(-1);
  assert.deepEqual(req.files.map(f => f.field), ['image[]', 'image[]', 'image[]', 'image[]']);
  assert.deepEqual(req.files.map(f => f.type), ['image/png', 'image/jpeg', 'image/png', 'image/jpeg']);
  const five = await mcp.call('edit_image', { prompt: 'too many', images: [...imgs, imgs[0]] });
  assert.ok(five.isError);
  assert.match(textOf(five), /maksimal 4/);
  const grok = await mcp.call('edit_image', { prompt: 'x', model: 'grok-imagine-image-2.0', images: imgs.slice(0, 1) });
  assert.ok(grok.isError);
  assert.match(textOf(grok), /cannot edit images here/);
  await mcp.stop();
});

test('nano-banana-pro edits through chat: /media link and data URL answers', async () => {
  const mcp = await initialized();
  const before = seen.length;
  const r1 = await mcp.call('edit_image', { prompt: 'put the logo on the mug', model: 'nano-banana-pro', images: [path.join(tmp, 'mug.png'), path.join(tmp, 'logo.jpg')] });
  assert.ok(!r1.isError, textOf(r1));
  const chat = seen.slice(before).find(s => s.url === '/v1/chat/completions');
  assert.equal(chat.json.model, 'nano-banana-pro');
  assert.equal(chat.json.stream, false);
  const parts = chat.json.messages[0].content;
  assert.deepEqual(parts[0], { type: 'text', text: 'put the logo on the mug' });
  assert.equal(parts.length, 3);
  assert.ok(parts[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.ok(parts[2].image_url.url.startsWith('data:image/jpeg;base64,'));
  assert.ok(seen.slice(before).some(s => s.url === `/media/${MEDIA_ID}.png`), 'downloads the /media link');
  assert.deepEqual(fs.readFileSync(savedPath(r1)), PNG);
  assert.match(textOf(r1), /\$0\.033/);
  const r2 = await mcp.call('edit_image', { prompt: 'inline please', model: 'nano-banana-pro', images: [path.join(tmp, 'mug.png')] });
  assert.ok(!r2.isError, textOf(r2));
  assert.deepEqual(fs.readFileSync(savedPath(r2)), PNG);
  const r3 = await mcp.call('edit_image', { prompt: 'noimage', model: 'nano-banana-pro', images: [path.join(tmp, 'mug.png')] });
  assert.ok(r3.isError);
  assert.match(textOf(r3), /did not return an image/);
  await mcp.stop();
});

test('non-image files are rejected before any request', async () => {
  const mcp = await initialized();
  const before = seen.length;
  const txt = await mcp.call('edit_image', { prompt: 'x', images: [path.join(tmp, 'notes.txt')] });
  assert.ok(txt.isError);
  assert.match(textOf(txt), /Only \.png, \.jpg, \.jpeg or \.webp/);
  const fake = await mcp.call('edit_image', { prompt: 'x', images: [path.join(tmp, 'fake.png')] });
  assert.ok(fake.isError);
  assert.match(textOf(fake), /not a PNG, JPEG or WebP/);
  const missing = await mcp.call('edit_image', { prompt: 'x', images: [path.join(tmp, 'missing.png')] });
  assert.match(textOf(missing), /File not found/);
  const http1 = await mcp.call('edit_image', { prompt: 'x', images: ['http://example.com/a.png'] });
  assert.match(textOf(http1), /Only https/);
  assert.equal(seen.length, before, 'nothing was sent to the gateway');
  await mcp.stop();
});

test('total upload size is checked before sending (base64 counts for nano-banana-pro)', async () => {
  const mcp = await initialized({ EZKIELYNA_MAX_IMAGES: '1' });
  const big = [path.join(tmp, 'big1.png'), path.join(tmp, 'big2.png')];
  const before = seen.length;
  // 24 MB raw is 32 MB as base64: too big for the chat route.
  const nano = await mcp.call('edit_image', { prompt: 'x', model: 'nano-banana-pro', images: big });
  assert.ok(nano.isError);
  assert.match(textOf(nano), /Total gambar terlalu besar.*22 MB/s);
  // Four of them is 48 MB raw: too big for /images/edits too.
  const four = await mcp.call('edit_image', { prompt: 'x', images: [...big, ...big] });
  assert.match(textOf(four), /Total gambar terlalu besar/);
  assert.equal(seen.length, before, 'nothing was sent');
  // 24 MB raw fits the multipart route, and the refusals above did not use the session slot.
  const ok = await mcp.call('edit_image', { prompt: 'x', images: big });
  assert.ok(!ok.isError, textOf(ok));
  assert.equal(seen.filter(s => s.url === '/v1/images/edits').at(-1).files.length, 2);
  await mcp.stop();
});

test('gateway 413 maps to the size message, not "try again later"', async () => {
  const mcp = await initialized({ EZKIELYNA_API_KEY: 'sk-big-413' });
  const r = await mcp.call('generate_image', { prompt: 'x' });
  assert.ok(r.isError);
  assert.match(textOf(r), /Total gambar terlalu besar/);
  assert.doesNotMatch(textOf(r), /Try again later|\.\./);
  await mcp.stop();
});

test('session cap stops paid calls', async () => {
  const mcp = await initialized({ EZKIELYNA_MAX_IMAGES: '1' });
  const r1 = await mcp.call('generate_image', { prompt: 'one' });
  assert.ok(!r1.isError, textOf(r1));
  const before = seen.length;
  const r2 = await mcp.call('generate_image', { prompt: 'two' });
  assert.ok(r2.isError);
  assert.match(textOf(r2), /EZKIELYNA_MAX_IMAGES/);
  const r3 = await mcp.call('edit_image', { prompt: 'three', images: [path.join(tmp, 'mug.png')] });
  assert.ok(r3.isError);
  assert.equal(seen.slice(before).filter(s => s.url.startsWith('/v1/images')).length, 0);
  await mcp.stop();
});

test('friendly 401/403/402/429 errors, key never shown, refused calls do not use the cap', async () => {
  for (const [key, re] of [['sk-wrong-401', /Wrong or inactive API key/], ['sk-group-403', /buat key grup Media|Buat key grup Media/], ['sk-broke-402', /top up at https:\/\/ezkielyna\.store/], ['sk-busy-429', /busy/]]) {
    const mcp = await initialized({ EZKIELYNA_API_KEY: key, EZKIELYNA_MAX_IMAGES: '1' });
    const r = await mcp.call('generate_image', { prompt: 'x' });
    assert.ok(r.isError, key);
    assert.match(textOf(r), re);
    const again = await mcp.call('generate_image', { prompt: 'x' });
    assert.doesNotMatch(textOf(again), /EZKIELYNA_MAX_IMAGES/, 'refused call gave its slot back');
    const models = await mcp.call('list_image_models', {});
    assert.ok(models.isError);
    await mcp.stop();
    assert.ok(!mcp.logs().includes(key), `key ${key} leaked`);
  }
});

test('list_image_models joins /models with prices and the edit table', async () => {
  const mcp = await initialized();
  const r = await mcp.call('list_image_models', {});
  assert.ok(!r.isError, textOf(r));
  const t = textOf(r);
  assert.match(t, /gpt-image-2\.5: \$0\.00825\/gambar.*max 4/);
  assert.match(t, /nano-banana-pro: \$0\.033\/gambar.*max 4/);
  assert.match(t, /flux-3-image: \$0\.163\/gambar.*generate only/);
  assert.doesNotMatch(t, /deepseek|sora/);
  await mcp.stop();
  assert.ok(!mcp.logs().includes(GOOD_KEY));
});

test('missing key gives setup help instead of crashing', async () => {
  const mcp = await initialized({ EZKIELYNA_API_KEY: '' });
  const r = await mcp.call('generate_image', { prompt: 'x' });
  assert.ok(r.isError);
  assert.match(textOf(r), /EZKIELYNA_API_KEY/);
  await mcp.stop();
});
