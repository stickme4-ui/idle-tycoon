import { EventEmitter } from 'node:events';

// The engine owns the authoritative game state (health, queue, stats),
// turns normalized LIVE events into actions, and feeds commands to the GTA mod.
//
// Normalized event shape:
//   { kind: 'gift'|'like'|'follow'|'share'|'chat',
//     user: { id, uniqueId, nickname, avatar },
//     gift?: { id, name, image, diamonds }, count, text?, test? }

const ENC = (v) => encodeURIComponent(String(v ?? ''));

export class Engine extends EventEmitter {
  constructor(getConfig, board) {
    super();
    this.getConfig = getConfig;
    this.board = board;       // persistent arena stats + leaderboards (stats.js)
    const cfg = getConfig();
    this.hp = cfg.health.max;
    this.dead = false;
    this.deadAt = 0;
    this.alive = 0;
    this.spawnMap = new Map(); // spawn id -> { user, tier } (who sent each enemy)
    this.nextSpawnId = 1;
    this.lastHit = null;       // { user, tier, at } last viewer-attributed damage
    this.lifeStartedAt = Date.now();
    this.lifeDamage = new Map(); // uniqueId -> { user, dmg } during the current life
    this.queue = [];          // pending spawns: { tier, user }
    this.commands = [];       // pending game command lines
    this.likeAcc = new Map(); // ruleId -> accumulated likes
    this.cooldowns = new Map();
    this.followed = new Set();
    this.lastSpawnAt = 0;
    this.lastCfgSentAt = 0;
    this.cfgDirty = true;
    this.game = { connected: false, lastPoll: 0, version: '' };
    this.stats = { likes: 0, gifts: 0, coins: 0, follows: 0, shares: 0, chats: 0, viewers: 0 };
    this.supporters = new Map(); // uniqueId -> { nickname, avatar, coins }

    setInterval(() => this.tick(), 1000).unref();
  }

  // ---------- public state ----------
  snapshot() {
    const cfg = this.getConfig();
    return {
      hp: Math.round(this.hp), max: cfg.health.max, dead: this.dead,
      deaths: this.board.arena.deaths, kills: this.board.arena.kills, alive: this.alive, queue: this.queue.length,
      arena: this.arenaState(),
      game: { connected: this.game.connected, lastPoll: this.game.lastPoll, fivem: this.game.version.startsWith('fivem') },
      stats: this.stats,
      top: this.topSupporters(5),
    };
  }

  arenaState() {
    const a = this.board.arena;
    const mvp = this.lifeMvp();
    return {
      deaths: a.deaths, kills: a.kills, bestSurvival: a.bestSurvival,
      lastKiller: a.lastKiller, killerStreak: a.killerStreak, lastDeathAt: a.lastDeathAt,
      lifeStartedAt: this.lifeStartedAt, dead: this.dead,
      mvp: mvp ? { nickname: mvp.user.nickname, avatar: mvp.user.avatar || '', dmg: Math.round(mvp.dmg) } : null,
    };
  }

  lifeMvp() {
    let best = null;
    for (const v of this.lifeDamage.values()) if (!best || v.dmg > best.dmg) best = v;
    return best;
  }

  topSupporters(n) {
    return [...this.supporters.entries()]
      .map(([uniqueId, v]) => ({ uniqueId, ...v }))
      .sort((a, b) => b.coins - a.coins)
      .slice(0, n);
  }

  emitHp(delta = 0, source = '') {
    this.emit('hp', { hp: Math.round(this.hp), max: this.getConfig().health.max, dead: this.dead, delta: Math.round(delta), source });
  }

  emitStatus() { this.emit('status', this.snapshot()); }

  configChanged() {
    this.cfgDirty = true;
    const max = this.getConfig().health.max;
    if (this.hp > max) this.hp = max;
    this.emitHp();
  }

  // ---------- LIVE events ----------
  handleEvent(ev) {
    const cfg = this.getConfig();
    const user = ev.user || { uniqueId: 'viewer', nickname: 'Viewer' };
    switch (ev.kind) {
      case 'like': this.stats.likes += ev.count; break;
      case 'gift': {
        this.stats.gifts += ev.count;
        const coins = (ev.gift?.diamonds || 0) * ev.count;
        this.stats.coins += coins;
        const s = this.supporters.get(user.uniqueId) || { nickname: user.nickname, avatar: user.avatar, coins: 0 };
        s.coins += coins; s.nickname = user.nickname; s.avatar = user.avatar || s.avatar;
        this.supporters.set(user.uniqueId, s);
        this.board.add('coins', user, coins);
        break;
      }
      case 'follow': this.stats.follows++; break;
      case 'share': this.stats.shares++; break;
      case 'chat': this.stats.chats++; break;
    }

    this.emit('log', { kind: ev.kind, user: user.nickname || user.uniqueId, text: describeEvent(ev), test: !!ev.test });

    for (const rule of cfg.rules) {
      if (!rule.enabled) continue;
      const times = this.matchRule(rule, ev);
      if (times > 0) this.fire(rule, ev, times);
    }
    this.emitStatus();
  }

  matchRule(rule, ev) {
    const t = rule.trigger;
    const user = ev.user || {};
    switch (t.type) {
      case 'gift': {
        if (ev.kind !== 'gift' || !t.gift) return 0;
        const want = t.gift.toLowerCase();
        const ok = (ev.gift?.name || '').toLowerCase() === want || String(ev.gift?.id ?? '') === t.gift;
        return ok ? ev.count : 0;
      }
      case 'likes': {
        if (ev.kind !== 'like') return 0;
        const every = Math.max(1, t.every || 50);
        let acc = (this.likeAcc.get(rule.id) || 0) + ev.count;
        const times = Math.floor(acc / every);
        acc -= times * every;
        this.likeAcc.set(rule.id, acc);
        return times;
      }
      case 'follow': {
        if (ev.kind !== 'follow') return 0;
        if (!ev.test) {
          const key = rule.id + ':' + user.uniqueId;
          if (this.followed.has(key)) return 0; // unfollow/refollow spam
          this.followed.add(key);
        }
        return 1;
      }
      case 'share':
        if (ev.kind !== 'share') return 0;
        return this.passCooldown(rule, user, Math.max(t.cooldown || 0, 10)) ? 1 : 0;
      case 'chat': {
        if (ev.kind !== 'chat' || !t.command) return 0;
        const text = (ev.text || '').trim().toLowerCase();
        if (!(text === t.command || text.startsWith(t.command + ' '))) return 0;
        return this.passCooldown(rule, user, t.cooldown || 0) ? 1 : 0;
      }
    }
    return 0;
  }

  passCooldown(rule, user, seconds) {
    if (!seconds) return true;
    const key = rule.id + ':' + (user.uniqueId || '?');
    const now = Date.now();
    if ((this.cooldowns.get(key) || 0) > now) return false;
    this.cooldowns.set(key, now + seconds * 1000);
    return true;
  }

  fire(rule, ev, times) {
    const cfg = this.getConfig();
    const a = rule.action;
    const user = ev.user || {};
    let text = '';
    let tier = null;

    switch (a.type) {
      case 'spawn': {
        tier = cfg.tiers.find((t) => t.id === a.tierId);
        if (!tier) return;
        const total = Math.max(1, (a.count || 1) * times);
        const room = Math.max(0, cfg.game.maxQueue - this.queue.length);
        const n = Math.min(total, room);
        for (let i = 0; i < n; i++) this.queue.push({ tier, user });
        this.board.add('sent', user, n);
        text = `sent ${total}x ${tier.name}`;
        break;
      }
      case 'heal': {
        const amount = (a.amount || 0) * times;
        if (this.dead) { text = 'tried to heal (too late!)'; break; }
        const before = this.hp;
        this.hp = Math.min(cfg.health.max, this.hp + amount);
        this.emitHp(this.hp - before, user.nickname);
        this.pushCmd('healfx');
        text = `healed +${amount.toLocaleString('en-US')} HP`;
        break;
      }
      case 'damage': {
        const amount = (a.amount || 0) * times;
        this.applyDamage(amount, { user, label: ev.gift?.name || 'gift' });
        text = `dealt ${amount.toLocaleString('en-US')} damage`;
        break;
      }
      case 'killAll':
        this.pushCmd('killall');
        text = 'NUKED every enemy!';
        break;
      case 'airstrike': {
        const n = (a.count || 5) * times;
        this.pushCmd('airstrike', { n });
        text = `called an airstrike on ${n} enemies`;
        break;
      }
      case 'slowmo':
        this.pushCmd('slowmo', { s: (a.seconds || 5) * Math.min(times, 6) });
        text = 'activated slow motion';
        break;
      case 'weapon':
        this.pushCmd('weapon', { w: a.weapon || 'WEAPON_RPG' });
        text = `gave you a ${prettyWeapon(a.weapon)}`;
        break;
      case 'launch':
        this.pushCmd('launch', { f: 25 + 5 * Math.min(times, 10) });
        text = 'launched you into the air';
        break;
      case 'clearQueue':
        this.queue.length = 0;
        text = 'cleared the enemy queue';
        break;
      default:
        text = describeEvent(ev);
    }

    const coins = (ev.gift?.diamonds || 0) * times;
    this.emit('alert', {
      user: user.nickname || user.uniqueId || 'Viewer',
      avatar: user.avatar || '',
      label: triggerLabel(rule, ev, times),
      image: ev.gift?.image || '',
      count: times,
      text,
      coins,
      color: tier?.color || actionColor(a.type),
      effect: pickEffect(rule, a, tier, cfg, coins),
      tierIndex: tier ? cfg.tiers.indexOf(tier) : -1,
    });
  }

  // ---------- health ----------
  // src: { user?, tier?, label? } - who dealt the damage (for kill credit & leaderboards)
  applyDamage(amount, src = {}) {
    if (this.dead || amount <= 0) return;
    const dealt = Math.min(amount, this.hp);
    this.hp = Math.max(0, this.hp - amount);
    const user = src.user && src.user.uniqueId !== 'streamer' ? src.user : null;
    if (user) {
      this.lastHit = { user, tier: src.tier || null, label: src.label || '', at: Date.now() };
      const d = this.lifeDamage.get(user.uniqueId) || { user, dmg: 0 };
      d.dmg += dealt;
      this.lifeDamage.set(user.uniqueId, d);
      this.board.add('damage', user, dealt);
    }
    this.emitHp(-amount, user ? user.nickname : src.label || '');
    if (this.hp <= 0) this.knockOut();
  }

  knockOut() {
    if (this.dead) return;
    const cfg = this.getConfig();
    const now = Date.now();
    const a = this.board.arena;
    this.dead = true;
    this.deadAt = now;
    this.hp = 0;

    // Kill credit: the viewer whose enemy/gift dealt the last damage (within 15 s).
    const hit = this.lastHit && now - this.lastHit.at < 15000 ? this.lastHit : null;
    const survival = now - this.lifeStartedAt;
    const newRecord = survival > a.bestSurvival;
    if (newRecord) a.bestSurvival = survival;
    a.deaths++;
    a.lastDeathAt = now;
    let killer = null;
    if (hit) {
      const u = hit.user;
      a.killerStreak = a.lastKiller?.uniqueId === u.uniqueId ? (a.killerStreak || 0) + 1 : 1;
      a.lastKiller = { uniqueId: u.uniqueId, nickname: u.nickname || u.uniqueId, avatar: u.avatar || '', tier: hit.tier?.name || hit.label || '', color: hit.tier?.color || '#ef4444', at: now };
      const prevTop = this.board.top('month', 'kills', 1)[0]?.uniqueId;
      this.board.add('kills', u, 1);
      const monthRank = this.board.rank('month', 'kills', u.uniqueId);
      killer = { ...a.lastKiller, streak: a.killerStreak, monthKills: this.board.data.month.boards.kills[u.uniqueId] || 1, monthRank, newNumberOne: monthRank === 1 && prevTop !== u.uniqueId };
    }
    const mvp = this.lifeMvp();
    this.board.touch();
    this.lastHit = null;

    this.pushCmd('die');
    if (cfg.health.clearQueueOnDeath) this.queue.length = 0;
    this.emit('ko', {
      deaths: a.deaths, killer, survival, newRecord,
      mvp: mvp ? { nickname: mvp.user.nickname, avatar: mvp.user.avatar || '', dmg: Math.round(mvp.dmg) } : null,
    });
    this.emitHp();
    this.emitStatus();
  }

  revive() {
    const cfg = this.getConfig();
    this.dead = false;
    this.hp = cfg.health.max;
    this.lifeStartedAt = Date.now();
    this.lifeDamage.clear();
    if (cfg.health.clearEnemiesOnDeath) this.pushCmd('clear');
    this.emit('revive', {});
    this.emitHp();
    this.emitStatus();
  }

  resetHp() {
    if (this.dead) return this.revive();
    const before = this.hp;
    this.hp = this.getConfig().health.max;
    this.emitHp(this.hp - before, 'reset');
  }

  tick() {
    const cfg = this.getConfig();
    const now = Date.now();
    if (this.game.connected && now - this.game.lastPoll > 4000) {
      this.game.connected = false;
      this.emitStatus();
    }
    if (this.dead && now - this.deadAt > cfg.health.reviveSeconds * 1000) this.revive();
    if (!this.dead && cfg.health.regenPerSecond > 0 && this.hp < cfg.health.max) {
      this.hp = Math.min(cfg.health.max, this.hp + cfg.health.regenPerSecond);
      this.emitHp();
    }
  }

  // ---------- manual control from the panel ----------
  manual(action) {
    const fakeRule = { id: 'manual', trigger: { type: 'manual' }, action, effect: action.effect || 'auto' };
    this.fire(fakeRule, { kind: 'manual', user: { uniqueId: 'streamer', nickname: 'Streamer' }, count: 1 }, 1);
    this.emitStatus();
  }

  // ---------- game bridge (polled by the GTA mod) ----------
  pushCmd(name, args = {}) {
    let line = name;
    for (const [k, v] of Object.entries(args)) line += `\t${k}=${ENC(v)}`;
    this.commands.push(line);
    if (this.commands.length > 500) this.commands.splice(0, this.commands.length - 500);
  }

  poll(q) {
    const cfg = this.getConfig();
    const now = Date.now();
    const wasConnected = this.game.connected;
    this.game.connected = true;
    this.game.lastPoll = now;
    this.game.version = q.get('v') || '';

    const alive = parseInt(q.get('alive') || '0', 10);
    if (Number.isFinite(alive)) this.alive = alive;
    const kills = parseInt(q.get('kills') || '0', 10);
    if (kills > 0 && kills < 1000) { this.board.arena.kills += kills; this.board.touch(); }
    const dmg = parseFloat(q.get('dmg') || '0');
    if (dmg > 0) this.applyGameDamage(dmg, q.get('hits') || '', cfg.health.damageMultiplier);
    if (q.get('died') === '1' && !this.dead) this.knockOut();
    if (q.get('respawn') === '1' && this.dead) this.revive();

    const out = [];
    if (this.cfgDirty || !wasConnected || now - this.lastCfgSentAt > 5000 || q.get('hello') === '1') {
      const g = cfg.game;
      out.push(`config\thidehud=${g.hideHud ? 1 : 0}\tnametags=${g.nameTags ? 1 : 0}\tdmin=${g.spawnDistanceMin}\tdmax=${g.spawnDistanceMax}`);
      this.cfgDirty = false;
      this.lastCfgSentAt = now;
    }
    out.push(...this.commands.splice(0));

    // Dispatch queued spawns respecting the alive cap and spawn rate.
    if (!this.dead && this.queue.length) {
      const room = cfg.game.maxAliveEnemies - this.alive;
      let n = 0;
      if (cfg.game.spawnIntervalMs === 0) n = room;
      else if (now - this.lastSpawnAt >= cfg.game.spawnIntervalMs) n = Math.min(room, 1 + Math.floor(150 / Math.max(1, cfg.game.spawnIntervalMs)));
      n = Math.min(n, this.queue.length, 6);
      for (let i = 0; i < n; i++) {
        const { tier, user } = this.queue.shift();
        const id = this.nextSpawnId++;
        this.spawnMap.set(String(id), { user, tier });
        if (this.spawnMap.size > 3000) this.spawnMap.delete(this.spawnMap.keys().next().value);
        out.push(['spawn', `id=${id}`, `model=${ENC(tier.model)}`, `name=${ENC(tier.name)}`, `hp=${tier.health}`, `armor=${tier.armor}`,
          `weapon=${ENC(tier.weapon)}`, `acc=${tier.accuracy}`, `dmg=${tier.damage}`, `by=${ENC(tagName(user))}`, `color=${ENC(tier.color)}`].join('\t'));
        this.alive++;
      }
      if (n > 0) this.lastSpawnAt = now;
    }

    if (!wasConnected || dmg > 0 || kills > 0) this.emitStatus();
    return out.join('\n');
  }

  // hits = "spawnId:amount,spawnId:amount" (damage the game attributed to specific enemies)
  applyGameDamage(total, hits, mult) {
    const attributed = [];
    let sum = 0;
    for (const part of hits.split(',')) {
      const [id, amt] = part.split(':');
      const v = parseFloat(amt);
      const info = this.spawnMap.get(id);
      if (!info || !(v > 0)) continue;
      attributed.push([info, v]);
      sum += v;
    }
    // World damage first (falls, cars...), viewer hits last so the final blow gets the credit.
    const rest = total - sum;
    if (rest > 0.5) this.applyDamage(rest * mult, { label: 'enemies' });
    for (const [info, v] of attributed) this.applyDamage(v * mult, { user: info.user, tier: info.tier });
  }
}

// ---------- helpers ----------

// Name shown above an enemy's head in GTA. GTA's fonts only have Latin glyphs,
// so Hebrew/emoji nicknames would render as boxes: strip unsupported characters
// (and GTA text-formatting codes like ~r~), falling back to the @username.
export function tagName(user = {}) {
  if (!user.uniqueId || user.uniqueId === 'streamer') return '';
  const clean = (s) => String(s || '').replace(/[^\x20-\x7E\u00C0-\u00FF]/g, '').replace(/[~<>\\]/g, '').replace(/\s+/g, ' ').trim();
  const nick = clean(user.nickname);
  const letters = (nick.match(/[A-Za-z0-9\u00C0-\u00FF]/g) || []).length;
  const name = letters >= 2 ? nick : clean(user.uniqueId);
  return name.slice(0, 20);
}
function describeEvent(ev) {
  switch (ev.kind) {
    case 'gift': return `${ev.gift?.name || 'Gift'} x${ev.count}`;
    case 'like': return `${ev.count} likes`;
    case 'follow': return 'followed';
    case 'share': return 'shared the LIVE';
    case 'chat': return ev.text || '';
    default: return '';
  }
}

function triggerLabel(rule, ev, times) {
  switch (rule.trigger.type) {
    case 'gift': return `${ev.gift?.name || rule.trigger.gift}${times > 1 ? ' x' + times : ''}`;
    case 'likes': return `${(rule.trigger.every * times).toLocaleString('en-US')} Likes`;
    case 'follow': return 'New Follower';
    case 'share': return 'Shared the LIVE';
    case 'chat': return rule.trigger.command;
    default: return 'Streamer';
  }
}

function actionColor(type) {
  return { heal: '#22c55e', damage: '#ef4444', killAll: '#facc15', airstrike: '#fb923c', slowmo: '#38bdf8', weapon: '#a78bfa', launch: '#f472b6' }[type] || '#ffffff';
}

function pickEffect(rule, action, tier, cfg, coins) {
  if (rule.effect && rule.effect !== 'auto') return rule.effect;
  if (action.type === 'heal') return 'heal';
  if (action.type === 'killAll') return 'nuke';
  if (action.type === 'airstrike') return 'lightning';
  if (tier && cfg.tiers.indexOf(tier) >= cfg.tiers.length - 2) return 'boss';
  if (coins >= 100) return 'shockwave';
  if (coins >= 10) return 'burst';
  return 'pop';
}

function prettyWeapon(w = '') {
  return w.replace(/^WEAPON_/, '').toLowerCase().replace(/(^|_)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase()) || 'weapon';
}
