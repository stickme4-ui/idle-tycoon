import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'stats.json');
export const BOARDS = ['kills', 'damage', 'coins', 'sent'];
export const PERIODS = ['day', 'month', 'all'];

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthKey = (d = new Date()) => dayKey(d).slice(0, 7);

const emptyBoards = () => Object.fromEntries(BOARDS.map((b) => [b, {}]));

// Persistent arena stats + per-viewer leaderboards (daily / monthly / all-time).
export class Stats {
  constructor() {
    this.data = {
      arena: { deaths: 0, kills: 0, bestSurvival: 0, lastKiller: null, lastDeathAt: 0, killerStreak: 0 },
      day: { key: dayKey(), boards: emptyBoards() },
      month: { key: monthKey(), boards: emptyBoards() },
      all: { key: 'all', boards: emptyBoards() },
      profiles: {},
    };
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      for (const k of Object.keys(this.data)) if (saved[k]) this.data[k] = { ...this.data[k], ...saved[k] };
      for (const p of PERIODS) this.data[p].boards = { ...emptyBoards(), ...this.data[p].boards };
    } catch { /* first run */ }
    this.saveTimer = null;
    this.version = 0;
    this.rollover();
  }

  get arena() { return this.data.arena; }

  rollover() {
    if (this.data.day.key !== dayKey()) this.data.day = { key: dayKey(), boards: emptyBoards() };
    if (this.data.month.key !== monthKey()) this.data.month = { key: monthKey(), boards: emptyBoards() };
  }

  touch() {
    this.version++;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1500);
  }

  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(this.data));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.error('stats save failed', e.message); }
  }

  remember(user) {
    if (!user?.uniqueId || user.uniqueId === 'streamer') return null;
    const p = this.data.profiles[user.uniqueId] || {};
    p.nickname = user.nickname || p.nickname || user.uniqueId;
    if (user.avatar) p.avatar = user.avatar;
    this.data.profiles[user.uniqueId] = p;
    return user.uniqueId;
  }

  add(board, user, amount) {
    const id = this.remember(user);
    if (!id || !(amount > 0)) return;
    this.rollover();
    for (const p of PERIODS) {
      const b = this.data[p].boards[board];
      b[id] = (b[id] || 0) + amount;
    }
    this.touch();
  }

  top(period, board, n = 5) {
    this.rollover();
    const b = this.data[period]?.boards?.[board] || {};
    return Object.entries(b)
      .sort((x, y) => y[1] - x[1])
      .slice(0, n)
      .map(([id, value]) => ({ uniqueId: id, nickname: this.data.profiles[id]?.nickname || id, avatar: this.data.profiles[id]?.avatar || '', value: Math.round(value) }));
  }

  rank(period, board, uniqueId) {
    const b = this.data[period]?.boards?.[board] || {};
    if (!b[uniqueId]) return 0;
    return Object.values(b).filter((v) => v > b[uniqueId]).length + 1;
  }

  leaderboards(n = 5) {
    const out = { dayKey: this.data.day.key, monthKey: this.data.month.key };
    for (const p of PERIODS) { out[p] = {}; for (const b of BOARDS) out[p][b] = this.top(p, b, n); }
    return out;
  }

  reset(what) {
    if (what === 'day' || what === 'all') this.data.day = { key: dayKey(), boards: emptyBoards() };
    if (what === 'month' || what === 'all') this.data.month = { key: monthKey(), boards: emptyBoards() };
    if (what === 'alltime' || what === 'all') this.data.all = { key: 'all', boards: emptyBoards() };
    if (what === 'arena' || what === 'all') this.data.arena = { deaths: 0, kills: 0, bestSurvival: 0, lastKiller: null, lastDeathAt: 0, killerStreak: 0 };
    this.touch();
  }
}
