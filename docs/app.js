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
  $("#kpiGrid").innerHTML = DATA.kpi
    .map(
      (k) => `
    <div class="kpi">
      <div class="kpi-label">${escapeHtml(k.label)}</div>
      <div class="kpi-value">${escapeHtml(k.value)}<small>${escapeHtml(k.unit)}</small></div>
      <div class="kpi-delta ${k.tone === "good" ? "is-good" : "is-warn"}">
        <span>${escapeHtml(k.delta.split(" ")[0])}</span>
        <b>${escapeHtml(k.delta.split(" ").slice(1).join(" "))}</b>
      </div>
      ${sparkline(k.spark, k.tone)}
    </div>`
    )
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
      const t = DATA.tickets.find((x) => x.id === b.dataset.risk);
      setRoute("tickets");
      if (t) {
        selectTicket(t.id);
        $("#askInput").value = t.title;
      }
    });
  });
}

/* ============ 工单台 ============ */
function renderTickets() {
  $("#ticketItems").innerHTML = DATA.tickets
    .map(
      (t) => `
    <button class="ticket" data-id="${t.id}">
      <div class="ticket-top">
        <span class="pri pri-${t.pri.toLowerCase()}">${t.pri}</span>
        <span class="ticket-id">${t.id}</span>
      </div>
      <div class="ticket-title">${escapeHtml(t.title)}</div>
      <div class="ticket-meta">${escapeHtml(t.from)} <i>·</i> ${escapeHtml(t.time)}</div>
    </button>`
    )
    .join("");

  $("#ticketCount").textContent = DATA.tickets.length;

  $$(".ticket").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectTicket(btn.dataset.id);
      const t = DATA.tickets.find((x) => x.id === btn.dataset.id);
      if (t) $("#askInput").value = t.title;
    });
  });
}

function selectTicket(id) {
  $$(".ticket").forEach((b) => b.classList.toggle("is-active", b.dataset.id === id));
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
      <button class="btn btn-ghost" id="forwardBtn">转派二线</button>
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
  $("#adoptBtn").addEventListener("click", () => toast("已采纳，工单 WX-2481 标记为已解决"));
  $("#forwardBtn").addEventListener("click", () => toast("已转派给二线开发组"));
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
let currentCase = null;

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
  currentCase = c;

  if (c) {
    $("#sqlMeta").textContent = "根据自然语言生成 · " + c.note;
    $("#sqlCode").innerHTML = `<span class="cm">-- 正在生成…</span>`;
    $("#sqlTable").innerHTML = `<div class="thinking"><i></i><i></i><i></i><span>解析问句、定位数据表、生成核对语句…</span></div>`;
    $("#resultMeta").textContent = "演示数据 · 未连接生产库";

    await sleep(620);
    $("#sqlCode").innerHTML = highlightSQL(c.sql);
    await sleep(240);
    renderTable(c);
    $("#explainBtn").disabled = false;
  } else {
    $("#sqlMeta").textContent = "自由提问 · 由模型生成，未在演示库执行";
    $("#sqlCode").innerHTML = `<span class="cm">-- 正在生成…</span>`;
    $("#sqlTable").innerHTML = `<div class="thinking"><i></i><i></i><i></i><span>正在理解问句…</span></div>`;

    let sqlText = "";
    let source = "fallback";
    try {
      const resp = await callAI({
        system: "你是熟悉金蝶云星空与 SQL Server 的数据分析师。根据用户问题生成一条可直接执行的 T-SQL 查询，只用 SELECT，不要写注释以外的说明。返回 JSON：{\"sql\":\"...\",\"note\":\"一句话说明口径\"}",
        user: `可用表：fact_order(order_no, dealer_code, order_date, amount, status, post_date)、dim_dealer(dealer_code, dealer_name, region)、oa_flow_instance(doc_no, doc_type, amount, applicant_id, node_name, node_enter_time, state)、dim_user(user_id, dept_name)。\n\n问题：${q}`,
        json: true
      });
      if (resp.ok && resp.content) {
        const parsed = JSON.parse(resp.content);
        sqlText = parsed.sql || "";
        source = "live";
        $("#sqlMeta").textContent = "自由提问 · " + (parsed.note || "由模型生成，未在演示库执行");
        $("#explainBtn").disabled = true;
      }
    } catch (err) {
      console.warn(err);
    }

    $("#sqlCode").innerHTML = sqlText
      ? highlightSQL(sqlText)
      : `<span class="cm">-- 当前未连接模型，无法为自由提问生成 SQL。</span>\n<span class="cm">-- 请点下方示例问题，或配置 .env 中的 DEEPSEEK_API_KEY 后重试。</span>`;

    $("#sqlTable").innerHTML = sqlText
      ? `<div class="empty-state">
           <div class="empty-glyph"></div>
           <p>演示库未连接，语句未执行</p>
           <span>这句话已经可以直接拿到生产库跑；预设的三个示例问题可查看完整结果与异常标注。</span>
         </div>`
      : `<div class="empty-state">
           <div class="empty-glyph"></div>
           <p>暂时没有结果</p>
           <span>点上面任一示例问题，看看完整的核对流程。</span>
         </div>`;
    $("#resultMeta").textContent = sqlText ? "语句已生成 · 未执行（" + (source === "live" ? "模型生成" : "演示") + "）" : "演示数据 · 未连接生产库";
  }

  $("#sqlBtn").disabled = false;
  sqlBusy = false;
}

function renderTable(c) {
  const head = c.cols.map((col) => `<th style="${col.num ? "text-align:right" : ""}">${escapeHtml(col.label)}</th>`).join("");
  const body = c.rows
    .map((row) => {
      const tds = c.cols
        .map((col) => {
          let val = row[col.key];
          if (col.key === "diff" && row.flag) {
            return `<td class="num"><span class="delta-flag" data-tip="${escapeHtml(row.tip || "")}">${escapeHtml(val)}</span></td>`;
          }
          return `<td class="${col.num ? "num" : ""}">${escapeHtml(val)}</td>`;
        })
        .join("");
      return `<tr class="${row.flag ? "anomaly" : ""}">${tds}</tr>`;
    })
    .join("");

  const flagged = c.rows.filter((r) => r.flag).length;
  $("#sqlTable").innerHTML = `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  $("#resultMeta").textContent = `${c.rows.length} 行结果 · ${flagged} 行需要关注 · 演示数据`;

  const firstAnomaly = $("tr.anomaly");
  if (firstAnomaly) {
    firstAnomaly.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
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

async function explainDiff() {
  if (!currentCase) return;
  const c = currentCase;
  openDrawer({
    tag: "差异说明",
    title: "数据核对结论",
    bodyHTML: `<div class="doc"><p style="color:var(--ink-3)">正在整理结论…</p></div>`,
    primary: "复制并归档",
    onPrimary: () => copyText(c.summary, "结论已复制")
  });

  const rowsText = c.rows
    .map((r) => Object.keys(r).filter((k) => k !== "tip" && k !== "flag").map((k) => r[k]).join(" | "))
    .join("\n");

  let content = "";
  try {
    const resp = await callAI({
      system: "你是财务与业务数据核对方面的分析师。根据查询结果写一段可直接进入月度复盘的中文差异说明，客观、给出结论与建议，不要编造数据。返回 JSON：{\"html\":\"<p>...</p>\"}，html 只用 p、ul、li、strong 标签。",
      user: `问题：${c.question}\n口径：${c.note}\n结果（列顺序：${c.cols.map((x) => x.label).join(" | ")}）：\n${rowsText}\n\n异常行的业务解释：\n${c.rows.filter((r) => r.flag).map((r) => "- " + r.tip).join("\n")}`,
      json: true
    });
    if (resp.ok && resp.content) {
      const parsed = JSON.parse(resp.content);
      content = parsed.html || "";
    }
  } catch (err) {
    console.warn(err);
  }

  if (!content) {
    content = `<p>${escapeHtml(c.summary)}</p><p class="doc-note">当前为演示结论，配置模型 Key 后可由 AI 根据实际结果即时生成。</p>`;
  }

  $("#drawerBody").innerHTML = `<div class="doc">${content}</div>`;
}

/* ============ 知识库 ============ */
function renderKb() {
  $("#kbPanel").innerHTML = DATA.kb
    .map(
      (k) => `
    <button class="kb-card" data-kb="${k.id}">
      <div class="kb-tags">
        ${k.tags.map((t) => `<span class="kb-tag">${escapeHtml(t)}</span>`).join("")}
        ${k.ai ? '<span class="kb-tag ai">AI 已校订</span>' : ""}
      </div>
      <h3>${escapeHtml(k.title)}</h3>
      <p>${escapeHtml(k.desc)}</p>
      <div class="kb-foot">
        <span>被引用 ${k.refs} 次</span>
        <span>更新 ${k.updated}</span>
        <em>查看 →</em>
      </div>
    </button>`
    )
    .join("");

  $$("[data-kb]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = DATA.kb.find((x) => x.id === btn.dataset.kb);
      if (k) openKb(k);
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
  $("#changePanel").innerHTML = DATA.changes
    .map(
      (c) => `
    <div class="tl-row">
      <div class="tl-date"><b>${escapeHtml(c.date)}</b>${escapeHtml(c.version)}</div>
      <div class="tl-body">
        <h3>${escapeHtml(c.title)}
          <span class="tag" style="${c.tag === "已回滚" ? "color:var(--red);border-color:var(--red-line);background:var(--red-soft)" : ""}">${escapeHtml(c.tag)}</span>
        </h3>
        <div class="tl-checks">
          ${c.checks.map((x) => `<span class="tl-check"><i style="${c.tag === "已回滚" ? "background:var(--ink-3)" : ""}"></i>${escapeHtml(x)}</span>`).join("")}
        </div>
        <div class="tl-note">${escapeHtml(c.note)}</div>
        <div class="tl-note" style="font-size:11px">发布人 · ${escapeHtml(c.by)}</div>
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
function init() {
  const params = new URLSearchParams(location.search);
  if (params.get("noanim") === "1") document.body.classList.add("no-anim");

  initNav();
  renderKpi();
  renderTrend();
  renderDonut();
  renderRisks();
  renderTickets();
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
  $("#explainBtn").addEventListener("click", explainDiff);
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

  $("#ticketItems").firstElementChild && selectTicket(DATA.tickets[0].id);

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
  }
}

document.addEventListener("DOMContentLoaded", init);
