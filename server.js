/**
 * 值守 · AI 运维工作台 —— 本地服务
 * 零依赖：静态托管 + DeepSeek 转发 + 工单/知识库/变更的 REST 接口
 * 启动：node server.js        访问 http://127.0.0.1:5178
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORE_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(STORE_DIR, 'store.json');

const PORT = Number(process.env.PORT || 5178);
// 云端平台会注入 PORT，此时必须监听 0.0.0.0 才能被反向代理访问；本地默认只开回环地址
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
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

/* ============ 数据存储 ============ */

function seedFromDataJs() {
  const code = fs.readFileSync(path.join(PUBLIC_DIR, 'data.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;this.__DATA__ = DATA;', sandbox);
  return sandbox.__DATA__;
}

function buildSeed() {
  const D = seedFromDataJs();
  const now = Date.now();
  const tickets = D.tickets.map((t, i) => ({
    id: t.id,
    title: t.title,
    from: t.from,
    pri: t.pri,
    status: "open",
    desc: "",
    createdAt: now - (i + 1) * 2400_000,
    updatedAt: now - (i + 1) * 2400_000,
    history: []
  }));
  return {
    seq: 2482,
    tickets,
    kb: D.kb.map((k) => ({ ...k })),
    changes: D.changes.map((c) => ({ ...c, createdAt: now }))
  };
}

let store = null;

function loadStore() {
  if (store) return store;
  try {
    if (fs.existsSync(STORE_FILE)) {
      store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (!store.tickets || !store.kb) throw new Error("结构不完整");
      return store;
    }
  } catch (e) {
    console.error("[store] 读取失败，将重建：" + e.message);
  }
  store = buildSeed();
  saveStore();
  return store;
}

function saveStore() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (e) {
    console.error("[store] 写入失败：" + e.message);
  }
}

function nextId() {
  store.seq = (store.seq || 2482) + 1;
  return "WX-" + store.seq;
}

/* ============ HTTP 工具 ============ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function sendJson(res, code, payload) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function hasKey() {
  const k = (process.env.DEEPSEEK_API_KEY || "").trim();
  return k.length > 10 && !/^sk-(x+|your)/i.test(k);
}

/* ============ 业务接口 ============ */

async function handleApi(req, res, pathname) {
  const method = req.method;
  const parts = pathname.split("/").filter(Boolean); // ['api','tickets','WX-2481']
  const resource = parts[1];
  const id = parts[2] ? decodeURIComponent(parts[2]) : null;

  if (resource === "status" && method === "GET") {
    return sendJson(res, 200, {
      ai: hasKey() ? "live" : "fallback",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      store: "file"
    });
  }

  if (resource === "chat" && method === "POST") {
    return handleChat(req, res);
  }

  const db = loadStore();

  /* ---- 工单 ---- */
  if (resource === "tickets") {
    if (method === "GET") {
      const rows = db.tickets.slice().sort((a, b) => b.createdAt - a.createdAt);
      return sendJson(res, 200, { ok: true, tickets: rows, seq: db.seq });
    }
    if (method === "POST") {
      const body = await readBody(req);
      if (!body.title || !String(body.title).trim()) {
        return sendJson(res, 400, { ok: false, error: "标题不能为空" });
      }
      const now = Date.now();
      const ticket = {
        id: nextId(),
        title: String(body.title).trim(),
        from: (body.from || "").trim() || "未知部门",
        pri: ["P0", "P1", "P2"].includes(body.pri) ? body.pri : "P2",
        status: "open",
        desc: (body.desc || "").trim(),
        createdAt: now,
        updatedAt: now,
        history: [{ at: now, action: "创建工单" }]
      };
      db.tickets.unshift(ticket);
      saveStore();
      return sendJson(res, 200, { ok: true, ticket });
    }
    if (method === "PATCH" && id) {
      const body = await readBody(req);
      const t = db.tickets.find((x) => x.id === id);
      if (!t) return sendJson(res, 404, { ok: false, error: "工单不存在" });
      ["title", "from", "desc"].forEach((k) => {
        if (typeof body[k] === "string") t[k] = body[k];
      });
      if (["P0", "P1", "P2"].includes(body.pri)) t.pri = body.pri;
      if (["open", "doing", "done"].includes(body.status)) {
        if (t.status !== body.status) {
          t.history.push({ at: Date.now(), action: "状态变更为 " + body.status });
        }
        t.status = body.status;
      }
      if (typeof body.note === "string" && body.note.trim()) {
        t.history.push({ at: Date.now(), action: body.note.trim() });
      }
      t.updatedAt = Date.now();
      saveStore();
      return sendJson(res, 200, { ok: true, ticket: t });
    }
    if (method === "DELETE" && id) {
      const i = db.tickets.findIndex((x) => x.id === id);
      if (i < 0) return sendJson(res, 404, { ok: false, error: "工单不存在" });
      const [removed] = db.tickets.splice(i, 1);
      saveStore();
      return sendJson(res, 200, { ok: true, removed: removed.id });
    }
  }

  /* ---- 知识库 ---- */
  if (resource === "kb") {
    if (method === "GET") return sendJson(res, 200, { ok: true, kb: db.kb });
    if (method === "POST") {
      const body = await readBody(req);
      if (!body.title || !String(body.title).trim()) {
        return sendJson(res, 400, { ok: false, error: "标题不能为空" });
      }
      const item = {
        id: "kb-" + Date.now().toString(36),
        title: String(body.title).trim(),
        desc: (body.desc || "").trim() || "由工单沉淀，待补充正文。",
        tags: Array.isArray(body.tags) ? body.tags.slice(0, 4) : ["待归类"],
        refs: 0,
        updated: new Date().toISOString().slice(5, 10).replace("-", "-"),
        ai: !!body.ai,
        doc: body.doc || {
          sections: [
            { h: "适用场景", p: (body.desc || "待补充。"), type: "p" },
            { h: "操作步骤", type: "ol", items: ["待补充具体步骤"] }
          ]
        }
      };
      db.kb.unshift(item);
      saveStore();
      return sendJson(res, 200, { ok: true, item });
    }
    if (method === "DELETE" && id) {
      const i = db.kb.findIndex((x) => x.id === id);
      if (i < 0) return sendJson(res, 404, { ok: false, error: "条目不存在" });
      db.kb.splice(i, 1);
      saveStore();
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ---- 变更记录 ---- */
  if (resource === "changes") {
    if (method === "GET") return sendJson(res, 200, { ok: true, changes: db.changes });
    if (method === "POST") {
      const body = await readBody(req);
      const item = {
        date: new Date().toISOString().slice(5, 10),
        version: (body.version || "v2.4.2").trim(),
        title: (body.title || "").trim() || "未命名变更",
        by: (body.by || "王恩泽 · 运维").trim(),
        tag: body.tag === "已回滚" ? "已回滚" : "已发布",
        checks: Array.isArray(body.checks) && body.checks.length ? body.checks : ["待补验证项"],
        note: (body.note || "").trim(),
        createdAt: Date.now()
      };
      db.changes.unshift(item);
      saveStore();
      return sendJson(res, 200, { ok: true, item, changes: db.changes });
    }
  }

  /* ---- 重置演示数据 ---- */
  if (resource === "reset" && method === "POST") {
    store = buildSeed();
    saveStore();
    return sendJson(res, 200, { ok: true, tickets: store.tickets, kb: store.kb, changes: store.changes });
  }

  /* ---- 汇总统计（看板用） ---- */
  if (resource === "stats" && method === "GET") {
    const t = db.tickets;
    const open = t.filter((x) => x.status === "open").length;
    const doing = t.filter((x) => x.status === "doing").length;
    const done = t.filter((x) => x.status === "done").length;
    return sendJson(res, 200, {
      ok: true,
      total: t.length,
      open,
      doing,
      done,
      p0: t.filter((x) => x.pri === "P0" && x.status !== "done").length
    });
  }

  return sendJson(res, 404, { ok: false, error: "接口不存在" });
}

/* ============ 大模型代理 ============ */

async function handleChat(req, res) {
  if (!hasKey()) {
    return sendJson(res, 200, { ok: false, reason: "no_key" });
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, reason: "bad_request" });
  }

  const { system, user, json, temperature } = payload || {};
  if (!user || typeof user !== "string") {
    return sendJson(res, 400, { ok: false, reason: "missing_prompt" });
  }

  const body = {
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    messages: [
      { role: "system", content: system || "你是一名严谨的企业信息化运维支持专家，回答简洁、可执行。" },
      { role: "user", content: user }
    ],
    temperature: typeof temperature === "number" ? temperature : 0.3,
    max_tokens: 1600
  };
  if (json) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const upstream = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.DEEPSEEK_API_KEY.trim()
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error("[ai] upstream", upstream.status, text.slice(0, 300));
      return sendJson(res, 200, {
        ok: false,
        reason: "upstream_error",
        status: upstream.status,
        detail: text.slice(0, 300)
      });
    }

    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content || "";
    return sendJson(res, 200, { ok: true, content, usage: data?.usage || null });
  } catch (err) {
    console.error("[ai] failed:", err.message);
    return sendJson(res, 200, { ok: false, reason: "network", detail: err.message });
  } finally {
    clearTimeout(timer);
  }
}

/* ============ 静态文件 ============ */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found: " + rel);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* ============ 启动 ============ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname).catch((err) => {
      console.error("[api]", err.message);
      sendJson(res, 500, { ok: false, error: err.message });
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, reason: "method_not_allowed" });
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const bar = "─".repeat(50);
  console.log("\n" + bar);
  console.log("  值守 · AI 运维工作台");
  console.log("  监听地址  " + HOST + ":" + PORT);
  console.log("  本地访问  http://127.0.0.1:" + PORT);
  console.log("  AI 状态   " + (hasKey() ? "已连接 DeepSeek" : "未配置 Key · 使用演示答案"));
  console.log("  数据文件  " + path.relative(ROOT, STORE_FILE));
  console.log(bar + "\n");
  loadStore();
  if (process.argv.includes("--open") && process.platform === "win32") {
    exec('start "" "http://127.0.0.1:' + PORT + '"');
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("\n端口 " + PORT + " 已被占用，换个端口：set PORT=5179 && node server.js\n");
    process.exit(1);
  }
  throw err;
});
