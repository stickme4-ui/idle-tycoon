import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
export const DATA_DIR = path.join(SERVER_ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Enemy tiers, weakest -> strongest. "model" is any GTA V ped model name,
// including add-on peds (put the add-on model name here after installing it).
export const DEFAULT_TIERS = [
  { id: 't1', name: 'Beach Bum',   model: 'a_m_m_beach_01',      health: 120,  armor: 0,   weapon: 'WEAPON_UNARMED',       accuracy: 10, damage: 1,   color: '#9ca3af', image: '' },
  { id: 't2', name: 'Street Thug', model: 'g_m_y_famca_01',      health: 150,  armor: 0,   weapon: 'WEAPON_BAT',           accuracy: 15, damage: 1,   color: '#22c55e', image: '' },
  { id: 't3', name: 'Gangster',    model: 'g_m_y_ballasout_01',  health: 175,  armor: 0,   weapon: 'WEAPON_PISTOL',        accuracy: 20, damage: 1,   color: '#a855f7', image: '' },
  { id: 't4', name: 'Cop',         model: 's_m_y_cop_01',        health: 200,  armor: 50,  weapon: 'WEAPON_COMBATPISTOL',  accuracy: 25, damage: 1,   color: '#3b82f6', image: '' },
  { id: 't5', name: 'SWAT',        model: 's_m_y_swat_01',       health: 250,  armor: 100, weapon: 'WEAPON_SMG',           accuracy: 30, damage: 1,   color: '#0ea5e9', image: '' },
  { id: 't6', name: 'Marine',      model: 's_m_y_marine_03',     health: 300,  armor: 100, weapon: 'WEAPON_CARBINERIFLE',  accuracy: 35, damage: 1.2, color: '#84cc16', image: '' },
  { id: 't7', name: 'Black Ops',   model: 's_m_y_blackops_01',   health: 400,  armor: 150, weapon: 'WEAPON_ASSAULTRIFLE',  accuracy: 40, damage: 1.4, color: '#f59e0b', image: '' },
  { id: 't8', name: 'Bigfoot',     model: 'ig_orleans',          health: 2500, armor: 0,   weapon: 'WEAPON_UNARMED',       accuracy: 50, damage: 4,   color: '#f97316', image: '' },
  { id: 't9', name: 'Juggernaut',  model: 'u_m_y_juggernaut_01', health: 4000, armor: 300, weapon: 'WEAPON_MINIGUN',       accuracy: 30, damage: 1.5, color: '#ef4444', image: '' },
];

// Trigger -> action rules. "count" is multiplied by the number of gifts sent.
// effect: auto | none | pop | burst | shockwave | boss | heal | nuke | lightning
export const DEFAULT_RULES = [
  { id: 'r1',  enabled: true, trigger: { type: 'likes', every: 50 },              action: { type: 'spawn', tierId: 't1', count: 1 }, effect: 'auto' },
  { id: 'r2',  enabled: true, trigger: { type: 'follow' },                        action: { type: 'spawn', tierId: 't2', count: 1 }, effect: 'auto' },
  { id: 'r3',  enabled: true, trigger: { type: 'share' },                         action: { type: 'spawn', tierId: 't1', count: 3 }, effect: 'auto' },
  { id: 'r4',  enabled: true, trigger: { type: 'gift', gift: 'Rose' },            action: { type: 'spawn', tierId: 't3', count: 1 }, effect: 'auto' },
  { id: 'r5',  enabled: true, trigger: { type: 'gift', gift: 'TikTok' },          action: { type: 'spawn', tierId: 't4', count: 3 }, effect: 'auto' },
  { id: 'r6',  enabled: true, trigger: { type: 'gift', gift: 'Finger Heart' },    action: { type: 'spawn', tierId: 't5', count: 4 }, effect: 'auto' },
  { id: 'r7',  enabled: true, trigger: { type: 'gift', gift: 'Heart Me' },        action: { type: 'heal', amount: 500 },             effect: 'heal' },
  { id: 'r8',  enabled: true, trigger: { type: 'gift', gift: 'Doughnut' },        action: { type: 'spawn', tierId: 't6', count: 5 }, effect: 'auto' },
  { id: 'r9',  enabled: true, trigger: { type: 'gift', gift: 'Perfume' },         action: { type: 'heal', amount: 5000 },            effect: 'heal' },
  { id: 'r10', enabled: true, trigger: { type: 'gift', gift: 'Hand Hearts' },     action: { type: 'spawn', tierId: 't7', count: 10 }, effect: 'auto' },
  { id: 'r11', enabled: true, trigger: { type: 'gift', gift: 'Hat and Mustache' },action: { type: 'spawn', tierId: 't8', count: 28 }, effect: 'boss' },
  { id: 'r12', enabled: true, trigger: { type: 'gift', gift: 'Corgi' },           action: { type: 'airstrike', count: 15 },          effect: 'lightning' },
  { id: 'r13', enabled: true, trigger: { type: 'gift', gift: 'Galaxy' },          action: { type: 'spawn', tierId: 't9', count: 50 }, effect: 'boss' },
  { id: 'r14', enabled: true, trigger: { type: 'gift', gift: 'Lion' },            action: { type: 'killAll' },                       effect: 'nuke' },
];

export const DEFAULT_CONFIG = {
  port: 7420,
  openBrowser: true,
  tiktok: { username: '', autoConnect: false, autoReconnect: true, signApiKey: '' },
  health: {
    max: 50000,
    damageMultiplier: 1,
    regenPerSecond: 0,
    reviveSeconds: 12,
    clearEnemiesOnDeath: true,
    clearQueueOnDeath: false,
  },
  game: {
    hideHud: true,
    nameTags: true,
    maxAliveEnemies: 25,
    spawnIntervalMs: 250,
    spawnDistanceMin: 14,
    spawnDistanceMax: 28,
    maxQueue: 500,
    gtaPath: '',
  },
  overlay: {
    showTiers: true,
    showAlerts: true,
    showScoreboard: true,
    showLeaderboard: true,
    leaderboardSeconds: 8,
    alertSeconds: 4,
    sounds: true,
  },
  tiers: DEFAULT_TIERS,
  rules: DEFAULT_RULES,
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), saved);
  if (!Array.isArray(cfg.tiers) || !cfg.tiers.length) cfg.tiers = structuredClone(DEFAULT_TIERS);
  if (!Array.isArray(cfg.rules)) cfg.rules = structuredClone(DEFAULT_RULES);
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

// Validate/clean a config patch coming from the control panel.
export function applyPatch(cfg, patch) {
  const next = deepMerge(cfg, patch || {});
  if (Array.isArray(patch?.tiers)) next.tiers = patch.tiers.map(sanitizeTier).filter(Boolean);
  if (Array.isArray(patch?.rules)) next.rules = patch.rules.map(sanitizeRule).filter(Boolean);
  next.health.max = clampInt(next.health.max, 1, 10_000_000);
  next.health.damageMultiplier = clampNum(next.health.damageMultiplier, 0, 100);
  next.health.regenPerSecond = clampNum(next.health.regenPerSecond, 0, 1_000_000);
  next.health.reviveSeconds = clampInt(next.health.reviveSeconds, 1, 300);
  next.game.maxAliveEnemies = clampInt(next.game.maxAliveEnemies, 1, 120);
  next.game.spawnIntervalMs = clampInt(next.game.spawnIntervalMs, 0, 10_000);
  next.game.spawnDistanceMin = clampNum(next.game.spawnDistanceMin, 3, 200);
  next.game.spawnDistanceMax = Math.max(next.game.spawnDistanceMin, clampNum(next.game.spawnDistanceMax, 3, 300));
  next.game.maxQueue = clampInt(next.game.maxQueue, 1, 100_000);
  next.port = clampInt(next.port, 1024, 65535);
  next.overlay.alertSeconds = clampNum(next.overlay.alertSeconds, 1, 30);
  next.overlay.leaderboardSeconds = clampNum(next.overlay.leaderboardSeconds, 3, 60);
  return next;
}

function clampNum(v, lo, hi) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }
function clampInt(v, lo, hi) { return Math.round(clampNum(v, lo, hi)); }
const str = (v, max = 200) => String(v ?? '').slice(0, max);

function sanitizeTier(t) {
  if (!isObj(t) || !t.id) return null;
  return {
    id: str(t.id, 40),
    name: str(t.name, 60) || 'Enemy',
    model: str(t.model, 80).trim() || 's_m_y_swat_01',
    health: clampInt(t.health, 1, 1_000_000),
    armor: clampInt(t.armor, 0, 10_000),
    weapon: str(t.weapon, 60).trim().toUpperCase() || 'WEAPON_UNARMED',
    accuracy: clampInt(t.accuracy, 0, 100),
    damage: clampNum(t.damage, 0, 100),
    color: /^#[0-9a-f]{3,8}$/i.test(t.color) ? t.color : '#ffffff',
    image: str(t.image, 2000),
  };
}

const TRIGGERS = ['gift', 'likes', 'follow', 'share', 'chat'];
const ACTIONS = ['spawn', 'heal', 'damage', 'killAll', 'airstrike', 'slowmo', 'weapon', 'launch', 'clearQueue', 'none'];
const EFFECTS = ['auto', 'none', 'pop', 'burst', 'shockwave', 'boss', 'heal', 'nuke', 'lightning'];

function sanitizeRule(r) {
  if (!isObj(r) || !isObj(r.trigger) || !isObj(r.action)) return null;
  if (!TRIGGERS.includes(r.trigger.type) || !ACTIONS.includes(r.action.type)) return null;
  return {
    id: str(r.id, 40) || 'r' + Date.now().toString(36),
    enabled: r.enabled !== false,
    trigger: {
      type: r.trigger.type,
      gift: str(r.trigger.gift, 80).trim(),
      every: clampInt(r.trigger.every ?? 50, 1, 1_000_000),
      command: str(r.trigger.command, 60).trim().toLowerCase(),
      cooldown: clampInt(r.trigger.cooldown ?? 0, 0, 3600),
    },
    action: {
      type: r.action.type,
      tierId: str(r.action.tierId, 40),
      count: clampInt(r.action.count ?? 1, 1, 1000),
      amount: clampInt(r.action.amount ?? 0, 0, 10_000_000),
      seconds: clampNum(r.action.seconds ?? 5, 1, 60),
      weapon: str(r.action.weapon, 60).trim().toUpperCase(),
    },
    effect: EFFECTS.includes(r.effect) ? r.effect : 'auto',
  };
}
