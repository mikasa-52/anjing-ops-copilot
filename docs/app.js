/* 值守 · AI 运维工作台 —— 交互层 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let AI_STATE = "fallback";

/* ============ 数据层 ============
 * api 模式：读写服务端 /api/*（真持久化，多人共享）
 * local 模式：静态托管（GitHub Pages）无后端时降级到浏览器 localStorage
 */
const LS_KEY = "zhishou.demo.v1";

const Store = {
  mode: "api",
  tickets: [],
  kb: [],
  changes: [],
  filter: "all",
  currentId: null,

  async init() {
    try {
      const [t, k, c] = await Promise.all([
        fetch("/api/tickets").then((r) => r.json()),
        fetch("/api/kb").then((r) => r.json()),
        fetch("/api/changes").then((r) => r.json())
      ]);
      if (!t.ok || !k.ok || !c.ok) throw new Error("api unavailable");
      this.tickets = t.tickets || [];
      this.kb = k.kb || [];
      this.changes = c.changes || [];
      this.mode = "api";
    } catch {
      this.mode = "local";
      this.loadLocal();
    }
    this.currentId = this.tickets.length ? this.tickets[0].id : null;
  },

  loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.tickets)) {
          this.tickets = d.tickets;
          this.kb = d.kb || [];
          this.changes = d.changes || [];
          return;
        }
      }
    } catch {
      /* 损坏则重建 */
    }
    const now = Date.now();
    this.tickets = DATA.tickets.map((t, i) => ({
      id: t.id,
      title: t.title,
      from: t.from,
      pri: t.pri,
      status: "open",
      desc: "",
      createdAt: now - (i + 1) * 2400000,
      updatedAt: now - (i + 1) * 2400000,
      history: []
    }));
    this.kb = DATA.kb.map((k) => ({ ...k }));
    this.changes = DATA.changes.map((c) => ({ ...c, createdAt: now }));
    this.persist();
  },

  persist() {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ tickets: this.tickets, kb: this.kb, changes: this.changes })
      );
    } catch {
      /* 隐私模式下忽略 */
    }
  },

  async req(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    return r.json();
  },

  async createTicket(data) {
    if (this.mode === "api") {
      const r = await this.req("POST", "/api/tickets", data);
      if (!r.ok) throw new Error(r.error || "创建失败");
      this.tickets.unshift(r.ticket);
      return r.ticket;
    }
    const now = Date.now();
    const ticket = {
      id: "WX-" + (2483 + this.tickets.length),
      title: data.title,
      from: data.from || "未知部门",
      pri: data.pri || "P2",
      status: "open",
      desc: data.desc || "",
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, action: "创建工单" }]
    };
    this.tickets.unshift(ticket);
    this.persist();
    return ticket;
  },

  async updateTicket(id, patch) {
    if (this.mode === "api") {
      const r = await this.req("PATCH", "/api/tickets/" + encodeURIComponent(id), patch);
      if (!r.ok) throw new Error(r.error || "更新失败");
      const i = this.tickets.findIndex((x) => x.id === id);
      if (i >= 0) this.tickets[i] = r.ticket;
      return r.ticket;
    }
    const t = this.tickets.find((x) => x.id === id);
    if (!t) throw new Error("工单不存在");
    Object.assign(t, patch, { updatedAt: Date.now() });
    t.history = t.history || [];
    if (patch.status) t.history.push({ at: Date.now(), action: "状态变更为 " + patch.status });
    if (patch.note) t.history.push({ at: Date.now(), action: patch.note });
    this.persist();
    return t;
  },

  async deleteTicket(id) {
    if (this.mode === "api") {
      const r = await this.req("DELETE", "/api/tickets/" + encodeURIComponent(id));
      if (!r.ok) throw new Error(r.error || "删除失败");
    }
    this.tickets = this.tickets.filter((x) => x.id !== id);
    if (this.currentId === id) this.currentId = this.tickets[0] ? this.tickets[0].id : null;
    this.persist();
  },

  async createKb(data) {
    if (this.mode === "api") {
      const r = await this.req("POST", "/api/kb", data);
      if (!r.ok) throw new Error(r.error || "创建失败");
      this.kb.unshift(r.item);
      return r.item;
    }
    const item = {
      id: "kb-" + Date.now().toString(36),
      title: data.title,
      desc: data.desc || "由工单沉淀，待补充正文。",
      tags: data.tags && data.tags.length ? data.tags : ["待归类"],
      refs: 0,
      updated: new Date().toISOString().slice(5, 10),
      ai: !!data.ai,
      doc: data.doc || {
        sections: [
          { h: "适用场景", p: data.desc || "待补充。", type: "p" },
          { h: "操作步骤", type: "ol", items: ["待补充具体步骤"] }
        ]
      }
    };
    this.kb.unshift(item);
    this.persist();
    return item;
  },

  async deleteKb(id) {
    if (this.mode === "api") {
      const r = await this.req("DELETE", "/api/kb/" + encodeURIComponent(id));
      if (!r.ok) throw new Error(r.error || "删除失败");
    }
    this.kb = this.kb.filter((x) => x.id !== id);
    this.persist();
  },

  async createChange(data) {
    if (this.mode === "api") {
      const r = await this.req("POST", "/api/changes", data);
      if (!r.ok) throw new Error(r.error || "创建失败");
      this.changes = r.changes || this.changes;
      return r.item;
    }
    const item = {
      date: new Date().toISOString().slice(5, 10),
      version: data.version || "v2.4.2",
      title: data.title,
      by: data.by || "王恩泽 · 运维",
      tag: data.tag === "已回滚" ? "已回滚" : "已发布",
      checks: data.checks && data.checks.length ? data.checks : ["待补验证项"],
      note: data.note || "",
      createdAt: Date.now()
    };
    this.changes.unshift(item);
    this.persist();
    return item;
  },

  async reset() {
    if (this.mode === "api") {
      const r = await this.req("POST", "/api/reset");
      if (!r.ok) throw new Error("重置失败");
      this.tickets = r.tickets;
      this.kb = r.kb;
      this.changes = r.changes;
    } else {
      localStorage.removeItem(LS_KEY);
      this.loadLocal();
    }
    this.currentId = this.tickets.length ? this.tickets[0].id : null;
    this.filter = "all";
  },

  count(status) {
    if (status === "all") return this.tickets.length;
    return this.tickets.filter((t) => t.status === status).length;
  },

  visible() {
    const list = this.filter === "all" ? this.tickets : this.tickets.filter((t) => t.status === this.filter);
    return list;
  },

  current() {
    return this.tickets.find((t) => t.id === this.currentId) || null;
  }
};

const STATUS_TEXT = { open: "待处理", doing: "处理中", done: "已解决" };

/* ============ 通用 UI ============ */
let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.innerHTML = '<i></i>' + escapeHtml(msg);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

async function copyText(text, okMsg = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(okMsg);
    } catch {
      toast("复制失败，请手动选择");
    }
    ta.remove();
  }
}

/* ============ 页面路由 ============ */
const ROUTE_NAME = {
  dashboard: "总览看板",
  tickets: "智能工单台",
  sql: "数据核对台",
  knowledge: "知识库与变更",
  story: "讲述模式"
};

function setRoute(name) {
  if (name === "story") {
    openStory();
    return;
  }
  closeStory();
  $$(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.route === name));
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + name));
  $("#crumbName").textContent = ROUTE_NAME[name] || "";
  if (location.hash.replace("#", "") !== name) {
    history.replaceState(null, "", "#" + name);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initNav() {
  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setRoute(btn.dataset.route));
  });
  $$("[data-route-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.routeJump;
      setRoute(target);
      if (target === "tickets") {
        setTimeout(() => $("#askInput").focus(), 350);
      }
    });
  });
}

/* ============ 总览 ============ */
function sparkline(values, tone) {
  const w = 96, h = 46;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * (w - 4) + 2,
    y: h - 4 - ((v - min) / span) * (h - 14)
  }));
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const cx = (pts[i].x + pts[i + 1].x) / 2;
    d += ` C ${cx.toFixed(1)} ${pts[i].y.toFixed(1)}, ${cx.toFixed(1)} ${pts[i + 1].y.toFixed(1)}, ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
  }
  const stroke = tone === "warn" ? "#C8102E" : "#C8102E";
  return `<svg class="kpi-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.3" opacity="0.5" stroke-linecap="round"/>
    <circle cx="${pts[pts.length - 1].x.toFixed(1)}" cy="${pts[pts.length - 1].y.toFixed(1)}" r="2.2" fill="${stroke}"/>
  </svg>`;
}

function renderKpi() {
  const hasData = Store.tickets.length > 0;
  const openCount = hasData ? Store.count("open") : Number(DATA.kpi[0].value);
  const doingCount = hasData ? Store.count("doing") : 0;

  $("#kpiGrid").innerHTML = DATA.kpi
    .map((k, i) => {
      const value = i === 0 ? String(openCount) : k.value;
      const label = i === 0 ? "待处理工单" : k.label;
      const deltaText = i === 0 ? `其中 ${doingCount} 单处理中` : k.delta;
      const tone = i === 0 ? "is-good" : k.tone === "good" ? "is-good" : "is-warn";
      return `
    <div class="kpi">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${escapeHtml(value)}<small>${escapeHtml(k.unit)}</small></div>
      <div class="kpi-delta ${tone}">
        <span>${escapeHtml(deltaText.split(" ")[0])}</span>
        <b>${escapeHtml(deltaText.split(" ").slice(1).join(" "))}</b>
      </div>
      ${sparkline(k.spark, k.tone)}
    </div>`;
    })
    .join("");
}

function renderTrend() {
  const W = 660, H = 210;
  const padL = 30, padR = 10, padT = 14, padB = 26;
  const values = DATA.trend.total.concat(DATA.trend.ai);
  const maxV = Math.ceil(Math.max(...values) / 10) * 10 + 10;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = DATA.trend.total.length;

  const px = (i) => padL + (i / (n - 1)) * innerW;
  const py = (v) => padT + innerH - (v / maxV) * innerH;

  const toPath = (arr) => {
    const pts = arr.map((v, i) => ({ x: px(i), y: py(v) }));
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const cx = (pts[i].x + pts[i + 1].x) / 2;
      d += ` C ${cx.toFixed(1)} ${pts[i].y.toFixed(1)}, ${cx.toFixed(1)} ${pts[i + 1].y.toFixed(1)}, ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
    }
    return { d, pts };
  };

  const total = toPath(DATA.trend.total);
  const ai = toPath(DATA.trend.ai);
  const area = `${total.d} L ${px(n - 1).toFixed(1)} ${py(0).toFixed(1)} L ${px(0).toFixed(1)} ${py(0).toFixed(1)} Z`;

  const gridCount = 4;
  let grid = "";
  for (let i = 0; i <= gridCount; i++) {
    const y = padT + (innerH / gridCount) * i;
    const v = Math.round(maxV - (maxV / gridCount) * i);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#EFECE5" stroke-width="1"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" font-family="var(--mono)" fill="#A29C92">${v}</text>`;
  }

  const step = Math.ceil(n / 7);
  let xLabels = "";
  DATA.trend.labels.forEach((lb, i) => {
    const idx = Math.min(i * 2, n - 1);
    if (i % 1 !== 0) return;
    xLabels += `<text x="${px(idx).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9.5" font-family="var(--mono)" fill="#A29C92">${lb}</text>`;
  });

  const lastT = total.pts[total.pts.length - 1];
  const lastA = ai.pts[ai.pts.length - 1];

  $("#trendChart").innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" width="100%">
    <defs>
      <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#C8102E" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="#C8102E" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${area}" fill="url(#areaFill)"/>
    <path d="${total.d}" fill="none" stroke="#C8102E" stroke-width="1.8" stroke-linecap="round"/>
    <path d="${ai.d}" fill="none" stroke="#4A56C4" stroke-width="1.6" stroke-dasharray="4 4" stroke-linecap="round"/>
    <circle cx="${lastT.x.toFixed(1)}" cy="${lastT.y.toFixed(1)}" r="3" fill="#fff" stroke="#C8102E" stroke-width="1.8"/>
    <circle cx="${lastA.x.toFixed(1)}" cy="${lastA.y.toFixed(1)}" r="3" fill="#fff" stroke="#4A56C4" stroke-width="1.8"/>
    ${xLabels}
  </svg>`;

  $("#trendLegend").innerHTML = `
    <span><i style="background:#C8102E"></i>工单总量</span>
    <span><i style="background:#4A56C4"></i>AI 直接答复</span>`;
}

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

function renderDonut() {
  const size = 156, cx = 78, cy = 78, r = 54, sw = 15;
  const gapDeg = 1.6;
  let cursor = 0;

  const segs = DATA.donut
    .map((d) => {
      const sweep = (d.value / 100) * 360;
      const a0 = cursor + gapDeg / 2;
      const a1 = cursor + sweep - gapDeg / 2;
      cursor += sweep;
      return `<path d="${arcPath(cx, cy, r, a0, a1)}" fill="none" stroke="${d.color}" stroke-width="${sw}" stroke-linecap="butt"/>`;
    })
    .join("");

  $("#donutChart").innerHTML = `
  <svg viewBox="0 0 ${size} ${size}" width="156" height="156">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#F1EEE7" stroke-width="${sw}"/>
    ${segs}
    <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="21" font-family="var(--mono)" font-weight="600" fill="#191714" style="font-variant-numeric:tabular-nums">41%</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="9.5" fill="#A29C92">AI 自动答复</text>
  </svg>`;

  $("#donutLegend").innerHTML = DATA.donut
    .map((d) => `<li><i style="background:${d.color}"></i>${escapeHtml(d.label)}<em>${d.value}%</em></li>`)
    .join("");
}

function renderRisks() {
  $("#riskList").innerHTML = DATA.risks
    .map(
      (r) => `
    <div class="risk-row">
      <div class="risk-flag ${r.level}"></div>
      <div class="risk-main">
        <b>${escapeHtml(r.title)}</b>
        <span>${escapeHtml(r.id)} · ${escapeHtml(r.meta)}</span>
      </div>
      <div class="risk-clock ${r.level === "mid" ? "calm" : ""}">${escapeHtml(r.clock)}</div>
      <button class="btn btn-quiet" data-risk="${r.id}">查看</button>
    </div>`
    )
    .join("");

  $$("[data-risk]").forEach((b) => {
    b.addEventListener("click", () => {
      const t = Store.tickets.find((x) => x.id === b.dataset.risk);
      if (!t) {
        toast("这条工单已被删除");
        return;
      }
      setRoute("tickets");
      selectTicket(t.id);
    });
  });
}

/* ============ 工单台 ============ */
function relTime(ts) {
  if (!ts) return "";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return mins + " 分钟前";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + " 小时前";
  const days = Math.floor(hrs / 24);
  return days === 1 ? "昨天" : days + " 天前";
}

function renderTickets() {
  const list = Store.visible();
  const box = $("#ticketItems");

  if (!list.length) {
    box.innerHTML = `<div class="ticket-empty">
      <b>这个分组下没有工单</b>
      <span>换一个状态筛选，或点右上角「新建」提一条。</span>
    </div>`;
  } else {
    box.innerHTML = list
      .map(
        (t) => `
      <div class="ticket ${t.id === Store.currentId ? "is-active" : ""}" data-id="${t.id}">
        <div class="ticket-top">
          <span class="pri pri-${String(t.pri).toLowerCase()}">${t.pri}</span>
          <span class="st st-${t.status}">${STATUS_TEXT[t.status] || "待处理"}</span>
          <span class="ticket-id">${t.id}</span>
        </div>
        <div class="ticket-title">${escapeHtml(t.title)}</div>
        <div class="ticket-meta">${escapeHtml(t.from)} <i>·</i> ${relTime(t.updatedAt)}</div>
        <div class="ticket-ops">
          <button class="ticket-op" data-edit="${t.id}" title="编辑">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 11V13.5H5l7.4-7.4-2.5-2.5z"/></svg>
          </button>
          <button class="ticket-op danger" data-del="${t.id}" title="删除">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2"/></svg>
          </button>
        </div>
      </div>`
      )
      .join("");
  }

  $("#ticketCount").textContent = Store.tickets.length;
  $$("#statusFilter button").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.status === Store.filter)
  );
}

function selectTicket(id) {
  Store.currentId = id;
  renderTickets();
  renderCurrentTicket();
  const t = Store.current();
  if (t) $("#askInput").value = t.title;
}

function renderCurrentTicket() {
  const t = Store.current();
  const el = $("#currentTicket");
  if (!t) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <div class="ct-main">
      <div class="ct-id">${t.id} · ${escapeHtml(t.from)} · ${t.history ? t.history.length : 0} 条操作记录</div>
      <div class="ct-title">${escapeHtml(t.title)}</div>
    </div>
    <div class="ct-ops">
      <select id="ctStatus" title="变更状态">
        ${["open", "doing", "done"]
          .map((s) => `<option value="${s}" ${t.status === s ? "selected" : ""}>${STATUS_TEXT[s]}</option>`)
          .join("")}
      </select>
      <button class="btn btn-quiet" id="ctEdit">编辑</button>
    </div>`;

  $("#ctStatus").addEventListener("change", async (e) => {
    try {
      await Store.updateTicket(t.id, { status: e.target.value, note: "在工单详情条修改状态" });
      renderTickets();
      renderCurrentTicket();
      renderKpi();
      toast("状态已更新为「" + STATUS_TEXT[e.target.value] + "」");
    } catch (err) {
      toast("更新失败：" + err.message);
    }
  });

  $("#ctEdit").addEventListener("click", () => openTicketEditor(t.id));
}

/* ============ 弹窗与表单 ============ */
let modalSubmit = null;

function openModal({ title, bodyHTML, okText = "保存", onSubmit }) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHTML;
  $("#modalOk").textContent = okText;
  $("#modalMask").hidden = false;
  $("#modal").hidden = false;
  modalSubmit = onSubmit;
  const first = $("#modalBody input, #modalBody textarea");
  if (first) setTimeout(() => first.focus(), 60);
}

function closeModal() {
  $("#modalMask").hidden = true;
  $("#modal").hidden = true;
  modalSubmit = null;
}

function formError(msg) {
  let el = $("#modalBody .form-error");
  if (!el) {
    el = document.createElement("div");
    el.className = "form-error";
    $("#modalBody").appendChild(el);
  }
  el.textContent = msg;
}

const PRI_OPTS = ["P0", "P1", "P2"];
const TAG_POOL = ["账号权限", "审批流", "数据核对", "库存", "费用", "变更管理", "接口"];

function openTicketEditor(id) {
  const t = id ? Store.tickets.find((x) => x.id === id) : null;
  const v = t || { title: "", from: "", pri: "P1", desc: "" };
  openModal({
    title: t ? "编辑工单 " + t.id : "新建工单",
    okText: t ? "保存修改" : "创建工单",
    bodyHTML: `
      <div class="form-field">
        <label>问题描述（写业务同事的原话最好）</label>
        <input type="text" id="fTitle" value="${escapeHtml(v.title)}" placeholder="例：新来的业务员登不进金蝶" />
      </div>
      <div class="form-row">
        <div class="form-field">
          <label>提报部门</label>
          <input type="text" id="fFrom" value="${escapeHtml(v.from)}" placeholder="例：厦门经销部" />
        </div>
        <div class="form-field">
          <label>优先级</label>
          <select id="fPri">${PRI_OPTS.map((p) => `<option ${p === v.pri ? "selected" : ""}>${p}</option>`).join("")}</select>
        </div>
      </div>
      <div class="form-field">
        <label>补充说明（选填）</label>
        <textarea id="fDesc" placeholder="影响范围、已经试过哪些操作">${escapeHtml(v.desc || "")}</textarea>
      </div>
      <div class="form-hint">创建后可在右侧让 AI 分诊；每次状态变更都会记进工单的操作记录。</div>`,
    onSubmit: async () => {
      const title = $("#fTitle").value.trim();
      if (!title) {
        formError("问题描述不能为空");
        return false;
      }
      const data = {
        title,
        from: $("#fFrom").value.trim() || "未知部门",
        pri: $("#fPri").value,
        desc: $("#fDesc").value.trim()
      };
      if (t) {
        await Store.updateTicket(t.id, Object.assign({}, data, { note: "编辑了工单内容" }));
        toast("工单已更新");
      } else {
        const created = await Store.createTicket(data);
        Store.currentId = created.id;
        toast("已创建 " + created.id);
      }
      renderTickets();
      renderCurrentTicket();
      renderKpi();
      return true;
    }
  });
}

function openKbEditor() {
  openModal({
    title: "新建知识条目",
    okText: "保存并归档",
    bodyHTML: `
      <div class="form-field">
        <label>标题</label>
        <input type="text" id="kTitle" placeholder="例：经销商对账单导出乱码的处理方法" />
      </div>
      <div class="form-field">
        <label>一句话摘要</label>
        <textarea id="kDesc" placeholder="什么场景下用，关键结论是什么"></textarea>
      </div>
      <div class="form-field">
        <label>标签（可多选）</label>
        <div class="tag-picker" id="kTags">${TAG_POOL.map((t) => `<button type="button" class="tag-opt" data-tag="${t}">${t}</button>`).join("")}</div>
      </div>`,
    onSubmit: async () => {
      const title = $("#kTitle").value.trim();
      if (!title) {
        formError("标题不能为空");
        return false;
      }
      const tags = $$("#kTags .tag-opt.on").map((b) => b.dataset.tag);
      await Store.createKb({ title, desc: $("#kDesc").value.trim(), tags, ai: false });
      renderKb();
      toast("已归档到知识库");
      return true;
    }
  });
  $$("#kTags .tag-opt").forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
}

function openChangeEditor() {
  openModal({
    title: "记录一次发布",
    okText: "记录并归档",
    bodyHTML: `
      <div class="form-row">
        <div class="form-field"><label>版本号</label><input type="text" id="cVer" value="v2.4.2" /></div>
        <div class="form-field"><label>结果</label><select id="cTag"><option>已发布</option><option>已回滚</option></select></div>
      </div>
      <div class="form-field">
        <label>变更内容</label>
        <input type="text" id="cTitle" placeholder="例：OA 报销流程增加兜底审批人" />
      </div>
      <div class="form-field">
        <label>验证项（逗号分隔）</label>
        <input type="text" id="cChecks" placeholder="新增单据验证, 在途单据重算, 财务回归" />
      </div>
      <div class="form-field">
        <label>备注</label>
        <textarea id="cNote" placeholder="发布后观察到的变化"></textarea>
      </div>`,
    onSubmit: async () => {
      const title = $("#cTitle").value.trim();
      if (!title) {
        formError("变更内容不能为空");
        return false;
      }
      const checks = $("#cChecks")
        .value.split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      await Store.createChange({
        version: $("#cVer").value.trim() || "v2.4.2",
        tag: $("#cTag").value,
        title,
        checks,
        note: $("#cNote").value.trim()
      });
      renderChanges();
      toast("发布记录已归档");
      return true;
    }
  });
}

function confirmDeleteTicket(id) {
  const t = Store.tickets.find((x) => x.id === id);
  if (!t) return;
  openModal({
    title: "删除工单 " + id,
    okText: "确认删除",
    bodyHTML: `<p style="font-size:13px;line-height:1.8;color:var(--ink-2)">
      将永久删除「${escapeHtml(t.title)}」及其 ${t.history ? t.history.length : 0} 条操作记录，不可撤销。
    </p>`,
    onSubmit: async () => {
      await Store.deleteTicket(id);
      renderTickets();
      renderCurrentTicket();
      renderKpi();
      toast("工单已删除");
      return true;
    }
  });
}

function renderAskChips() {
  $("#askChips").innerHTML = DATA.askSamples
    .map((s, i) => `<button class="chip" data-ask="${i}">${escapeHtml(s)}</button>`)
    .join("");
  $$("[data-ask]").forEach((c) => {
    c.addEventListener("click", () => {
      $("#askInput").value = DATA.askSamples[Number(c.dataset.ask)];
      runTriage();
    });
  });
}

/* ---- AI 调用 ---- */
const TRIAGE_SYSTEM = `你是安井食品信息化运维团队的资深支持工程师，熟悉金蝶云星空 ERP、OA 审批流与表单配置、CRM 客户与授信、经销商订单与库存业务。
你的任务是把业务人员的大白话求助，转成一份可直接执行的运维分诊结论。
要求：结论专业、步骤可落地、语言克制；不要编造不存在的菜单名，拿不准时给出「如何确认」的动作而不是猜测。
只输出 JSON，不要任何解释文字。`;

function triagePrompt(q) {
  return `请对下面这条来自业务部门的求助做分诊：

"""
${q}
"""

定级标准（必须按此判断，不要自行放宽）：
- P0：影响多部门、月结关账或生产发运，2 小时内必须处理
- P1：阻断某个岗位完成日常业务（如开不了单、报不了销、登不进系统）但未波及全局，4 小时内处理
- P2：不影响业务进行，可排期处理
凡导致用户「今天这件事做不了」的，最低也是 P1。

严格按以下 JSON 结构输出（字段名不可改，不要输出 markdown）：
{
  "category": "必须严格取自这六个之一：账号与权限 / 审批流与表单 / 数据异常核对 / 系统配置 / 接口与集成 / 其他",
  "priority": "只能输出 P0 或 P1 或 P2，不要带其他字",
  "priority_reason": "定级理由，一句话，20 字以内，说明影响面和时限",
  "system": "涉及的系统，如 金蝶云星空 / OA / CRM，10 字以内",
  "impact": "影响面，14 字以内，格式为「数量 · 部门」，如「1 人 · 厦门经销部」「26 人 · 财务共享」，不要写句子，不要写岗位描述",
  "basis": "判断依据，2 句话，说明为什么先怀疑这个原因",
  "steps": [
    { "title": "动作名称，6 到 12 字", "detail": "具体怎么做，40 到 70 字，包含看哪个菜单、判断什么现象" }
  ],
  "reply": "可直接发给提报人的回复话术，60 到 100 字，先给结论再给下一步动作，不要承诺具体工作日"
}
steps 给 3 到 4 步，按排查顺序排列。`;
}

async function callAI({ system, user, json = true }) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, user, json })
  });
  if (!res.ok) throw new Error("http " + res.status);
  return res.json();
}

const CATEGORY_RULES = [
  { val: "账号与权限", kw: ["账号", "权限", "登录", "授权", "密码"] },
  { val: "审批流与表单", kw: ["审批", "流程", "表单", "待办", "报销"] },
  { val: "数据异常核对", kw: ["数据", "核对", "库存", "订单", "金额", "报表", "差异"] },
  { val: "接口与集成", kw: ["接口", "集成", "同步", "对接", "推送"] },
  { val: "系统配置", kw: ["配置", "参数", "基础资料", "字典"] }
];

function normalizeCategory(raw) {
  const c = String(raw || "").trim();
  if (!c) return "其他";
  for (const r of CATEGORY_RULES) if (r.val === c) return c;
  for (const r of CATEGORY_RULES) if (r.kw.some((k) => c.includes(k))) return r.val;
  return c;
}

function clampText(s, max) {
  const t = String(s || "").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function normalizeTriage(raw) {
  const pRaw = String(raw.priority || "P2");
  const m = pRaw.match(/P[0-3]/i);
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : [];

  let system = raw.system || "";
  let impact = raw.impact || "";
  if (!impact && raw.scope) {
    if (typeof raw.scope === "string") {
      const parts = raw.scope.split(/[·|]/).map((s) => s.trim());
      impact = parts[0] || "";
      system = system || parts[1] || "";
    } else if (typeof raw.scope === "object") {
      impact = raw.scope.impact || "";
      system = system || raw.scope.system || "";
    }
  }

  return {
    category: normalizeCategory(raw.category),
    priority: m ? m[0].toUpperCase() : "P2",
    priorityNote: clampText(raw.priority_reason, 26),
    system: clampText(system, 14) || "业务系统",
    impact: clampText(impact, 16) || "待确认",
    basis: raw.basis || "",
    steps: stepsRaw.map((s) =>
      typeof s === "string" ? { t: s, d: "" } : { t: s.title || s.t || "", d: s.detail || s.d || "" }
    ),
    reply: raw.reply || ""
  };
}

let triageBusy = false;

async function runTriage() {
  const q = $("#askInput").value.trim();
  if (!q) {
    $("#askInput").focus();
    toast("先描述一下问题");
    return;
  }
  if (triageBusy) return;
  triageBusy = true;

  const slot = $("#triageResult");
  const btn = $("#askBtn");
  btn.disabled = true;
  slot.innerHTML = `<div class="thinking"><i></i><i></i><i></i><span>正在读取问题、匹配历史工单与知识库…</span></div>`;

  const started = Date.now();
  let result = null;
  let source = "fallback";

  try {
    const resp = await callAI({ system: TRIAGE_SYSTEM, user: triagePrompt(q), json: true });
    if (resp.ok && resp.content) {
      const parsed = JSON.parse(resp.content);
      result = normalizeTriage(parsed);
      source = "live";
    } else if (resp.reason === "no_key") {
      source = "no_key";
    }
  } catch (err) {
    console.warn("AI 调用失败，使用演示答案", err);
    source = "error";
  }

  if (!result) {
    const preset = matchPreset(q);
    result = normalizeTriage(preset);
    if (source !== "no_key") source = "fallback";
    await sleep(Math.max(0, 900 - (Date.now() - started)));
  }

  renderTriage(slot, result, source);
  btn.disabled = false;
  triageBusy = false;
}

function matchPreset(q) {
  let best = DATA.triageFallback[0];
  let bestScore = -1;
  const groups = [
    ["账号", "登录", "登不进", "授权", "密码", "金蝶", "权限"],
    ["报销", "审批", "待办", "流程", "审批人"],
    ["库存", "出库", "台账", "差异", "数量", "对不上"]
  ];
  groups.forEach((words, i) => {
    const score = words.reduce((acc, w) => acc + (q.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = DATA.triageFallback[i];
    }
  });
  return best;
}

async function renderTriage(slot, r, source) {
  const hot = r.priority === "P0" || r.priority === "P1";
  slot.innerHTML = `
    <div class="triage-head">
      <div class="triage-cell">
        <span>问题分类</span>
        <b>${escapeHtml(r.category)}</b>
        <em>${escapeHtml(r.system)}</em>
      </div>
      <div class="triage-cell ${hot ? "hot" : ""}">
        <span>优先级</span>
        <b>${escapeHtml(r.priority)}</b>
        <em>${escapeHtml(r.priorityNote || (hot ? "影响业务进行" : "可排期处理"))}</em>
      </div>
      <div class="triage-cell">
        <span>影响面</span>
        <b>${escapeHtml(r.impact)}</b>
        <em>${escapeHtml(r.system)}</em>
      </div>
    </div>

    <div class="block-title">判断依据</div>
    <p class="basis">${escapeHtml(r.basis)}</p>

    <div class="block-title">处理路径</div>
    <ol class="steps" id="stepList"></ol>

    <div class="block-title">回复话术</div>
    <div class="reply-box" id="replyBox" style="opacity:0">${escapeHtml(r.reply)}</div>

    <div class="reply-foot" id="replyFoot" style="opacity:0">
      <button class="btn btn-primary" id="adoptBtn">采纳并关闭工单</button>
      <button class="btn btn-ghost" id="saveKbBtn">沉淀为知识</button>
      <button class="btn btn-quiet" id="forwardBtn">转派二线</button>
      <button class="btn btn-quiet" id="copyReply">复制话术</button>
      <span class="source-tag ${source === "live" ? "is-live" : ""}">
        ${source === "live" ? "由 deepseek-chat 实时生成" : source === "no_key" ? "演示答案 · 未配置模型 Key" : "演示答案 · 模型未连通"} · 需人工确认
      </span>
    </div>`;

  const list = $("#stepList");
  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i];
    const li = document.createElement("li");
    li.className = "step-item";
    li.style.animationDelay = "0ms";
    li.innerHTML = `<span class="step-no">${i + 1}</span>
      <div class="step-body"><b>${escapeHtml(s.t)}</b><span>${escapeHtml(s.d)}</span></div>`;
    list.appendChild(li);
    await sleep(150);
  }

  await sleep(120);
  $("#replyBox").style.transition = "opacity .35s ease";
  $("#replyBox").style.opacity = "1";
  $("#replyFoot").style.transition = "opacity .35s ease";
  $("#replyFoot").style.opacity = "1";

  $("#copyReply").addEventListener("click", () => copyText(r.reply, "话术已复制"));

  $("#adoptBtn").addEventListener("click", async () => {
    const cur = Store.current();
    if (!cur) {
      toast("先在左侧选中一条工单");
      return;
    }
    try {
      await Store.updateTicket(cur.id, {
        status: "done",
        note: "采纳 AI 分诊结论（" + r.category + " / " + r.priority + "），关闭工单"
      });
      renderTickets();
      renderCurrentTicket();
      renderKpi();
      toast(cur.id + " 已标记为已解决");
    } catch (err) {
      toast("操作失败：" + err.message);
    }
  });

  $("#saveKbBtn").addEventListener("click", async () => {
    const cur = Store.current();
    const base = cur ? cur.title : r.category;
    try {
      await Store.createKb({
        title: base.slice(0, 26) + " —— 处理路径",
        desc: r.basis,
        tags: [r.category.replace(/与.*$/, ""), "工单沉淀"],
        ai: true,
        doc: {
          sections: [
            { h: "适用场景", p: r.basis, type: "p" },
            { h: "操作步骤", type: "ol", items: r.steps.map((s) => s.t + "：" + s.d) },
            { h: "可直接回复的话术", p: r.reply, type: "p" }
          ]
        }
      });
      renderKb();
      toast("已沉淀到知识库");
    } catch (err) {
      toast("沉淀失败：" + err.message);
    }
  });

  $("#forwardBtn").addEventListener("click", async () => {
    const cur = Store.current();
    if (!cur) {
      toast("先在左侧选中一条工单");
      return;
    }
    try {
      await Store.updateTicket(cur.id, { status: "doing", note: "转派给二线开发组" });
      renderTickets();
      renderCurrentTicket();
      renderKpi();
      toast("已转派，状态改为处理中");
    } catch (err) {
      toast("操作失败：" + err.message);
    }
  });
}

/* ============ 数据核对 ============ */
function highlightSQL(sql) {
  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return "\u0001" + (tokens.length - 1) + "\u0001";
  };

  let s = escapeHtml(sql);
  s = s.replace(/(--[^\n]*)/g, (m) => stash(`<span class="cm">${m}</span>`));
  s = s.replace(/(&#39;[^&]*?&#39;)/g, (m) => stash(`<span class="str">${m}</span>`));

  const KW = /\b(WITH|SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP\s+BY|ORDER\s+BY|HAVING|AS|AND|OR|NOT|NULLIF|COUNT|SUM|MIN|MAX|ROUND|ABS|DATEDIFF|DATEADD|GETDATE|DESC|ASC|NULL|IS|IN|CASE|WHEN|THEN|ELSE|END)\b/g;
  s = s.replace(KW, '<span class="kw">$1</span>');
  s = s.replace(/(?<![\u0001\d])\b(\d+(?:\.\d+)?)\b(?![\u0001])/g, '<span class="num">$1</span>');

  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => tokens[Number(i)]);
}

function matchCase(text) {
  const t = text.trim();
  if (!t) return null;
  let best = null;
  let bestScore = 0;
  const dict = {
    dealer: ["经销商", "订单", "金额", "环比", "上月", "差异"],
    approval: ["审批", "报销", "待办", "没走完", "停留", "卡住"],
    duplicate: ["重复", "两次", "多次", "入账"]
  };
  Object.keys(dict).forEach((key) => {
    const score = dict[key].reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = DATA.sqlCases.find((c) => c.key === key);
    }
  });
  return bestScore >= 2 ? best : null;
}

let sqlBusy = false;
let currentSql = "";

async function runSql() {
  const q = $("#sqlInput").value.trim();
  if (!q) {
    $("#sqlInput").focus();
    toast("先描述要核对什么");
    return;
  }
  if (sqlBusy) return;
  sqlBusy = true;
  $("#sqlBtn").disabled = true;

  const c = matchCase(q);

  $("#sqlMeta").textContent = "正在生成语句…";
  $("#sqlCode").innerHTML = `<span class="cm">-- 正在解析问句…</span>`;
  $("#sqlTable").innerHTML = `<div class="thinking"><i></i><i></i><i></i><span>定位数据表、拼装核对口径…</span></div>`;
  $("#resultMeta").textContent = "演示原型不连接数据库，只生成可执行语句";

  let sqlText = "";
  let note = "";
  let fromAI = false;

  if (c) {
    sqlText = c.sql;
    note = c.note;
    await sleep(520);
  } else {
    try {
      const resp = await callAI({
        system:
          "你是熟悉金蝶云星空报表结构的数据分析师。根据业务问题写出一条可直接执行的 SQL Server 查询，只用 SELECT，不要输出注释以外的解释。返回 JSON：{\"sql\":\"...\",\"note\":\"一句话说明口径\"}",
        user:
          "可用表：fact_order(order_no, dealer_code, order_date, amount, status, post_date)、dim_dealer(dealer_code, dealer_name, region, credit_limit)、oa_flow_instance(doc_no, doc_type, amount, applicant_id, dept_name, node_name, node_enter_time, state)。\n\n问题：" +
          q,
        json: true
      });
      if (resp.ok && resp.content) {
        const parsed = JSON.parse(resp.content);
        sqlText = (parsed.sql || "").trim();
        note = parsed.note || "";
        fromAI = true;
      }
    } catch (err) {
      console.warn(err);
    }
  }

  if (!sqlText) {
    $("#sqlCode").innerHTML =
      `<span class="cm">-- 当前没有可用的语句</span>\n<span class="cm">-- 可以点上面的示例问题，或配置 .env 里的 DEEPSEEK_API_KEY 让模型现场生成</span>`;
    $("#sqlMeta").textContent = "未生成";
    $("#sqlTable").innerHTML = `<div class="empty-state">
      <div class="empty-glyph"></div>
      <p>没有拿到语句</p>
      <span>点上面任一示例问题，直接看现成的核对语句</span>
    </div>`;
    $("#sqlBtn").disabled = false;
    sqlBusy = false;
    return;
  }

  currentSql = sqlText;
  $("#sqlMeta").textContent = (fromAI ? "由模型生成" : "预设核对语句") + (note ? " · " + note : "");
  $("#sqlCode").innerHTML = highlightSQL(sqlText);
  renderSqlBrief(sqlText, note, fromAI);

  $("#sqlBtn").disabled = false;
  sqlBusy = false;
}

/* 结果区不放假表格，改成语句说明 —— 不假装执行过 */
function renderSqlBrief(sql, note, fromAI) {
  const lineCount = sql.split("\n").length;

  /* 优先匹配已知业务表，避免把 CTE 名（cur / prev）当成表 */
  const KNOWN = ["fact_order", "dim_dealer", "oa_flow_instance", "dim_user"];
  let tables = KNOWN.filter((t) => new RegExp("\\b(?:from|join)\\s+" + t + "\\b", "i").test(sql));
  if (!tables.length) {
    tables = Array.from(
      new Set(
        (sql.match(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi) || []).map((m) =>
          m.replace(/\b(from|join)\s+/i, "").toLowerCase()
        )
      )
    );
  }

  $("#resultMeta").textContent = "只读查询 · 可复制到生产库执行";
  $("#sqlTable").innerHTML = `
    <div class="brief">
      <div class="brief-row">
        <span class="brief-k">核对口径</span>
        <p>${escapeHtml(note || "按问题自动生成的核对语句。")}</p>
      </div>
      <div class="brief-row">
        <span class="brief-k">涉及数据表</span>
        <div class="brief-tags">${tables.map((t) => `<code>${escapeHtml(t)}</code>`).join("") || "<code>—</code>"}</div>
      </div>
      <div class="brief-row">
        <span class="brief-k">语句规模</span>
        <p>${lineCount} 行 · 仅 SELECT / WITH，不含任何写操作</p>
      </div>
      <div class="brief-row">
        <span class="brief-k">下一步</span>
        <p>复制到生产库或报表工具执行；结果里的异常行仍需业务方确认，不自动处理。</p>
      </div>
      ${
        fromAI
          ? '<p class="brief-note">这句由模型按表结构现场生成，首次执行前建议先看一次执行计划。</p>'
          : ""
      }
    </div>`;
}

function renderSqlChips() {
  $("#sqlChips").innerHTML = DATA.sqlCases
    .map((c, i) => `<button class="chip" data-sql="${i}">${escapeHtml(c.question)}</button>`)
    .join("");
  $$("[data-sql]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#sqlInput").value = DATA.sqlCases[Number(btn.dataset.sql)].question;
      runSql();
    });
  });
}

/* ============ 知识库 ============ */
function renderKb() {
  const box = $("#kbPanel");

  if (!Store.kb.length) {
    box.innerHTML = `<div class="kb-empty">
      <b>还没有知识条目</b>
      <span>点右上角「新建条目」，或在工单分诊结果里点「沉淀为知识」。</span>
    </div>`;
    return;
  }

  box.innerHTML = Store.kb
    .map(
      (k) => `
    <div class="kb-card" data-kb="${k.id}">
      <button class="kb-del" data-kbdel="${k.id}" title="删除条目">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
      <div class="kb-tags">
        ${(k.tags || []).map((t) => `<span class="kb-tag">${escapeHtml(t)}</span>`).join("")}
        ${k.ai ? '<span class="kb-tag ai">AI 已校订</span>' : ""}
      </div>
      <h3>${escapeHtml(k.title)}</h3>
      <p>${escapeHtml(k.desc)}</p>
      <div class="kb-foot">
        <span>被引用 ${k.refs || 0} 次</span>
        <span>更新 ${escapeHtml(k.updated || "")}</span>
        <em>查看 →</em>
      </div>
    </div>`
    )
    .join("");

  $$("[data-kb]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-kbdel]")) return;
      const k = Store.kb.find((x) => x.id === card.dataset.kb);
      if (k) openKb(k);
    });
  });

  $$("[data-kbdel]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const k = Store.kb.find((x) => x.id === btn.dataset.kbdel);
      if (!k) return;
      openModal({
        title: "删除知识条目",
        okText: "确认删除",
        bodyHTML: `<p style="font-size:13px;line-height:1.8;color:var(--ink-2)">将删除「${escapeHtml(
          k.title
        )}」，此操作不可撤销。</p>`,
        onSubmit: async () => {
          await Store.deleteKb(k.id);
          renderKb();
          toast("条目已删除");
          return true;
        }
      });
    });
  });
}

function docToHtml(doc) {
  return doc.sections
    .map((sec) => {
      let h = `<h3>${escapeHtml(sec.h)}</h3>`;
      if (sec.type === "p") h += `<p>${sec.p}</p>`;
      if (sec.type === "ol") h += `<ol>${sec.items.map((i) => `<li>${i}</li>`).join("")}</ol>`;
      if (sec.type === "ul") h += `<ul>${sec.items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
      return h;
    })
    .join("");
}

function docToText(doc) {
  return doc.sections
    .map((sec) => {
      const head = sec.h + "\n" + "-".repeat(20);
      if (sec.type === "p") return head + "\n" + sec.p.replace(/<[^>]+>/g, "");
      if (sec.type === "ol" || sec.type === "ul") {
        return head + "\n" + sec.items.map((i, n) => `${sec.type === "ol" ? n + 1 + ". " : "· "}${i.replace(/<[^>]+>/g, "")}`).join("\n");
      }
      return head;
    })
    .join("\n\n");
}

function openKb(k) {
  openDrawer({
    tag: "操作手册",
    title: k.title,
    bodyHTML: `<div class="doc">${docToHtml(k.doc)}<p class="doc-note">本手册由历史工单与人工复核共同沉淀，最近一次校订 ${k.updated}，被引用 ${k.refs} 次。</p></div>`,
    primary: "归档到知识库",
    onPrimary: () => toast("已归档，并生成一条待复核记录"),
    copyText: docToText(k.doc)
  });
}

function renderChanges() {
  const box = $("#changePanel");
  if (!Store.changes.length) {
    box.innerHTML = `<div class="kb-empty"><b>还没有发布记录</b><span>点右上角「记录发布」补一条。</span></div>`;
    return;
  }
  box.innerHTML = Store.changes
    .map(
      (c) => `
    <div class="tl-row">
      <div class="tl-date"><b>${escapeHtml(c.date)}</b>${escapeHtml(c.version)}</div>
      <div class="tl-body">
        <h3>${escapeHtml(c.title)}
          <span class="tag" style="${c.tag === "已回滚" ? "color:var(--red);border-color:var(--red-line);background:var(--red-soft)" : ""}">${escapeHtml(c.tag)}</span>
        </h3>
        <div class="tl-checks">
          ${(c.checks || [])
            .map((x) => `<span class="tl-check"><i style="${c.tag === "已回滚" ? "background:var(--ink-3)" : ""}"></i>${escapeHtml(x)}</span>`)
            .join("")}
        </div>
        <div class="tl-note">${escapeHtml(c.note || "")}</div>
        <div class="tl-note" style="font-size:11px">发布人 · ${escapeHtml(c.by || "")}</div>
      </div>
    </div>`
    )
    .join("");
}

function initKbTabs() {
  $$("#kbTabs button").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#kbTabs button").forEach((x) => x.classList.toggle("is-active", x === b));
      const isKb = b.dataset.tab === "kb";
      $("#kbPanel").hidden = !isKb;
      $("#changePanel").hidden = isKb;
      $("#newKbBtn").textContent = isKb ? "新建条目" : "记录发布";
    });
  });
}

/* ============ 抽屉 ============ */
let drawerOnPrimary = null;
let drawerCopyText = "";

function openDrawer({ tag, title, bodyHTML, primary, onPrimary, copyText }) {
  $("#drawerTag").textContent = tag;
  $("#drawerTitle").textContent = title;
  $("#drawerBody").innerHTML = bodyHTML;
  $("#drawerDone").textContent = primary || "完成";
  $("#drawerCopy").hidden = !copyText;
  drawerCopyText = copyText || "";
  drawerOnPrimary = onPrimary || null;
  $("#drawerMask").hidden = false;
  $("#drawer").hidden = false;
}

function closeDrawer() {
  $("#drawerMask").hidden = true;
  $("#drawer").hidden = true;
  drawerOnPrimary = null;
}

/* ============ 讲述模式 ============ */
let storyIndex = 0;

function openStory() {
  storyIndex = 0;
  $("#story").hidden = false;
  renderStory();
}

function closeStory() {
  $("#story").hidden = true;
}

function renderStory() {
  const s = DATA.story[storyIndex];
  $("#storyBody").innerHTML = `
    <div class="story-index">${escapeHtml(s.index)}</div>
    <h1>${s.title}</h1>
    <p class="story-lead">${escapeHtml(s.lead)}</p>
    <div class="story-points">
      ${s.points
        .map(
          (p, i) =>
            `<div class="story-point" style="animation-delay:${i * 70}ms"><b>${escapeHtml(p.b)}</b><span>${escapeHtml(p.s)}</span></div>`
        )
        .join("")}
    </div>`;
  $("#storyProgress").textContent = `${storyIndex + 1} / ${DATA.story.length}`;
  $("#storyDots").innerHTML = DATA.story
    .map((_, i) => `<i class="${i === storyIndex ? "on" : ""}"></i>`)
    .join("");
  $$(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.route === "story"));
}

function initStoryKeys() {
  document.addEventListener("keydown", (e) => {
    const storyOpen = !$("#story").hidden;
    const cmdkOpen = !$("#cmdk").hidden;

    if (e.key === "Escape") {
      if (cmdkOpen) return closeCmdk();
      if (storyOpen) {
        closeStory();
        setRoute("dashboard");
        return;
      }
      if (!$("#modal").hidden) return closeModal();
      if (!$("#drawer").hidden) return closeDrawer();
    }

    if (cmdkOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveCmdkSelection(e.key === "ArrowDown" ? 1 : -1);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        activateCmdk();
      }
      return;
    }

    if (storyOpen) {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        if (storyIndex < DATA.story.length - 1) {
          storyIndex++;
          renderStory();
        }
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (storyIndex > 0) {
          storyIndex--;
          renderStory();
        }
      }
    }
  });
}

/* ============ 命令面板 ============ */
let cmdkIndex = 0;
let cmdkFiltered = [];

function openCmdk() {
  $("#cmdkMask").hidden = false;
  $("#cmdk").hidden = false;
  $("#cmdkInput").value = "";
  cmdkIndex = 0;
  renderCmdk("");
  setTimeout(() => $("#cmdkInput").focus(), 30);
}

function closeCmdk() {
  $("#cmdkMask").hidden = true;
  $("#cmdk").hidden = true;
}

function buildCmdkPool() {
  const pages = DATA.cmdkItems.map((p) => ({ label: p.label, route: p.route, kind: p.kind }));
  const tickets = DATA.tickets.slice(0, 6).map((t) => ({ label: t.title, route: "tickets", kind: t.id, ticket: t.id }));
  return pages.concat(tickets);
}

function renderCmdk(q) {
  const pool = buildCmdkPool();
  cmdkFiltered = q ? pool.filter((i) => i.label.includes(q) || i.kind.includes(q)) : pool.slice(0, 7);
  if (!cmdkFiltered.length) {
    $("#cmdkList").innerHTML = `<div class="cmdk-empty" style="padding:20px;text-align:center;color:var(--ink-3);font-size:12.5px">没有匹配项</div>`;
    return;
  }
  $("#cmdkList").innerHTML =
    `<div class="cmdk-group">跳转与查找</div>` +
    cmdkFiltered
      .map(
        (i, idx) => `<button class="cmdk-item ${idx === cmdkIndex ? "is-sel" : ""}" data-cmdk="${idx}">
          <span>${escapeHtml(i.label)}</span>
          <span class="kind">${escapeHtml(i.kind)}</span>
        </button>`
      )
      .join("");
  $$("[data-cmdk]").forEach((b) => {
    b.addEventListener("click", () => {
      cmdkIndex = Number(b.dataset.cmdk);
      activateCmdk();
    });
  });
}

function moveCmdkSelection(dir) {
  if (!cmdkFiltered.length) return;
  cmdkIndex = (cmdkIndex + dir + cmdkFiltered.length) % cmdkFiltered.length;
  $$("[data-cmdk]").forEach((b) => b.classList.toggle("is-sel", Number(b.dataset.cmdk) === cmdkIndex));
}

function activateCmdk() {
  const item = cmdkFiltered[cmdkIndex];
  if (!item) return;
  closeCmdk();
  setRoute(item.route);
  if (item.ticket) {
    selectTicket(item.ticket);
    const t = DATA.tickets.find((x) => x.id === item.ticket);
    if (t) $("#askInput").value = t.title;
  }
}

function initCmdk() {
  $("#searchTrigger").addEventListener("click", openCmdk);
  $("#cmdkMask").addEventListener("click", closeCmdk);
  $("#cmdkInput").addEventListener("input", (e) => {
    cmdkIndex = 0;
    renderCmdk(e.target.value.trim());
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#cmdk").hidden ? openCmdk() : closeCmdk();
    }
  });

  if (!/Mac/i.test(navigator.platform)) {
    $("#kbdHint").textContent = "Ctrl K";
  } else {
    $("#kbdHint").textContent = "⌘ K";
  }
}

/* ============ AI 状态 ============ */
async function checkAI() {
  const el = $("#aiState");
  const txt = $("#aiStateText");
  try {
    const res = await fetch("/api/status");
    const s = await res.json();
    AI_STATE = s.ai;
    if (s.ai === "live") {
      el.classList.add("is-live");
      txt.textContent = "已连接 " + s.model;
    } else {
      txt.textContent = "演示答案模式";
    }
  } catch {
    txt.textContent = "静态版 · 演示答案";
  }
}

/* ============ 初始化 ============ */
async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get("noanim") === "1") document.body.classList.add("no-anim");

  initNav();
  await Store.init();

  renderKpi();
  renderTrend();
  renderDonut();
  renderRisks();
  renderTickets();
  renderCurrentTicket();
  renderAskChips();
  renderSqlChips();
  renderKb();
  renderChanges();
  initKbTabs();
  initStoryKeys();
  initCmdk();
  checkAI();

  const today = new Date();
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][today.getDay()];
  const headSub = $("#view-dashboard .page-head p");
  if (headSub) {
    headSub.textContent = `${today.getMonth() + 1} 月 ${today.getDate()} 日 ${week} · 金蝶云星空、OA、CRM 三大系统运行平稳`;
  }

  $("#askBtn").addEventListener("click", runTriage);
  $("#askInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runTriage();
    }
  });

  $("#sqlBtn").addEventListener("click", runSql);
  $("#sqlInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSql();
  });
  $("#copySql").addEventListener("click", () => {
    const text = $("#sqlCode").textContent;
    if (text && !text.includes("输入问题后")) copyText(text, "SQL 已复制");
  });

  $("#exportBtn").addEventListener("click", () => toast("周报已生成，含 5 项指标与 3 条改进建议"));

  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerMask").addEventListener("click", closeDrawer);
  $("#drawerDone").addEventListener("click", () => {
    if (drawerOnPrimary) drawerOnPrimary();
    else toast("已归档");
  });
  $("#drawerCopy").addEventListener("click", () => {
    if (drawerCopyText) copyText(drawerCopyText, "全文已复制");
  });

  $("#story").addEventListener("click", (e) => {
    if (e.target.id === "story") {
      closeStory();
      setRoute("dashboard");
    }
  });

  /* ---- 增删改查入口 ---- */
  $("#newTicketBtn").addEventListener("click", () => openTicketEditor(null));

  $("#newKbBtn").addEventListener("click", () => {
    const tab = $("#kbTabs .is-active");
    if (tab && tab.dataset.tab === "changes") openChangeEditor();
    else openKbEditor();
  });

  $("#resetBtn").addEventListener("click", () => {
    openModal({
      title: "重置演示数据",
      okText: "确认重置",
      bodyHTML: `<p style="font-size:13px;line-height:1.8;color:var(--ink-2)">
        会把工单、知识库、变更记录恢复成初始状态，你新增或修改的内容会全部丢失。
      </p>`,
      onSubmit: async () => {
        await Store.reset();
        renderKpi();
        renderTickets();
        renderCurrentTicket();
        renderKb();
        renderChanges();
        toast("已恢复初始数据");
        return true;
      }
    });
  });

  $$("#statusFilter button").forEach((b) => {
    b.addEventListener("click", () => {
      Store.filter = b.dataset.status;
      renderTickets();
    });
  });

  $("#ticketItems").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit]");
    if (edit) {
      openTicketEditor(edit.dataset.edit);
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      confirmDeleteTicket(del.dataset.del);
      return;
    }
    const row = e.target.closest(".ticket");
    if (row) selectTicket(row.dataset.id);
  });

  $("#modalOk").addEventListener("click", async () => {
    if (!modalSubmit) return;
    const btn = $("#modalOk");
    btn.disabled = true;
    try {
      const ok = await modalSubmit();
      if (ok !== false) closeModal();
    } catch (err) {
      formError(err.message || "操作失败");
    } finally {
      btn.disabled = false;
    }
  });
  $("#modalCancel").addEventListener("click", closeModal);
  $("#modalClose").addEventListener("click", closeModal);
  $("#modalMask").addEventListener("click", closeModal);

  $("#triageResult").innerHTML = `
    <div class="triage-empty">
      <b>等待一条真实问题</b>
      业务同事怎么说的，就怎么贴进来；也可以点上面的示例，看完整的分诊过程。
    </div>`;

  const initial = location.hash.replace("#", "");
  if (initial === "story") {
    openStory();
  } else if (ROUTE_NAME[initial]) {
    setRoute(initial);
  }

  const params2 = new URLSearchParams(location.search);
  if (params2.get("ask") === "1") {
    setRoute("tickets");
    $("#askInput").value = DATA.askSamples[0];
    runTriage();
  } else if (params2.get("run") === "1") {
    setRoute("sql");
    $("#sqlInput").value = DATA.sqlCases[0].question;
    runSql();
  } else if (params2.get("panel") === "new") {
    setRoute("tickets");
    openTicketEditor(null);
  } else if (params2.get("panel") === "kb") {
    setRoute("knowledge");
    openKbEditor();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => console.error("[init] 失败", err));
});
