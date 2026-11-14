import { connect, fmt, el, esc, sfx, params } from './common.js';

const ICON = {
  heart: '<svg viewBox="0 0 24 24" class="hp-heart"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3 1.7-1.9 3.2-3 5.3-3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z" stroke="#000" stroke-width="1.6"/></svg>',
  skull: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2C6.5 2 3 5.9 3 10.5c0 2.7 1.3 4.6 3 5.8V20a1 1 0 0 0 1 1h2v-2h2v2h2v-2h2v2h2a1 1 0 0 0 1-1v-3.7c1.7-1.2 3-3.1 3-5.8C21 5.9 17.5 2 12 2zM8.5 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm7 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>',
  enemy: '<svg viewBox="0 0 24 24" fill="#f87171"><circle cx="12" cy="6" r="3.5"/><path d="M5 21v-4.5C5 13.5 8 11 12 11s7 2.5 7 5.5V21z"/></svg>',
  hourglass: '<svg viewBox="0 0 24 24" fill="#facc15"><path d="M6 2h12v2c0 3-2.2 5.2-4.2 8 2 2.8 4.2 5 4.2 8v2H6v-2c0-3 2.2-5.2 4.2-8C8.2 9.2 6 7 6 4z"/></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="#a1a1aa"><path d="M10 2h4v6h6v4h-6v10h-4V12H4V8h6z"/></svg>',
  like: '<svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3 1.7-1.9 3.2-3 5.3-3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>',
};

function hpColors(p) {
  if (p > 0.6) return ['#22c55e', '#86efac', '#15803d'];
  if (p > 0.3) return ['#f59e0b', '#fde047', '#b45309'];
  return ['#ef4444', '#fca5a5', '#991b1b'];
}

// ======================= HEALTH BAR =======================
export function mountHealth(root, { bottom = 300, showStats = true } = {}) {
  const wrap = el('div', 'hp-wrap');
  wrap.style.bottom = `calc(${bottom} * var(--u))`;
  wrap.innerHTML = `
    <div class="hp-head">
      <div class="hp-label">${ICON.heart}<span>HEALTH</span></div>
      <div class="hp-num"><span class="cur">0</span><small>/ <span class="max">0</span></small></div>
      <div class="hp-pct">100%</div>
    </div>
    <div class="hp-bar">
      <div class="hp-chip"></div><div class="hp-heal"></div><div class="hp-fill"></div><div class="hp-ticks"></div>
      <div class="ko">K.O. <span class="ko-sub" style="font-size:.6em;opacity:.85"></span></div>
    </div>
    <div class="hp-stats" ${showStats ? '' : 'style="display:none"'}>
      <div class="chip kills">${ICON.skull}<span>0</span>&nbsp;KILLS</div>
      <div class="chip alive">${ICON.enemy}<span>0</span>&nbsp;ENEMIES</div>
      <div class="chip queue">${ICON.hourglass}<span>0</span>&nbsp;INCOMING</div>
      <div class="chip deaths">${ICON.cross}<span>0</span>&nbsp;DEATHS</div>
    </div>`;
  root.appendChild(wrap);

  const $ = (s) => wrap.querySelector(s);
  const fill = $('.hp-fill'), chip = $('.hp-chip'), heal = $('.hp-heal'), cur = $('.cur'), max = $('.max'), pct = $('.hp-pct'), bar = $('.hp-bar');
  let shown = 0, target = 0, maxHp = 1, raf = 0, pendingDmg = 0, dmgTimer = 0, reviveTimer = 0;

  function animateNumber() {
    cancelAnimationFrame(raf);
    const step = () => {
      const diff = target - shown;
      shown = Math.abs(diff) < 1 ? target : shown + diff * 0.18;
      cur.textContent = fmt(shown);
      if (shown !== target) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function floatText(text, cls) {
    const p = Math.max(0.04, Math.min(0.96, target / maxHp));
    const f = el('div', 'float ' + cls, text);
    f.style.left = `${p * 100}%`;
    f.style.top = `${bar.offsetTop - bar.offsetHeight * 0.4}px`;
    wrap.appendChild(f);
    f.addEventListener('animationend', () => f.remove());
  }

  function set({ hp, max: m, dead, delta = 0 }) {
    maxHp = Math.max(1, m);
    target = Math.max(0, hp);
    const p = target / maxHp;
    const [c, hi, lo] = hpColors(p);
    wrap.style.setProperty('--hp-color', c);
    wrap.style.setProperty('--hp-hi', hi);
    wrap.style.setProperty('--hp-lo', lo);
    max.textContent = fmt(maxHp);
    pct.textContent = `${Math.ceil(p * 100)}%`;
    const w = `${p * 100}%`;
    if (delta > 0) {
      // Heal: green "ghost" bar jumps ahead, main bar catches up.
      fill.classList.add('healing');
      heal.style.width = w;
      fill.style.width = w;
      chip.style.width = w;
      floatText(`+${fmt(delta)}`, 'heal');
      setTimeout(() => fill.classList.remove('healing'), 1100);
    } else {
      fill.style.width = w;
      heal.style.width = w;
      chip.style.width = w;
      if (delta < 0) {
        pendingDmg += -delta;
        clearTimeout(dmgTimer);
        dmgTimer = setTimeout(() => {
          if (pendingDmg >= 1) floatText(`-${fmt(pendingDmg)}`, 'dmg');
          if (pendingDmg >= maxHp * 0.02) { wrap.classList.remove('shake'); void wrap.offsetWidth; wrap.classList.add('shake'); }
          pendingDmg = 0;
        }, 160);
      }
    }
    wrap.classList.toggle('low', p > 0 && p <= 0.2);
    wrap.classList.toggle('dead', !!dead);
    animateNumber();
  }

  function stats(s) {
    const upd = (cls, v) => {
      const span = $(`.${cls} span`);
      const txt = fmt(v || 0);
      if (span.textContent !== txt) { span.textContent = txt; const c = $(`.${cls}`); c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); }
    };
    upd('kills', s.kills); upd('alive', s.alive); upd('queue', s.queue); upd('deaths', s.deaths);
  }

  function ko(reviveSeconds) {
    sfx('ko', soundsOn);
    let left = reviveSeconds;
    const sub = $('.ko-sub');
    clearInterval(reviveTimer);
    sub.textContent = `REVIVING IN ${left}s`;
    reviveTimer = setInterval(() => { left--; sub.textContent = left > 0 ? `REVIVING IN ${left}s` : 'REVIVING...'; if (left <= 0) clearInterval(reviveTimer); }, 1000);
  }

  return { set, stats, ko, revive: () => clearInterval(reviveTimer) };
}

// ======================= ALERTS + EFFECTS =======================
let soundsOn = params.get('sound') !== '0';

export function mountAlerts(root, { top = 120, seconds = 4 } = {}) {
  const list = el('div', 'alerts');
  list.style.top = `calc(${top} * var(--u))`;
  root.appendChild(list);
  const fx = el('div', 'fx');
  const canvas = el('canvas');
  fx.appendChild(canvas);
  document.body.appendChild(fx);
  const ctx = canvas.getContext('2d');
  let particles = [];
  let bolts = [];
  let running = false;
  let alertSeconds = seconds;

  function resize() { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; }
  resize();
  addEventListener('resize', resize);

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const g = 0.25 * devicePixelRatio;
    particles = particles.filter((p) => p.life > 0);
    for (const p of particles) {
      p.vy += p.grav ? g : 0;
      p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy *= p.grav ? 1 : 0.985;
      p.rot += p.vr; p.life -= 1;
      ctx.globalAlpha = Math.min(1, p.life / 30);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.shape === 'plus') { ctx.fillRect(-p.s, -p.s / 3, p.s * 2, p.s / 1.5); ctx.fillRect(-p.s / 3, -p.s, p.s / 1.5, p.s * 2); }
      else if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.s, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.s, -p.s / 2, p.s * 2, p.s);
      ctx.restore();
    }
    bolts = bolts.filter((b) => b.life > 0);
    for (const b of bolts) {
      ctx.globalAlpha = Math.min(1, b.life / 8);
      ctx.strokeStyle = '#e0f2fe';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 30 * devicePixelRatio;
      ctx.lineWidth = 5 * devicePixelRatio;
      ctx.beginPath();
      b.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.shadowBlur = 0;
      b.life--;
    }
    ctx.globalAlpha = 1;
    if (particles.length || bolts.length) requestAnimationFrame(loop);
    else running = false;
  }
  const kick = () => { if (!running) { running = true; requestAnimationFrame(loop); } };

  function burst(x, y, colors, n = 60, opts = {}) {
    const d = devicePixelRatio;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed || 9) * (0.4 + Math.random()) * d;
      particles.push({ x: x * d, y: y * d, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (opts.up || 4) * d, grav: opts.grav !== false,
        s: (6 + Math.random() * 8) * d, color: colors[i % colors.length], life: 70 + Math.random() * 50, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, shape: opts.shape || (i % 3 ? 'rect' : 'circle') });
    }
    kick();
  }

  function rising(colors, n = 40, shape = 'plus') {
    const d = devicePixelRatio;
    for (let i = 0; i < n; i++) {
      particles.push({ x: Math.random() * innerWidth * d, y: (innerHeight + 20) * d, vx: (Math.random() - 0.5) * d, vy: -(4 + Math.random() * 6) * d, grav: false,
        s: (8 + Math.random() * 10) * d, color: colors[i % colors.length], life: 90 + Math.random() * 60, rot: 0, vr: 0, shape });
    }
    kick();
  }

  function lightning(n = 4) {
    const d = devicePixelRatio;
    for (let k = 0; k < n; k++) {
      setTimeout(() => {
        let x = (0.15 + Math.random() * 0.7) * innerWidth * d, y = 0;
        const pts = [[x, y]];
        while (y < innerHeight * d * (0.5 + Math.random() * 0.4)) { x += (Math.random() - 0.5) * 120 * d; y += (30 + Math.random() * 60) * d; pts.push([x, y]); }
        bolts.push({ pts, life: 14 });
        overlayFlash('rgba(186,230,253,.55)');
        kick();
      }, k * 220);
    }
  }

  function overlayFlash(color) { const f = el('div', 'flash'); f.style.background = color; fx.appendChild(f); f.addEventListener('animationend', () => f.remove()); }
  function vignette(color) { const v = el('div', 'vignette'); v.style.background = `radial-gradient(ellipse at center, transparent 45%, ${color} 100%)`; fx.appendChild(v); v.addEventListener('animationend', () => v.remove()); }
  function ring(color) { const r = el('div', 'ring'); r.style.setProperty('--c', color); fx.appendChild(r); r.addEventListener('animationend', () => r.remove()); }
  function shake() { document.body.classList.remove('screen-shake'); void document.body.offsetWidth; document.body.classList.add('screen-shake'); }
  function banner(big, small, color) {
    const b = el('div', 'banner', `<div class="stripes"></div><div class="big">${esc(big)}</div><div class="small">${esc(small)}</div><div class="stripes"></div>`);
    b.style.setProperty('--c', color);
    fx.appendChild(b);
    b.addEventListener('animationend', () => b.remove());
  }

  function effect(a, cardRect) {
    const cx = cardRect ? cardRect.left + cardRect.width / 2 : innerWidth / 2;
    const cy = cardRect ? cardRect.top + cardRect.height / 2 : innerHeight * 0.2;
    const colors = [a.color, '#ffffff', '#fde047', '#fe2c55', '#25f4ee'];
    sfx(a.effect === 'none' ? '' : a.effect, soundsOn);
    switch (a.effect) {
      case 'pop': burst(cx, cy, colors, 18, { speed: 5 }); break;
      case 'burst': burst(cx, cy, colors, 70); break;
      case 'shockwave': ring(a.color); shake(); burst(innerWidth / 2, innerHeight * 0.4, colors, 120, { speed: 14 }); break;
      case 'boss': vignette('rgba(127,29,29,.85)'); shake(); banner('BOSS INCOMING', `${a.user} ${a.text}`, a.color || '#ef4444'); setTimeout(shake, 700); break;
      case 'heal': vignette('rgba(34,197,94,.55)'); rising(['#4ade80', '#bbf7d0', '#22c55e'], 50); break;
      case 'nuke': overlayFlash('#fff'); setTimeout(() => overlayFlash('rgba(251,146,60,.8)'), 250); shake(); setTimeout(shake, 600); banner('NUKE!', `${a.user} wiped out every enemy`, '#facc15');
        burst(innerWidth / 2, innerHeight * 0.45, ['#facc15', '#fb923c', '#ef4444', '#fff'], 200, { speed: 20 }); break;
      case 'lightning': lightning(5); shake(); break;
    }
  }

  const queue = [];
  const maxVisible = 4;
  function pump() {
    while (queue.length && list.children.length < maxVisible) show(queue.shift());
  }

  function show(a) {
    const initial = (a.user || '?').trim().charAt(0).toUpperCase();
    const card = el('div', 'alert');
    card.style.setProperty('--c', a.color || '#fff');
    card.innerHTML = `
      ${a.avatar ? `<img class="av" src="${esc(a.avatar)}" referrerpolicy="no-referrer">` : `<div class="av ph">${esc(initial)}</div>`}
      <div class="body"><div class="who">${esc(a.user)}</div><div class="what">${esc(a.text)}</div></div>
      ${a.image ? `<img class="gift" src="${esc(a.image)}" referrerpolicy="no-referrer">` : `<div class="badge">${esc(a.label)}</div>`}`;
    const av = card.querySelector('img.av');
    if (av) av.onerror = () => { av.outerHTML = `<div class="av ph">${esc(initial)}</div>`; };
    list.appendChild(card);
    requestAnimationFrame(() => effect(a, card.getBoundingClientRect()));
    // Busy LIVE -> shorter display time.
    const ms = alertSeconds * 1000 * (queue.length > 6 ? 0.4 : queue.length > 2 ? 0.7 : 1);
    setTimeout(() => {
      card.classList.add('out');
      card.addEventListener('animationend', () => { card.remove(); pump(); }, { once: true });
    }, ms);
  }

  return {
    alert(a) { queue.push(a); if (queue.length > 60) queue.splice(0, queue.length - 60); pump(); },
    ko() { overlayFlash('rgba(239,68,68,.6)'); shake(); banner('K.O.', 'The streamer is down!', '#ef4444'); },
    revive() { vignette('rgba(34,197,94,.5)'); rising(['#4ade80', '#fff'], 40); },
    setSeconds(s) { alertSeconds = s; },
  };
}

// ======================= TIER STRIP =======================
const FIGURE = (c) => `<svg viewBox="0 0 60 120"><g fill="${c}" stroke="#000" stroke-width="2.5" stroke-linejoin="round">
  <circle cx="30" cy="15" r="11"/><path d="M14 30h32l6 34-8 2-4-22v72H33V80h-6v36H20V44l-4 22-8-2z"/></g></svg>`;

export function mountTiers(root, { bottom = 20 } = {}) {
  const box = el('div', 'tiers');
  box.style.bottom = `calc(${bottom} * var(--u))`;
  root.appendChild(box);
  let gifts = [];
  let config = null;

  function render() {
    if (!config) return;
    const tiers = config.tiers;
    const rules = config.rules
      .filter((r) => r.enabled && r.action.type === 'spawn' && tiers.some((t) => t.id === r.action.tierId))
      .sort((a, b) => tiers.findIndex((t) => t.id === a.action.tierId) - tiers.findIndex((t) => t.id === b.action.tierId) || a.action.count - b.action.count);
    box.style.display = rules.length && config.overlay.showTiers !== false ? 'flex' : 'none';
    box.innerHTML = '';
    for (const r of rules) {
      const t = tiers.find((x) => x.id === r.action.tierId);
      const col = el('div', 'tier');
      col.dataset.tier = t.id;
      col.style.setProperty('--c', t.color);
      const g = r.trigger.type === 'gift' ? gifts.find((x) => x.name.toLowerCase() === r.trigger.gift.toLowerCase() || x.id === r.trigger.gift) : null;
      let trig;
      if (r.trigger.type === 'gift') trig = g?.image ? `<img src="${esc(g.image)}" referrerpolicy="no-referrer">` : `<span class="pill gift">${esc(r.trigger.gift)}</span>`;
      else if (r.trigger.type === 'likes') trig = `<span class="pill like">${ICON.like}${fmt(r.trigger.every)}</span>`;
      else if (r.trigger.type === 'follow') trig = '<span class="pill">Follow</span>';
      else if (r.trigger.type === 'share') trig = '<span class="pill share">Share</span>';
      else trig = `<span class="pill gift">${esc(r.trigger.command)}</span>`;
      col.innerHTML = `
        <div class="mult">${r.action.count}x</div>
        <div class="fig">${t.image ? `<img src="${esc(t.image)}">` : FIGURE(t.color)}</div>
        <div class="name">${esc(t.name)}</div>
        <div class="trig">${trig}</div>`;
      box.appendChild(col);
    }
  }

  return {
    setConfig(c) { config = c; render(); },
    setGifts(g) { gifts = g || []; render(); },
    hit(tierIndex) {
      if (!config || tierIndex < 0) return;
      const t = config.tiers[tierIndex];
      box.querySelectorAll(`[data-tier="${t?.id}"]`).forEach((c) => { c.classList.remove('hit'); void c.offsetWidth; c.classList.add('hit'); });
    },
  };
}

// ======================= SCOREBOARD =======================
const mmss = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const sec = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0'); };
const ago = (ms) => { const t = Math.floor(ms / 1000); return t < 60 ? `${t}s` : t < 3600 ? `${Math.floor(t / 60)}m` : `${Math.floor(t / 3600)}h`; };

export function mountScoreboard(root, { top = 24 } = {}) {
  const box = el('div', 'score');
  box.style.top = `calc(${top} * var(--u))`;
  box.innerHTML = `<div class="mvp"></div><div class="wasted"></div><div class="killed"></div><div class="kills"></div><div class="timer"></div>`;
  root.appendChild(box);
  const $ = (c) => box.querySelector('.' + c);
  let a = null;
  let offset = 0; // server clock offset
  const setText = (c, html) => { const e = $(c); if (e.innerHTML !== html) { e.innerHTML = html; e.classList.remove('bump'); void e.offsetWidth; e.classList.add('bump'); } };

  function render() {
    if (!a) return;
    setText('mvp', a.mvp ? `<span class="star">★★★</span> ${esc(a.mvp.nickname)} : ${fmt(a.mvp.dmg)} <span class="star">★★★</span>` : '<span class="star">★★★</span> SEND A GIFT TO BE MVP <span class="star">★★★</span>');
    setText('wasted', `WASTED : ${fmt(a.deaths)}`);
    if (a.lastKiller) {
      $('killed').style.setProperty('--kc', a.lastKiller.color || '#ef4444');
      setText('killed', `LAST KILLED BY : <b>${esc(a.lastKiller.nickname)}</b>${a.killerStreak > 1 ? `<span class="streak">x${a.killerStreak} STREAK</span>` : ''}`);
    } else setText('killed', 'LAST KILLED BY : <b>NOBODY YET</b>');
    setText('kills', `KILLS : ${fmt(a.kills)}`);
    tick();
  }
  function tick() {
    if (!a) return;
    const now = Date.now() + offset;
    $('timer').textContent = a.dead
      ? `Last death ${ago(now - a.lastDeathAt)} ago`
      : `Alive ${mmss(now - a.lifeStartedAt)}  ·  Best ${mmss(a.bestSurvival)}${a.lastDeathAt ? `  ·  Last death ${ago(now - a.lastDeathAt)} ago` : ''}`;
  }
  setInterval(tick, 1000);
  return {
    set(arena, serverNow) { a = arena; if (serverNow) offset = serverNow - Date.now(); render(); },
    show(v) { box.style.display = v ? '' : 'none'; },
  };
}

// ======================= LEADERBOARD =======================
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

export function mountLeaderboard(root, { left = 20, bottom = 600 } = {}) {
  const box = el('div', 'lb');
  box.style.left = `calc(${left} * var(--u))`;
  box.style.bottom = `calc(${bottom} * var(--u))`;
  root.appendChild(box);
  let data = null, idx = 0, seconds = 8, timer = 0;

  function views() {
    const month = MONTHS[Number((data.monthKey || '').slice(5, 7)) - 1] || 'MONTHLY';
    return [
      { title: `${month} TOP KILLERS`, rows: data.month.kills, unit: '' },
      { title: 'TODAY\'S TOP KILLERS', rows: data.day.kills, unit: '' },
      { title: `${month} TOP GIFTERS`, rows: data.month.coins, unit: ' 🪙' },
      { title: 'MOST DAMAGE TODAY', rows: data.day.damage, unit: '' },
      { title: 'ALL-TIME KILLERS', rows: data.all.kills, unit: '' },
    ].filter((v) => v.rows.length);
  }

  function render() {
    if (!data) return;
    const vs = views();
    if (!vs.length) {
      box.innerHTML = '<h3>TOP KILLERS</h3><div class="empty">Nobody has killed me yet...<br>Send a gift and take #1!</div>';
      return;
    }
    const v = vs[idx % vs.length];
    box.innerHTML = `<h3>${esc(v.title)}</h3>` + v.rows.map((r, i) => `
      <div class="row r${i + 1}"><span class="n">${i + 1}</span>${r.avatar ? `<img src="${esc(r.avatar)}" referrerpolicy="no-referrer">` : '<span class="ph"></span>'}
      <span class="nm">${esc(r.nickname)}</span><span class="v">${fmt(r.value)}${v.unit}</span></div>`).join('');
  }

  function rotate() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      box.classList.add('swap');
      setTimeout(() => { idx++; render(); box.classList.remove('swap'); rotate(); }, 400);
    }, seconds * 1000);
  }
  rotate();
  return {
    set(d) { data = d; render(); },
    setSeconds(s) { seconds = s; rotate(); },
    show(v) { box.style.display = v ? '' : 'none'; },
  };
}

// ======================= WASTED SCREEN =======================
function wastedScreen(d) {
  const old = document.querySelector('.wasted-screen');
  if (old) old.remove();
  const k = d.killer;
  const w = el('div', 'wasted-screen');
  let html = '<div class="big">WASTED</div>';
  if (k) {
    const initial = esc((k.nickname || '?').trim().charAt(0).toUpperCase());
    html += `<div class="kcard" style="--kc:${esc(k.color || '#ef4444')}">
      ${k.avatar ? `<img class="av" src="${esc(k.avatar)}" referrerpolicy="no-referrer">` : `<div class="av ph">${initial}</div>`}
      <div><div class="t1">KILLED BY</div><div class="t2">${esc(k.nickname)}</div>
      <div class="t3">${k.tier ? `with ${esc(k.tier)} · ` : ''}${fmt(k.monthKills)} kill${k.monthKills === 1 ? '' : 's'} this month${k.streak > 1 ? ` · x${k.streak} in a row` : ''}</div></div></div>`;
  }
  const extra = [];
  if (k?.newNumberOne) extra.push(`<div class="gold">👑 NEW #1 KILLER OF THE MONTH 👑</div>`);
  else if (k?.monthRank && k.monthRank <= 5) extra.push(`<div>#${k.monthRank} on the monthly leaderboard</div>`);
  if (d.mvp && (!k || d.mvp.nickname !== k.nickname)) extra.push(`<div>MVP: ${esc(d.mvp.nickname)} · ${fmt(d.mvp.dmg)} damage</div>`);
  if (d.newRecord) extra.push(`<div class="rec">NEW RECORD! Survived ${mmss(d.survival)}</div>`);
  else if (d.survival) extra.push(`<div>Survived ${mmss(d.survival)}</div>`);
  if (extra.length) html += `<div class="ws-extra">${extra.join('')}</div>`;
  w.innerHTML = html;
  const av = w.querySelector('img.av');
  if (av) av.onerror = () => av.replaceWith(Object.assign(el('div', 'av ph'), { textContent: (k.nickname || '?').charAt(0).toUpperCase() }));
  document.body.appendChild(w);
  w.addEventListener('animationend', (e) => { if (e.target === w) w.remove(); });
}

// ======================= WIRING =======================
export function start({ health, alerts, tiers, score, board, wasted = false }) {
  let reviveSeconds = 12;
  let showAlerts = true;
  const applyOverlayCfg = (o) => {
    score?.show(o.showScoreboard !== false);
    board?.show(o.showLeaderboard !== false);
    board?.setSeconds(o.leaderboardSeconds || 8);
  };
  connect({
    init(s) {
      reviveSeconds = s.config.health.reviveSeconds;
      soundsOn = params.get('sound') !== '0' && s.config.overlay.sounds !== false;
      health?.set({ hp: s.engine.hp, max: s.engine.max, dead: s.engine.dead });
      health?.stats(s.engine);
      alerts?.setSeconds(s.config.overlay.alertSeconds);
      showAlerts = s.config.overlay.showAlerts !== false;
      tiers?.setGifts(s.gifts);
      tiers?.setConfig(s.config);
      applyOverlayCfg(s.config.overlay);
      score?.set(s.engine.arena);
      board?.set(s.boards);
    },
    config(c) {
      reviveSeconds = c.health.reviveSeconds;
      soundsOn = params.get('sound') !== '0' && c.overlay.sounds !== false;
      alerts?.setSeconds(c.overlay.alertSeconds);
      showAlerts = c.overlay.showAlerts !== false;
      tiers?.setConfig(c);
      applyOverlayCfg(c.overlay);
    },
    boards(b) { board?.set(b); },
    gifts(g) { tiers?.setGifts(g); },
    hp(d) { health?.set(d); },
    engine(s) { health?.stats(s); if (s.arena) score?.set(s.arena); },
    alert(a) { if (showAlerts) alerts?.alert(a); tiers?.hit(a.tierIndex); },
    ko(d) { health?.ko(reviveSeconds); if (wasted) wastedScreen(d || {}); else alerts?.ko(); },
    revive() { health?.revive(); alerts?.revive(); },
  });
}
