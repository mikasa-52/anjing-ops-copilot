/**
 * 值守 · AI 运维工作台 —— 本地服务
 * 零依赖：静态托管 + DeepSeek 请求转发（Key 只在服务端，不进浏览器）
 * 启动：node server.js        访问 http://127.0.0.1:5178
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5178);
const API_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function hasKey() {
  const k = (process.env.DEEPSEEK_API_KEY || '').trim();
  return k.length > 10 && !/^sk-(x+|your)/i.test(k);
}

async function handleChat(req, res) {
  if (!hasKey()) {
    return sendJson(res, 200, { ok: false, reason: 'no_key' });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { ok: false, reason: 'bad_request' });
  }

  const { system, user, json, temperature } = payload || {};
  if (!user || typeof user !== 'string') {
    return sendJson(res, 400, { ok: false, reason: 'missing_prompt' });
  }

  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: system || '你是一名严谨的企业信息化运维支持专家，回答简洁、可执行。' },
      { role: 'user', content: user }
    ],
    temperature: typeof temperature === 'number' ? temperature : 0.3,
    max_tokens: 1600
  };
  if (json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const upstream = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.DEEPSEEK_API_KEY.trim()
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error('[ai] upstream', upstream.status, text.slice(0, 300));
      return sendJson(res, 200, {
        ok: false,
        reason: 'upstream_error',
        status: upstream.status,
        detail: text.slice(0, 300)
      });
    }

    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content || '';
    return sendJson(res, 200, {
      ok: true,
      content,
      usage: data?.usage || null
    });
  } catch (err) {
    console.error('[ai] failed:', err.message);
    return sendJson(res, 200, { ok: false, reason: 'network', detail: err.message });
  } finally {
    clearTimeout(timer);
  }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  if (pathname === '/api/status') {
    return sendJson(res, 200, {
      ai: hasKey() ? 'live' : 'fallback',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
    });
  }
  if (pathname === '/api/chat' && req.method === 'POST') {
    return handleChat(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  const bar = '─'.repeat(46);
  console.log('\n' + bar);
  console.log('  值守 · AI 运维工作台');
  console.log('  服务地址  http://127.0.0.1:' + PORT);
  console.log('  AI 状态   ' + (hasKey() ? '已连接 DeepSeek' : '未配置 Key · 使用演示答案'));
  console.log(bar + '\n');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    exec('start "" "http://127.0.0.1:' + PORT + '"');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n端口 ' + PORT + ' 已被占用，换个端口：set PORT=5179 && node server.js\n');
    process.exit(1);
  }
  throw err;
});
