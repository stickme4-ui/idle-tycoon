"use strict";
const $ = (s) => document.querySelector(s);
let S = null;            // latest state from the server
let settings = null;

const STATUS_HE = {
  waiting: "ממתין לטריגר", armed: "אושר מראש", triggered: "מוכן לביצוע!", executing: "מבצע…", open: "פוזיציה פתוחה",
  closed: "נסגרה", rejected: "נחסמה", expired: "פג תוקף", dismissed: "נדחתה", failed: "נכשלה",
};
const ACTIVE = new Set(["waiting", "armed", "triggered"]);
const STRAT_HE = { orb: "פריצת טווח פתיחה", news: "מומנטום חדשות (ניסיוני)" };
const VERDICT_HE = { take: "מתאים", caution: "בזהירות", skip: "לדלג" };

const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v, d = 2) => v == null ? "--" : (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v) => v == null ? "--" : `<span class="${v >= 0 ? "pos" : "neg"}">${v >= 0 ? "+" : ""}${money(v)}</span>`;
const num = (v, d = 2) => v == null ? "--" : Number(v).toFixed(d);

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 6500);
}

async function api(path, body, method = "POST") {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try { return await r.json(); } catch { return { ok: false, reasons: [`HTTP ${r.status}`] }; }
}

function confirmDialog(title, html, needText = "") {
  return new Promise((resolve) => {
    const d = $("#dlg-confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-body").innerHTML = html;
    const inp = $("#confirm-input");
    inp.hidden = !needText; inp.value = ""; inp.placeholder = needText;
    d.onclose = () => resolve(d.returnValue === "ok" ? (needText ? inp.value : true) : false);
    d.showModal();
  });
}

// ---------------------------------------------------------------- actions
async function act(pid, what) {
  const p = S.proposals.find((x) => x.id === pid);
  if (what === "execute" && S && !S.paper) {
    const side = p.side === "buy" ? "לקנות" : "למכור בחסר";
    const ok = await confirmDialog("ביצוע בכסף אמיתי",
      `<p>${side} <b>${p.qty}</b> מניות <b dir="ltr">${esc(p.symbol)}</b> במחיר שוק (~${num(p.last_price ?? p.entry)}).</p>
       <p>סטופ ב-${num(p.stop)}. סיכון מתוכנן: <b>${money(p.risk_usd)}</b>.</p>`);
    if (!ok) return;
  }
  const r = await api(`/api/proposals/${pid}/${what}`);
  if (r.ok) toast({ execute: "ההזמנה נשלחה ✓", arm: "אושר מראש: יבוצע בטריגר", dismiss: "נדחה", close: "הוראת סגירה נשלחה" }[what], "good");
  else toast("<b>לא בוצע:</b><br>" + (r.reasons || []).map(esc).join("<br>"), "bad");
}

async function setMode(mode) {
  let confirm = "";
  if (mode === "auto") {
    if (S && !S.paper) {
      confirm = await confirmDialog("מצב אוטומטי בכסף אמיתי",
        `<p>הבוט יבצע עסקאות <b>בכסף אמיתי בלי לשאול</b>, בתוך מגבלות הסיכון.</p><p>כדי להמשיך הקלד: <b>אני מבין את הסיכון</b></p>`, "אני מבין את הסיכון");
      if (!confirm) return;
    } else {
      const ok = await confirmDialog("מצב אוטומטי",
        `<p>הבוט יבצע בעצמו הצעות שעוברות את כל הכללים: ציון ≥ ${settings?.auto?.min_score ?? 70}, אישור מנהל הסיכונים, ו-Claude לא המליץ לדלג.</p>
         <p class="muted">זה חשבון ${S?.demo ? "דמו" : "נייר"}: אין כסף אמיתי בסיכון.</p>`);
      if (!ok) return;
    }
  }
  const r = await api("/api/mode", { mode, confirm });
  if (!r.ok) toast((r.reasons || []).map(esc).join("<br>"), "bad");
}

async function kill() {
  if (S.kill) { await api("/api/kill", { on: false }); return; }
  const ok = await confirmDialog("עצירת חירום", `<p>לעצור כניסות חדשות, לחזור למצב ידני, <b>ולסגור את כל הפוזיציות של הבוט</b> במחיר שוק?</p>`);
  if (ok) await api("/api/kill", { on: true, flatten: true });
}

// ---------------------------------------------------------------- render
function proposalCard(p) {
  const long = p.side === "buy";
  const st = p.status;
  const cls = ["card", st === "triggered" ? "triggered" : "", st === "open" ? "open" : "", st === "armed" ? "armed" : "",
    !ACTIVE.has(st) && st !== "open" ? "dim" : ""].join(" ");
  const pnl = st === "open" && p.fill_price && p.last_price ? (p.last_price - p.fill_price) * p.filled_qty * (long ? 1 : -1) : p.pnl;
  let ai = "";
  if (p.ai) {
    ai = `<div class="aibox ${p.ai.verdict}"><b>Claude: ${VERDICT_HE[p.ai.verdict] || p.ai.verdict}</b> <small>(ביטחון ${p.ai.confidence})</small>
      <ul>${p.ai.reasons_he.map((x) => `<li>${esc(x)}</li>`).join("")}${p.ai.risks_he.map((x) => `<li class="neg">${esc(x)}</li>`).join("")}</ul></div>`;
  } else if (p.ai_pending) ai = `<div class="aibox muted">Claude מנתח…</div>`;
  const news = (p.news || []).slice(-2).map((n) => `<div class="newsline">📰 ${esc(n.summary_he || n.headline)}</div>`).join("");
  let buttons = "";
  if (st === "triggered") buttons = `<button class="big ${long ? "buy" : "sell"} pulse" data-a="execute">${long ? "קנה עכשיו" : "שורט עכשיו"}</button><button data-a="dismiss" class="ghost">דחה</button>`;
  else if (st === "waiting") buttons = `<button class="big primary" data-a="arm">אשר לביצוע בטריגר</button><button data-a="execute" class="${long ? "buy" : "sell"}">בצע עכשיו</button><button data-a="dismiss" class="ghost">דחה</button>`;
  else if (st === "armed") buttons = `<button data-a="execute" class="big ${long ? "buy" : "sell"}">בצע עכשיו</button><button data-a="dismiss" class="ghost">בטל</button>`;
  else if (st === "open") buttons = `<button data-a="close" class="big sell">סגור פוזיציה</button>`;
  const parts = Object.entries(p.score_parts || {}).map(([k, v]) => `<span>${esc(k)}</span><span dir="ltr">${v > 0 ? "+" : ""}${v}</span>`).join("");
  const autoLine = S.mode === "auto" && ACTIVE.has(st) ? `<div class="newsline">${p.auto_ok ? "🤖 יבוצע אוטומטית בטריגר" : "🤖 לא יבוצע אוטומטית: " + esc(p.auto_why)}</div>` : "";
  const notes = (p.notes || []).slice(-3).map((n) => `<div class="newsline">• ${esc(n.text)}</div>`).join("");
  return `<article class="${cls}" data-id="${p.id}">
    <div class="card-head">
      <span class="sym">${esc(p.symbol)}</span>
      <span class="chip ${long ? "long" : "short"}">${long ? "קנייה ▲" : "שורט ▼"}</span>
      <span class="chip st-${st}">${STATUS_HE[st] || st}</span>
      <div class="score"><b>${num(p.score, 0)}</b><small>ציון</small></div>
    </div>
    <div class="muted small">${STRAT_HE[p.strategy] || p.strategy} · מחיר אחרון <b dir="ltr">${num(p.last_price)}</b></div>
    <div class="nums">
      <div><small>${p.trigger === "stop" ? "כניסה בפריצה" : "כניסה"}</small><b>${num(p.fill_price ?? p.entry)}</b></div>
      <div><small>סטופ</small><b>${num(p.stop)}</b></div>
      <div><small>יעד</small><b>${p.target ? num(p.target) : "סוף יום"}</b></div>
      <div><small>כמות</small><b>${p.filled_qty || p.qty}</b></div>
      <div><small>סיכון</small><b>${money(p.risk_usd, 0)}</b></div>
      <div><small>שווי</small><b>${money(p.notional, 0)}</b></div>
      <div><small>נפח יחסי</small><b>${num(p.features?.rvol, 1)}×</b></div>
      <div><small>רווח/הפסד</small><b>${pnl == null ? "--" : signed(pnl)}</b></div>
    </div>
    <div class="why">${esc(p.why_he)}</div>
    ${ai}${news}${autoLine}
    <div class="actions">${buttons}</div>
    <details><summary>פירוט הציון והיסטוריה</summary><div class="parts">${parts}</div>${notes}</details>
  </article>`;
}

function render() {
  if (!S) return;
  const b = $("#badge-broker");
  b.className = "badge " + (S.demo ? "demo" : S.paper ? "paper" : "live");
  b.textContent = S.demo ? "דמו" : S.paper ? "חשבון נייר" : "כסף אמיתי";
  const m = $("#badge-market");
  m.className = "badge " + (S.market_open ? "open" : "muted");
  m.textContent = S.market_open ? "השוק פתוח" : "השוק סגור";
  $("#ny-time").textContent = S.ny_time.slice(11, 16) + " · " + S.ny_time.slice(0, 10);
  $("#equity").innerHTML = S.account ? money(S.account.equity) : "--";
  $("#daypnl").innerHTML = S.account ? signed(S.account.day_pnl) : "--";
  $("#mode-manual").classList.toggle("active", S.mode === "manual");
  $("#mode-auto").classList.toggle("active", S.mode === "auto");
  $("#btn-kill").classList.toggle("on", S.kill);
  $("#btn-kill").textContent = S.kill ? "בטל עצירת חירום" : "עצירת חירום";

  const banners = [];
  if (!S.paper) banners.push(`<div class="banner red">⚠ מחובר לחשבון אמיתי. כל ביצוע הוא כסף אמיתי.</div>`);
  if (S.demo) banners.push(`<div class="banner violet">מצב דמו: שוק מדומה עם מניות בדויות, כדי ללמוד את המערכת. לחיבור חשבון ראה README.</div>`);
  if (S.kill) banners.push(`<div class="banner red">מתג החירום פעיל: אין כניסות חדשות.</div>`);
  if (S.risk.halted) banners.push(`<div class="banner amber">המסחר נעצר להיום: ${esc(S.risk.halted)}</div>`);
  if (S.mode === "auto") banners.push(`<div class="banner amber">🤖 מצב אוטומטי פעיל: הבוט מבצע בעצמו הצעות שעוברות את כל הכללים.</div>`);
  $("#banners").innerHTML = banners.join("");

  const showDone = $("#show-done").checked;
  const props = S.proposals.filter((p) => showDone || ACTIVE.has(p.status) || p.status === "open" || p.status === "executing");
  $("#proposals").innerHTML = props.map(proposalCard).join("");
  $("#empty").hidden = props.length > 0;

  $("#positions").innerHTML = S.positions.length ? `<table><tr><th>סימול</th><th>כמות</th><th>ממוצע</th><th>רווח</th></tr>${S.positions.map((x) =>
    `<tr><td dir="ltr">${esc(x.symbol)}</td><td class="ltr">${x.qty}</td><td class="ltr">${num(x.avg)}</td><td class="ltr">${signed(x.pnl)}</td></tr>`).join("")}</table>` : "אין";

  const r = S.risk;
  const usedPct = S.account && r.loss_left != null ? Math.max(0, Math.min(100, 100 - (r.loss_left / Math.max(1, r.loss_left - Math.min(0, S.account.day_pnl))) * 100)) : 0;
  $("#risk").innerHTML = `<div class="kv"><span>עסקאות היום</span><b>${r.entries} / ${r.max_trades}</b>
    <span>רווח ממומש</span><b>${signed(r.realized)}</b><span>מותר להפסיד עוד היום</span><b>${money(r.loss_left, 0)}</b>
    <span>הפסדים ברצף</span><b>${r.consecutive_losses}</b></div><div class="bar"><i style="width:${usedPct}%;background:${usedPct > 70 ? "var(--red)" : "var(--green)"}"></i></div>`;

  const g = S.regime;
  const tone = { risk_on: "<span class='pos'>חיובי (SPY מעל VWAP)</span>", risk_off: "<span class='neg'>שלילי (SPY מתחת ל-VWAP)</span>", flat: "ניטרלי", unknown: "לא ידוע" }[g.tone];
  $("#regime").innerHTML = `<div class="kv"><span>טון</span><b>${tone}</b><span>SPY</span><b dir="ltr">${num(g.spy)}</b><span>שינוי היום</span><b dir="ltr">${g.spy_change_pct == null ? "--" : g.spy_change_pct + "%"}</b><span>מניות בסריקה</span><b>${S.universe}</b></div>`;

  $("#ai").innerHTML = S.ai.enabled ? `<div class="kv"><span>מודל</span><b dir="ltr">${esc(S.ai.model)}</b><span>קריאות</span><b>${S.ai.calls}</b></div>${S.ai.error ? `<p class="neg small">${esc(S.ai.error)}</p>` : ""}`
    : `<p class="muted small">כבוי: אין ANTHROPIC_API_KEY. הבוט עובד בלי ניתוח Claude (חדשות לפי מילות מפתח).</p>${S.ai.error ? `<p class="neg small">${esc(S.ai.error)}</p>` : ""}`;

  $("#news").innerHTML = S.news.length ? S.news.map((n) => `<div><b dir="ltr">${esc((n.symbols || []).slice(0, 3).join(","))}</b>
     <span class="${n.sentiment > 0.2 ? "pos" : n.sentiment < -0.2 ? "neg" : "muted"}">${n.sentiment > 0 ? "▲" : n.sentiment < 0 ? "▼" : "•"}</span>
     ${esc(n.summary_he || n.headline)} <small>(מהותיות ${num(n.materiality, 1)})</small></div>`).join("") : "<span class='muted'>אין</span>";
  $("#scan").innerHTML = S.scan.length ? S.scan.map((x) => `<div class="${x.in_play ? "" : "muted"}"><b dir="ltr">${esc(x.symbol)}</b> · נפח יחסי ${num(x.rvol, 1)}× ${x.in_play ? "✓" : ""}</div>`).join("") : "<span class='muted'>הסריקה רצה ב-9:35 (ניו יורק)</span>";
  $("#events").innerHTML = S.events.map((e) => `<div class="${e.level}"><small dir="ltr">${e.ts.slice(11, 16)}</small> ${esc(e.text)}</div>`).join("");
  const st = S.stats;
  $("#stats").innerHTML = `<div class="kv"><span>עסקאות</span><b>${st.trades}</b><span>אחוז הצלחה</span><b>${st.win_rate ?? "--"}%</b>
    <span>רווח נקי</span><b>${signed(st.net_pnl)}</b><span>Profit factor</span><b>${st.profit_factor ?? "--"}</b></div>
    <p class="muted small">צריך לפחות 50-100 עסקאות כדי לדעת משהו אמיתי על האסטרטגיה.</p>`;
  $("#demo-panel").hidden = !S.demo;
}

$("#proposals").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-a]");
  if (!btn) return;
  const pid = btn.closest("[data-id]").dataset.id;
  btn.disabled = true;
  act(pid, btn.dataset.a).finally(() => (btn.disabled = false));
});
$("#mode-manual").onclick = () => setMode("manual");
$("#mode-auto").onclick = () => setMode("auto");
$("#btn-kill").onclick = kill;
$("#show-done").onchange = render;

// ---------------------------------------------------------------- settings
async function openSettings() {
  settings = await api("/api/settings", null, "GET");
  const f = $("#settings-form");
  for (const el of f.querySelectorAll("[name]")) {
    const [a, b] = el.name.split(".");
    const v = b ? settings[a]?.[b] : settings[a];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = Array.isArray(v) ? v.join(", ") : (v ?? "");
  }
  $("#dlg-settings").showModal();
}
$("#btn-settings").onclick = openSettings;
$("#settings-save").onclick = async (ev) => {
  ev.preventDefault();
  const out = {};
  for (const el of $("#settings-form").querySelectorAll("[name]")) {
    const [a, b] = el.name.split(".");
    let v = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value;
    if (a === "watchlist") v = String(v).split(/[\s,]+/).filter(Boolean);
    if (a === "orb" && b === "target_r" && (v === 0)) v = null;
    if (b) (out[a] ||= {})[b] = v; else out[a] = v;
  }
  settings = await api("/api/settings", out, "PUT");
  $("#dlg-settings").close();
  toast("ההגדרות נשמרו", "good");
};

// ---------------------------------------------------------------- demo controls
let paused = false;
$("#demo-speed").oninput = (e) => { $("#demo-speed-v").textContent = e.target.value; };
$("#demo-speed").onchange = (e) => api("/api/demo/speed", { speed: Number(e.target.value), paused });
$("#demo-pause").onclick = async () => {
  paused = !paused;
  $("#demo-pause").textContent = paused ? "המשך" : "השהה";
  await api("/api/demo/speed", { speed: Number($("#demo-speed").value), paused });
};

// ---------------------------------------------------------------- live updates
function connect() {
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onmessage = (m) => { S = JSON.parse(m.data); render(); };
  ws.onclose = () => setTimeout(connect, 1500);
}
api("/api/settings", null, "GET").then((x) => (settings = x));
connect();
