const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = { config: null, engine: null, tiktok: null, gifts: [], gta: null, port: 0 };
const dirty = { rules: false, tiers: false, settings: false };

const FALLBACK_GIFTS = ['Rose', 'TikTok', 'Heart Me', 'Finger Heart', 'GG', 'Ice Cream Cone', 'Doughnut', 'Perfume', 'Hand Hearts', 'Hat and Mustache', 'Confetti', 'Sunglasses', 'Corgi', 'Money Gun', 'Swan', 'Galaxy', 'Lion', 'Universe'];
const WEAPONS = ['WEAPON_UNARMED', 'WEAPON_KNIFE', 'WEAPON_BAT', 'WEAPON_MACHETE', 'WEAPON_PISTOL', 'WEAPON_COMBATPISTOL', 'WEAPON_HEAVYPISTOL', 'WEAPON_MICROSMG', 'WEAPON_SMG', 'WEAPON_ASSAULTRIFLE', 'WEAPON_CARBINERIFLE', 'WEAPON_SPECIALCARBINE', 'WEAPON_PUMPSHOTGUN', 'WEAPON_ASSAULTSHOTGUN', 'WEAPON_MG', 'WEAPON_COMBATMG', 'WEAPON_SNIPERRIFLE', 'WEAPON_HEAVYSNIPER', 'WEAPON_MINIGUN', 'WEAPON_RPG', 'WEAPON_GRENADELAUNCHER', 'WEAPON_RAILGUN', 'WEAPON_STUNGUN', 'WEAPON_MOLOTOV'];

const TRIGGERS = { gift: 'מתנה', likes: 'לייקים', follow: 'עוקב חדש', share: 'שיתוף', chat: "פקודת צ'אט" };
const ACTIONS = { spawn: 'שגר אויבים', heal: 'ריפוי', damage: 'נזק לשחקן', killAll: 'השמד את כל האויבים', airstrike: 'תקיפה אווירית', slowmo: 'הילוך איטי', weapon: 'תן נשק לשחקן', launch: 'הקפץ את השחקן', clearQueue: 'נקה תור אויבים', none: 'רק התראה' };
const EFFECTS = { auto: 'אוטומטי', none: 'ללא', pop: 'קטן', burst: 'פיצוץ קונפטי', shockwave: 'גל הדף', boss: 'באנר בוס', heal: 'ריפוי ירוק', nuke: 'פצצה', lightning: 'ברקים' };
const KIND_HE = { gift: 'מתנה', like: 'לייק', follow: 'עוקב', share: 'שיתוף', chat: "צ'אט", system: 'מערכת', manual: 'ידני' };

// ---------- api ----------
async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'on' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = err ? 'err' : ''), 2600);
}

// ---------- websocket ----------
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    const { type, data } = JSON.parse(m.data);
    if (type === 'init') {
      Object.assign(S, { config: data.config, engine: data.engine, tiktok: data.tiktok, gifts: data.gifts || [], gta: data.gta, port: data.port });
      $('#log').innerHTML = '';
      data.log.forEach(addLog);
      renderAll();
    } else if (type === 'engine') { S.engine = data; renderEngine(); }
    else if (type === 'hp') { Object.assign(S.engine || (S.engine = {}), { hp: data.hp, max: data.max, dead: data.dead }); renderHp(); }
    else if (type === 'tiktok') { S.tiktok = data; renderTikTok(); }
    else if (type === 'gifts') { S.gifts = data; renderGiftList(); }
    else if (type === 'config') { S.config = data; renderEditors(); }
    else if (type === 'log') addLog(data);
  };
  ws.onclose = () => { setPill('#pill-tiktok', '', 'השרת לא פועל'); setTimeout(connectWs, 1500); };
}

// ---------- rendering ----------
function setPill(sel, cls, text) { const p = $(sel); p.className = 'pill ' + cls; p.querySelector('span').textContent = text; }

function renderAll() {
  renderTikTok(); renderEngine(); renderGiftList(); renderEditors(); renderOverlayLinks(); renderManual(); renderGta(S.gta);
  if (!$('#username').value) $('#username').value = S.config.tiktok.username || '';
  if (!$('#gta-path').value) $('#gta-path').value = S.config.game.gtaPath || '';
}

function renderTikTok() {
  const t = S.tiktok || {};
  const map = { connected: ['ok', `טיקטוק: @${t.username}`], connecting: ['warn', 'טיקטוק: מתחבר...'], waiting: ['warn', 'טיקטוק: ממתין ללייב'], disconnected: ['', 'טיקטוק: מנותק'] };
  const [cls, txt] = map[t.state] || map.disconnected;
  setPill('#pill-tiktok', cls, txt);
  const msg = $('#conn-msg');
  if (t.state === 'connected') msg.textContent = `מחובר ✔ – ${t.giftCount || 0} מתנות זמינות בחדר. אירועים מהלייב מגיעים עכשיו.`;
  else if (t.state === 'waiting') msg.textContent = `ממתין: ${t.error || ''} – מנסה שוב אוטומטית.`;
  else if (t.state === 'connecting') msg.textContent = 'מתחבר...';
  else if (t.error) msg.textContent = 'שגיאה: ' + t.error;
}

function renderEngine() {
  const e = S.engine;
  if (!e) return;
  setPill('#pill-game', e.game?.connected ? 'ok' : '', e.game?.connected ? 'GTA: מחובר' : 'GTA: לא מחובר');
  renderHp();
  const st = e.stats || {};
  const items = [
    ['לייקים', st.likes], ['מתנות', st.gifts], ['מטבעות', st.coins], ['עוקבים חדשים', st.follows], ['שיתופים', st.shares],
    ['צופים', st.viewers], ['אויבים בחיים', e.alive], ['בתור', e.queue], ['הריגות', e.kills], ['מיתות', e.deaths],
  ];
  $('#stats').innerHTML = items.map(([l, v]) => `<div class="stat"><b>${fmt(v)}</b><span>${l}</span></div>`).join('');
  $('#top').innerHTML = (e.top || []).length
    ? e.top.map((u, i) => `<div class="top-row"><span>#${i + 1}</span>${u.avatar ? `<img src="${esc(u.avatar)}" referrerpolicy="no-referrer">` : '<span class="ph"></span>'}<b>${esc(u.nickname)}</b><span dir="ltr">${fmt(u.coins)} 🪙</span></div>`).join('')
    : '<p class="hint">עוד אין מתנות בלייב הזה.</p>';
}

function renderHp() {
  const e = S.engine;
  if (!e) return;
  const p = e.max ? e.hp / e.max : 0;
  const fill = $('#hp-fill');
  fill.style.width = `${p * 100}%`;
  fill.style.background = p > 0.6 ? 'linear-gradient(#4ade80,#16a34a)' : p > 0.3 ? 'linear-gradient(#fde047,#d97706)' : 'linear-gradient(#fca5a5,#dc2626)';
  $('#hp-text').textContent = e.dead ? 'K.O.' : `${fmt(e.hp)} / ${fmt(e.max)}`;
  $('#pill-hp').textContent = e.dead ? '❤ K.O.' : `❤ ${fmt(e.hp)}`;
}

function addLog(e) {
  const log = $('#log');
  const d = document.createElement('div');
  const time = new Date(e.t || Date.now()).toLocaleTimeString('he-IL', { hour12: false });
  d.innerHTML = `<time>${time}</time><span class="k ${esc(e.kind)}">${KIND_HE[e.kind] || esc(e.kind)}</span>${e.user ? `<b>${esc(e.user)}</b>` : ''}<span>${esc(e.text)}</span>${e.test ? '<span class="test">בדיקה</span>' : ''}`;
  log.prepend(d);
  while (log.children.length > 200) log.lastChild.remove();
}

function renderGiftList() {
  const names = S.gifts.length ? S.gifts.map((g) => `<option value="${esc(g.name)}">${g.diamonds} מטבעות</option>`) : FALLBACK_GIFTS.map((n) => `<option value="${esc(n)}">`);
  $('#gift-list').innerHTML = names.join('');
  $('#weapon-list').innerHTML = WEAPONS.map((w) => `<option value="${w}">`).join('');
}

function renderManual() {
  $('#manual-tiers').innerHTML = S.config.tiers.map((t, i) =>
    `<button class="btn small" dir="ltr" style="border-color:${esc(t.color)}" data-action='${JSON.stringify({ type: 'spawn', tierId: t.id, count: 1 })}'>${i + 1}. ${esc(t.name)}</button>`).join('');
}

// ---------- editors ----------
function renderEditors() {
  if (!dirty.rules) renderRules();
  if (!dirty.tiers) renderTiers();
  if (!dirty.settings) renderSettings();
  renderManual();
}

const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');

function ruleRow(r) {
  const tiers = S.config.tiers.map((t, i) => `<option value="${t.id}" ${t.id === r.action.tierId ? 'selected' : ''}>${i + 1}. ${esc(t.name)}</option>`).join('');
  const div = document.createElement('div');
  div.className = 'rule' + (r.enabled ? '' : ' off');
  div.dataset.id = r.id;
  div.innerHTML = `
    <label class="switch"><input type="checkbox" data-k="enabled" ${r.enabled ? 'checked' : ''}><span></span></label>
    <div class="grp"><select data-k="trigger.type">${opt(TRIGGERS, r.trigger.type)}</select></div>
    <div class="grp trig-params"></div>
    <div class="arrow">←</div>
    <div class="grp"><select data-k="action.type">${opt(ACTIONS, r.action.type)}</select><span class="act-params grp"></span></div>
    <div class="grp"><label class="mini">אפקט</label><select data-k="effect">${opt(EFFECTS, r.effect)}</select></div>
    <div class="acts"><button class="btn small" data-test>בדוק</button><button class="btn small ghost" data-del>✕</button></div>`;
  const tp = div.querySelector('.trig-params');
  const ap = div.querySelector('.act-params');
  const fillParams = () => {
    const tt = div.querySelector('[data-k="trigger.type"]').value;
    const at = div.querySelector('[data-k="action.type"]').value;
    const cur = readRule(div, r);
    tp.innerHTML = {
      gift: `<input data-k="trigger.gift" list="gift-list" dir="ltr" placeholder="Rose" value="${esc(cur.trigger.gift)}">`,
      likes: `<label class="mini">כל</label><input type="number" min="1" data-k="trigger.every" value="${cur.trigger.every || 50}"><label class="mini">לייקים</label>`,
      chat: `<input data-k="trigger.command" dir="ltr" placeholder="!heal" value="${esc(cur.trigger.command)}"><label class="mini">המתנה (שנ׳)</label><input type="number" min="0" data-k="trigger.cooldown" value="${cur.trigger.cooldown || 0}">`,
      follow: '<span class="hint">פעם אחת לכל צופה</span>',
      share: '<span class="hint">פעם ב-10 שנ׳ לכל צופה</span>',
    }[tt] || '';
    ap.innerHTML = {
      spawn: `<select data-k="action.tierId" dir="ltr">${tiers}</select><input type="number" min="1" data-k="action.count" value="${cur.action.count || 1}" title="כמות">`,
      heal: `<input type="number" min="1" data-k="action.amount" value="${cur.action.amount || 500}" title="כמות חיים">`,
      damage: `<input type="number" min="1" data-k="action.amount" value="${cur.action.amount || 500}" title="כמות נזק">`,
      airstrike: `<input type="number" min="1" data-k="action.count" value="${cur.action.count || 5}" title="מספר מטרות">`,
      slowmo: `<input type="number" min="1" max="60" data-k="action.seconds" value="${cur.action.seconds || 5}" title="שניות">`,
      weapon: `<input data-k="action.weapon" list="weapon-list" dir="ltr" value="${esc(cur.action.weapon || 'WEAPON_RPG')}">`,
    }[at] || '';
    if (at === 'spawn') ap.querySelector('[data-k="action.tierId"]').value = cur.action.tierId || S.config.tiers[0]?.id;
  };
  div._rule = r;
  fillParams();
  div.addEventListener('change', (e) => {
    if (e.target.matches('[data-k="trigger.type"], [data-k="action.type"]')) fillParams();
    if (e.target.matches('[data-k="enabled"]')) div.classList.toggle('off', !e.target.checked);
    markDirty('rules');
  });
  div.addEventListener('input', () => markDirty('rules'));
  div.querySelector('[data-del]').onclick = () => { div.remove(); markDirty('rules'); };
  div.querySelector('[data-test]').onclick = () => testRule(readRule(div, r));
  return div;
}

function readRule(div, base) {
  const r = structuredClone(base);
  for (const inp of $$('[data-k]', div)) {
    const [a, b] = inp.dataset.k.split('.');
    const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
    if (b) r[a][b] = v; else r[a] = v;
  }
  return r;
}

async function testRule(r) {
  const t = r.trigger;
  const body = { gift: { kind: 'gift', gift: t.gift, count: 1 }, likes: { kind: 'like', count: t.every }, follow: { kind: 'follow' }, share: { kind: 'share' }, chat: { kind: 'chat', text: t.command } }[t.type];
  if (dirty.rules) await save('rules');
  await api('/api/test', { ...body, user: 'tester' + Math.floor(Math.random() * 999) });
  toast('נשלח אירוע בדיקה');
}

function renderRules() {
  const box = $('#rules');
  box.innerHTML = '';
  S.config.rules.forEach((r) => box.appendChild(ruleRow(r)));
}

function tierCard(t, i) {
  const d = document.createElement('div');
  d.className = 'tier-card';
  d.style.setProperty('--c', t.color);
  d.dataset.id = t.id;
  d.innerHTML = `
    <div class="head"><span class="num">${i + 1}</span><input class="name" data-k="name" value="${esc(t.name)}" dir="ltr"><input type="color" data-k="color" value="${esc(t.color.length === 7 ? t.color : '#ffffff')}"></div>
    <label class="full">מודל (שם הדמות במשחק)<input data-k="model" dir="ltr" value="${esc(t.model)}"></label>
    <label>חיים<input type="number" min="1" data-k="health" value="${t.health}"></label>
    <label>שריון<input type="number" min="0" data-k="armor" value="${t.armor}"></label>
    <label class="full">נשק<input data-k="weapon" list="weapon-list" dir="ltr" value="${esc(t.weapon)}"></label>
    <label>דיוק (0-100)<input type="number" min="0" max="100" data-k="accuracy" value="${t.accuracy}"></label>
    <label>מכפיל נזק<input type="number" min="0" step="0.1" data-k="damage" value="${t.damage}"></label>
    <label class="full">תמונה לאוברליי (לינק, לא חובה)<input data-k="image" dir="ltr" value="${esc(t.image)}" placeholder="https://..."></label>
    <div class="acts"><button class="btn small" data-up>▲</button><button class="btn small" data-down>▼</button><button class="btn small" data-spawn>שגר לבדיקה</button><button class="btn small ghost" data-del>מחק</button></div>`;
  d.addEventListener('input', (e) => { if (e.target.dataset.k === 'color') d.style.setProperty('--c', e.target.value); markDirty('tiers'); });
  d.querySelector('[data-del]').onclick = () => { if (confirm('למחוק את הדמות?')) { d.remove(); renumber(); markDirty('tiers'); } };
  d.querySelector('[data-up]').onclick = () => { d.previousElementSibling?.before(d); renumber(); markDirty('tiers'); };
  d.querySelector('[data-down]').onclick = () => { d.nextElementSibling?.after(d); renumber(); markDirty('tiers'); };
  d.querySelector('[data-spawn]').onclick = async () => { if (dirty.tiers) await save('tiers'); await api('/api/action', { type: 'spawn', tierId: t.id, count: 1 }); toast('שוגר: ' + t.name); };
  return d;
}
function renumber() { $$('#tiers .tier-card .num').forEach((n, i) => (n.textContent = i + 1)); }

function renderTiers() {
  const box = $('#tiers');
  box.innerHTML = '';
  S.config.tiers.forEach((t, i) => box.appendChild(tierCard(t, i)));
}

function readTiers() {
  return $$('#tiers .tier-card').map((d) => {
    const t = { id: d.dataset.id };
    for (const inp of $$('[data-k]', d)) t[inp.dataset.k] = inp.type === 'number' ? Number(inp.value) : inp.value;
    return t;
  });
}

const SETTINGS = [
  ['חיים', [
    ['health.max', 'num', 'חיים מקסימליים', 'כמה חיים יש לדמות שלך (בתמונה ששלחת: ~50,000)'],
    ['health.damageMultiplier', 'num', 'מכפיל נזק', '1 = רגיל. 2 = האויבים פוגעים פי 2. 0.5 = חצי'],
    ['health.regenPerSecond', 'num', 'התחדשות לשנייה', '0 = בלי התחדשות'],
    ['health.reviveSeconds', 'num', 'זמן קימה אחרי מוות (שנ׳)', 'גיבוי – בדרך כלל המשחק מודיע כשהדמות קמה'],
    ['health.clearEnemiesOnDeath', 'bool', 'מחק אויבים אחרי מוות', ''],
    ['health.clearQueueOnDeath', 'bool', 'נקה את תור האויבים אחרי מוות', ''],
  ]],
  ['משחק', [
    ['game.hideHud', 'bool', 'הסתר את ה-HUD של GTA', 'מסתיר מפה, נשק, כסף – מסך נקי ללייב'],
    ['game.nameTags', 'bool', 'שם השולח מעל האויב', 'מציג מי שלח כל אויב'],
    ['game.maxAliveEnemies', 'num', 'מקסימום אויבים בו-זמנית', 'השאר בתור – ייכנסו כשמקום מתפנה. מומלץ 20-30'],
    ['game.spawnIntervalMs', 'num', 'זמן בין שיגורים (מ״ש)', ''],
    ['game.spawnDistanceMin', 'num', 'מרחק שיגור מינימלי (מטר)', ''],
    ['game.spawnDistanceMax', 'num', 'מרחק שיגור מקסימלי (מטר)', ''],
    ['game.maxQueue', 'num', 'גודל תור מקסימלי', ''],
  ]],
  ['אוברליי', [
    ['overlay.showTiers', 'bool', 'הצג רצועת דמויות', ''],
    ['overlay.showAlerts', 'bool', 'הצג התראות מתנות', ''],
    ['overlay.alertSeconds', 'num', 'משך התראה (שנ׳)', ''],
    ['overlay.sounds', 'bool', 'צלילי אפקטים', ''],
  ]],
  ['טיקטוק ושרת', [
    ['tiktok.autoConnect', 'bool', 'התחבר אוטומטית כשהשרת עולה', ''],
    ['tiktok.autoReconnect', 'bool', 'התחבר מחדש אוטומטית', 'אם הלייב נפל או עוד לא התחיל'],
    ['tiktok.signApiKey', 'text', 'מפתח Euler Stream (לא חובה)', 'רק אם מקבלים שגיאות Rate limit – מפתח חינמי מ-eulerstream.com'],
    ['port', 'num', 'פורט השרת', 'נכנס לתוקף בהפעלה הבאה. אם תפוס – נבחר אוטומטית הבא הפנוי'],
    ['openBrowser', 'bool', 'פתח את הלוח בדפדפן בהפעלה', ''],
  ]],
];

const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; }

function renderSettings() {
  const box = $('#settings');
  box.innerHTML = SETTINGS.map(([title, fields]) => `<div class="card"><h2>${title}</h2>${fields.map(([p, type, label, help]) => {
    const v = getPath(S.config, p);
    const input = type === 'bool' ? `<label class="switch"><input type="checkbox" data-p="${p}" ${v ? 'checked' : ''}><span></span></label>`
      : type === 'num' ? `<input type="number" step="any" data-p="${p}" value="${v}">`
      : `<input data-p="${p}" dir="ltr" value="${esc(v)}">`;
    return `<div class="field"><div class="lbl"><b>${label}</b>${help ? `<small>${help}</small>` : ''}</div>${input}</div>`;
  }).join('')}</div>`).join('');
  box.oninput = box.onchange = () => markDirty('settings');
}

function readSettings() {
  const patch = {};
  for (const inp of $$('#settings [data-p]')) setPath(patch, inp.dataset.p, inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value);
  return patch;
}

function markDirty(k) { dirty[k] = true; $$(`[data-save="${k}"]`).forEach((b) => b.classList.add('dirty')); }

async function save(k) {
  let patch;
  if (k === 'rules') patch = { rules: $$('#rules .rule').map((d) => readRule(d, d._rule)) };
  if (k === 'tiers') patch = { tiers: readTiers() };
  if (k === 'settings') patch = readSettings();
  try {
    const res = await api('/api/config', patch);
    dirty[k] = false;
    $$(`[data-save="${k}"]`).forEach((b) => b.classList.remove('dirty'));
    S.config = res.config;
    renderEditors();
    toast(res.portChangesOnRestart ? 'נשמר ✔ – הפורט החדש ייכנס לתוקף בהפעלה הבאה' : 'נשמר ✔');
  } catch (e) { toast('שגיאה: ' + e.message, true); }
}

// ---------- overlays ----------
function renderOverlayLinks() {
  const base = `http://127.0.0.1:${S.port || location.port}`;
  const links = [['הכל ביחד (מומלץ)', '/overlay/all'], ['מד חיים', '/overlay/health'], ['התראות מתנות ואפקטים', '/overlay/alerts'], ['רצועת דמויות', '/overlay/tiers']];
  $('#overlay-links').innerHTML = links.map(([n, p]) => `<div class="link-row"><b>${n}</b><code>${base}${p}</code><button class="btn small" data-copy="${base}${p}">העתק</button><button class="btn small ghost" data-prev="${p}">תצוגה</button></div>`).join('');
  if (!$('#preview').src) $('#preview').src = '/overlay/all?sound=0';
}

// ---------- GTA install ----------
function renderGta(c) {
  if (!c) return;
  const items = [
    ['folder', 'התיקייה קיימת'], ['gtaExe', 'נמצא GTA5.exe'], ['scriptHookV', 'Script Hook V מותקן'], ['asiLoader', 'ASI Loader (dinput8.dll)'],
    ['shvdn', 'ScriptHookVDotNet מותקן'], ['modInstalled', 'מוד Live Arena מותקן'],
  ];
  $('#gta-checks').innerHTML = c.path ? items.map(([k, l]) => `<div class="check ${c[k] ? 'ok' : ''}"><span class="dot">${c[k] ? '✔' : '✕'}</span>${l}</div>`).join('')
    + (c.enhanced ? '<div class="check"><span class="dot">!</span>זוהתה גרסת Enhanced – ודא שהורדת Script Hook V שתומך בה</div>' : '') : '';
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.tab) {
      $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    } else if (b.dataset.post) {
      if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
      await api(b.dataset.post, {});
      toast('בוצע ✔');
    } else if (b.dataset.action) {
      await api('/api/action', JSON.parse(b.dataset.action));
      toast('בוצע ✔');
    } else if (b.dataset.sim) {
      await api('/api/test', { ...JSON.parse(b.dataset.sim), user: 'viewer' + Math.floor(Math.random() * 999) });
    } else if (b.dataset.save) {
      await save(b.dataset.save);
    } else if (b.dataset.copy) {
      await navigator.clipboard.writeText(b.dataset.copy).then(() => toast('הועתק ✔'), () => prompt('העתק:', b.dataset.copy));
    } else if (b.dataset.prev) {
      $('#preview').src = b.dataset.prev + '?sound=0';
    }
  } catch (err) { toast('שגיאה: ' + err.message, true); }
});

$('#btn-connect').onclick = async () => {
  const u = $('#username').value.trim();
  if (!u) return toast('הכנס שם משתמש', true);
  await api('/api/connect', { username: u }).catch((e) => toast(e.message, true));
};
$('#username').addEventListener('keydown', (e) => e.key === 'Enter' && $('#btn-connect').click());
$('#btn-disconnect').onclick = () => api('/api/disconnect', {});
$('#sim-send-gift').onclick = () => api('/api/test', { kind: 'gift', gift: $('#sim-gift').value || 'Rose', count: Number($('#sim-count').value) || 1, user: 'viewer' + Math.floor(Math.random() * 999) }).catch((e) => toast(e.message, true));
$('#sim-send-chat').onclick = () => api('/api/test', { kind: 'chat', text: $('#sim-chat').value, user: 'viewer' + Math.floor(Math.random() * 999) });

$('#rule-add').onclick = () => {
  const r = { id: 'r' + Date.now().toString(36), enabled: true, trigger: { type: 'gift', gift: '', every: 50, command: '', cooldown: 0 }, action: { type: 'spawn', tierId: S.config.tiers[0]?.id, count: 1, amount: 500, seconds: 5, weapon: '' }, effect: 'auto' };
  $('#rules').appendChild(ruleRow(r));
  markDirty('rules');
};
$('#tier-add').onclick = () => {
  const t = { id: 't' + Date.now().toString(36), name: 'New Enemy', model: 's_m_y_swat_01', health: 300, armor: 0, weapon: 'WEAPON_PISTOL', accuracy: 30, damage: 1, color: '#ffffff', image: '' };
  $('#tiers').appendChild(tierCard(t, $$('#tiers .tier-card').length));
  markDirty('tiers');
};
$('#rules-reset').onclick = async () => { if (!confirm('לשחזר את כל החוקים לברירת המחדל?')) return; dirty.rules = false; S.config = (await api('/api/config/reset', { what: 'rules' })).config; renderEditors(); toast('שוחזר'); };
$('#tiers-reset').onclick = async () => { if (!confirm('לשחזר את כל הדמויות לברירת המחדל?')) return; dirty.tiers = false; S.config = (await api('/api/config/reset', { what: 'tiers' })).config; renderEditors(); toast('שוחזר'); };

$('#gta-check').onclick = async () => renderGta(await api('/api/gta/check', { path: $('#gta-path').value }));
$('#gta-install').onclick = async () => {
  try { renderGta(await api('/api/gta/install', { path: $('#gta-path').value })); toast('המוד הותקן ✔ – הפעל את GTA'); }
  catch (e) { toast(e.message, true); }
};

addEventListener('beforeunload', (e) => { if (Object.values(dirty).some(Boolean)) { e.preventDefault(); e.returnValue = ''; } });

connectWs();
