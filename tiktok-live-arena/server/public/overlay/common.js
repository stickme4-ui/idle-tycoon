// Shared helpers for all overlays: websocket with auto-reconnect + formatting.
export function connect(handlers) {
  let ws;
  let retry = 500;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      const fn = handlers[msg.type];
      if (fn) fn(msg.data);
    };
    ws.onclose = () => { setTimeout(open, retry); retry = Math.min(5000, retry * 2); };
  };
  open();
}

export const fmt = (n) => Math.round(n).toLocaleString('en-US');

export const params = new URLSearchParams(location.search);

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tiny synthesized sound kit (no audio files needed).
let ctx = null;
export function sfx(kind, enabled = true) {
  if (!enabled) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;
    const tone = (freq, dur, type = 'sine', gain = 0.12, slide = 0, delay = 0) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + delay);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + delay + dur);
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(gain, t + delay + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.02);
    };
    if (kind === 'pop') tone(660, 0.12, 'triangle', 0.08, 220);
    if (kind === 'burst') { tone(523, 0.1, 'triangle'); tone(784, 0.14, 'triangle', 0.1, 0, 0.08); }
    if (kind === 'shockwave') tone(180, 0.5, 'sawtooth', 0.1, -120);
    if (kind === 'boss') { tone(110, 0.6, 'sawtooth', 0.14, -40); tone(116, 0.6, 'square', 0.06, -40, 0.05); }
    if (kind === 'heal') { tone(523, 0.12, 'sine'); tone(659, 0.12, 'sine', 0.12, 0, 0.1); tone(784, 0.2, 'sine', 0.12, 0, 0.2); }
    if (kind === 'nuke') tone(70, 1.2, 'sawtooth', 0.2, -50);
    if (kind === 'lightning') tone(1400, 0.25, 'square', 0.06, -1300);
    if (kind === 'ko') { tone(300, 0.3, 'square', 0.1, -150); tone(200, 0.5, 'square', 0.1, -120, 0.25); }
  } catch { /* audio not available */ }
}
