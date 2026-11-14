import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { loadConfig, saveConfig, applyPatch, SERVER_ROOT, DEFAULT_TIERS, DEFAULT_RULES } from './config.js';
import { Engine } from './engine.js';
import { Stats } from './stats.js';
import { TikTokBridge } from './tiktok.js';
import { checkGta, installMod, writeModIni, writeFiveMUrl, checkFiveM } from './installer.js';

const PUBLIC_DIR = path.join(SERVER_ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ico': 'image/x-icon',
};

let cfg = loadConfig();
cfg = applyPatch(cfg, { tiers: cfg.tiers, rules: cfg.rules });

const board = new Stats();
const engine = new Engine(() => cfg, board);
const tiktok = new TikTokBridge();
const logBuffer = [];

// ---------- websocket hub ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

function publicConfig() {
  return { tiers: cfg.tiers, rules: cfg.rules, health: cfg.health, game: cfg.game, overlay: cfg.overlay, tiktok: { ...cfg.tiktok, signApiKey: cfg.tiktok.signApiKey ? '********' : '' }, port: cfg.port, openBrowser: cfg.openBrowser };
}

function fullState() {
  return {
    config: publicConfig(),
    engine: engine.snapshot(),
    tiktok: tiktok.status(),
    gifts: tiktok.gifts,
    gta: checkGta(cfg.game.gtaPath),
    fivem: checkFiveM(),
    log: logBuffer.slice(-100),
    boards: board.leaderboards(),
    port: activePort,
  };
}

function addLog(entry) {
  const e = { t: Date.now(), ...entry };
  logBuffer.push(e);
  if (logBuffer.length > 300) logBuffer.splice(0, logBuffer.length - 300);
  broadcast('log', e);
}

engine.on('hp', (d) => broadcast('hp', d));
engine.on('status', (d) => broadcast('engine', d));
engine.on('alert', (d) => broadcast('alert', d));
engine.on('ko', (d) => {
  broadcast('ko', d);
  addLog({ kind: 'system', text: d.killer ? `K.O. – ${d.killer.nickname} הרג אותך (${d.killer.tier})` : 'K.O. – השחקן מת' });
});
engine.on('revive', () => broadcast('revive', {}));
engine.on('log', (d) => addLog(d));

tiktok.on('event', (ev) => engine.handleEvent(ev));
tiktok.on('status', (s) => {
  broadcast('tiktok', s);
  const he = { connected: 'מחובר ללייב של @' + s.username, connecting: 'מתחבר ל-@' + s.username + '...', waiting: 'מנסה שוב: ' + s.error, disconnected: 'מנותק' + (s.error ? ': ' + s.error : '') };
  addLog({ kind: 'system', text: he[s.state] || s.state });
});
tiktok.on('gifts', (g) => broadcast('gifts', g));
tiktok.on('viewers', (n) => { engine.stats.viewers = n; });
tiktok.on('warn', (m) => addLog({ kind: 'system', text: 'אזהרה: ' + m }));

function persist() { saveConfig(cfg); }

// ---------- HTTP ----------
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new Error('payload too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const routes = {
  'GET /api/state': () => fullState(),

  'POST /api/config': async (body) => {
    const patch = { ...body };
    if (patch.tiktok && patch.tiktok.signApiKey === '********') delete patch.tiktok.signApiKey;
    const oldPort = cfg.port;
    cfg = applyPatch(cfg, patch);
    persist();
    engine.configChanged();
    broadcast('config', publicConfig());
    return { ok: true, config: publicConfig(), portChangesOnRestart: cfg.port !== oldPort };
  },

  'POST /api/config/reset': async (body) => {
    if (body.what === 'tiers' || body.what === 'all') cfg.tiers = structuredClone(DEFAULT_TIERS);
    if (body.what === 'rules' || body.what === 'all') cfg.rules = structuredClone(DEFAULT_RULES);
    cfg = applyPatch(cfg, { tiers: cfg.tiers, rules: cfg.rules });
    persist();
    broadcast('config', publicConfig());
    return { ok: true, config: publicConfig() };
  },

  'POST /api/connect': async (body) => {
    const username = String(body.username || cfg.tiktok.username || '').trim();
    cfg.tiktok.username = username.replace(/^@/, '');
    persist();
    tiktok.connect(username, { signApiKey: cfg.tiktok.signApiKey, autoReconnect: cfg.tiktok.autoReconnect }).catch((e) => addLog({ kind: 'system', text: 'שגיאה: ' + e.message }));
    return { ok: true };
  },

  'POST /api/disconnect': async () => { await tiktok.disconnect(); return { ok: true }; },

  'POST /api/test': async (body) => {
    const count = Math.max(1, Math.min(1000, parseInt(body.count, 10) || 1));
    const user = { id: 'test', uniqueId: body.user || 'tester', nickname: body.user || 'Tester', avatar: '' };
    const ev = { kind: body.kind, user, count, test: true };
    if (body.kind === 'gift') {
      const name = String(body.gift || 'Rose');
      const g = tiktok.gifts.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name) || {};
      const known = { rose: 1, tiktok: 1, 'heart me': 1, gg: 1, 'finger heart': 5, 'ice cream cone': 1, perfume: 20, doughnut: 30, 'hat and mustache': 99, 'hand hearts': 100, confetti: 100, corgi: 299, 'money gun': 500, galaxy: 1000, lion: 29999, universe: 44999 };
      ev.gift = { id: g.id || name, name: g.name || name, image: g.image || '', diamonds: g.diamonds ?? (parseInt(body.diamonds, 10) || known[name.toLowerCase()] || 1) };
    }
    if (body.kind === 'chat') ev.text = String(body.text || '');
    if (!['gift', 'like', 'follow', 'share', 'chat'].includes(ev.kind)) throw new Error('bad kind');
    engine.handleEvent(ev);
    return { ok: true };
  },

  'POST /api/action': async (body) => { engine.manual(body); return { ok: true }; },
  'POST /api/hp/reset': async () => { engine.resetHp(); return { ok: true }; },
  'POST /api/hp/ko': async () => { engine.knockOut(); return { ok: true }; },
  'POST /api/queue/clear': async () => { engine.queue.length = 0; engine.emitStatus(); return { ok: true }; },
  'POST /api/game/clear': async () => { engine.pushCmd('clear'); return { ok: true }; },
  'POST /api/stats/reset': async () => {
    Object.keys(engine.stats).forEach((k) => (engine.stats[k] = 0));
    engine.supporters.clear();
    engine.emitStatus();
    return { ok: true };
  },

  'POST /api/board/reset': async (body) => {
    if (!['day', 'month', 'alltime', 'arena', 'all'].includes(body.what)) throw new Error('bad target');
    board.reset(body.what);
    engine.emitStatus();
    broadcast('boards', board.leaderboards());
    return { ok: true };
  },

  'POST /api/gta/check': async (body) => checkGta(body.path ?? cfg.game.gtaPath),
  'POST /api/fivem/check': async () => checkFiveM(),
  'POST /api/gta/install': async (body) => {
    const p = String(body.path || cfg.game.gtaPath || '').trim().replace(/^"|"$/g, '');
    const result = installMod(p, activePort);
    cfg.game.gtaPath = p;
    persist();
    addLog({ kind: 'system', text: 'המוד הותקן ב-' + p });
    return result;
  },
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // Hot path: GTA mod polling (plain text protocol).
  if (pathname === '/game/poll') return send(res, 200, engine.poll(url.searchParams), 'text/plain; charset=utf-8');

  if (pathname.startsWith('/api/')) {
    const fn = routes[`${req.method} ${pathname}`];
    if (!fn) return send(res, 404, { error: 'not found' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      return send(res, 200, await fn(body));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  if (pathname === '/' || pathname === '/panel') { res.writeHead(302, { Location: '/panel/' }); return res.end(); }
  if (/^\/overlay\/[a-z-]+$/.test(pathname)) return serveStatic(res, pathname + '.html');
  if (pathname.endsWith('/')) return serveStatic(res, pathname + 'index.html');
  return serveStatic(res, pathname);
}

// ---------- port selection ----------
function isFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

async function findPort(start) {
  for (let p = start; p < start + 100 && p <= 65535; p++) {
    if ((await isFree(p, '127.0.0.1')) && (await isFree(p, '0.0.0.0'))) return p;
  }
  throw new Error('No free port found');
}

let activePort = 0;

async function main() {
  activePort = await findPort(cfg.port);
  if (activePort !== cfg.port) {
    console.log(`Port ${cfg.port} is busy - using ${activePort} instead.`);
    cfg.port = activePort;
    persist();
  }
  if (cfg.game.gtaPath) { try { writeModIni(cfg.game.gtaPath, activePort); } catch { /* ignore */ } }
  try { writeFiveMUrl(activePort); } catch { /* ignore */ }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { send(res, 500, { error: e.message }); } catch { /* ignore */ } });
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'init', data: fullState() }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
  setInterval(() => broadcast('engine', engine.snapshot()), 2000).unref();
  let boardVersion = -1;
  setInterval(() => {
    if (board.version === boardVersion) return;
    boardVersion = board.version;
    broadcast('boards', board.leaderboards());
  }, 1500).unref();
  const flush = () => { board.save(); process.exit(0); };
  process.on('SIGINT', flush);
  process.on('SIGTERM', flush);

  server.listen(activePort, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${activePort}`;
    console.log('');
    console.log('  TikTok Live Arena is running');
    console.log('  ----------------------------');
    console.log(`  Control panel : ${base}/panel/`);
    console.log(`  Overlay (all) : ${base}/overlay/all`);
    console.log(`  Health bar    : ${base}/overlay/health`);
    console.log(`  Gift alerts   : ${base}/overlay/alerts`);
    console.log(`  Enemy tiers   : ${base}/overlay/tiers`);
    console.log('');
    console.log('  Keep this window open while you are LIVE. Press Ctrl+C to stop.');
    if (cfg.openBrowser && process.platform === 'win32' && !process.env.NO_BROWSER) exec(`start "" "${base}/panel/"`);
    if (cfg.tiktok.autoConnect && cfg.tiktok.username) {
      tiktok.connect(cfg.tiktok.username, { signApiKey: cfg.tiktok.signApiKey, autoReconnect: cfg.tiktok.autoReconnect }).catch(() => {});
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
