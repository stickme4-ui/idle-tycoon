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
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    const cfg = getConfig();
    this.hp = cfg.health.max;
    this.dead = false;
    this.deadAt = 0;
    this.deaths = 0;
    this.kills = 0;
    this.alive = 0;
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
      deaths: this.deaths, kills: this.kills, alive: this.alive, queue: this.queue.length,
      game: { connected: this.game.connected, lastPoll: this.game.lastPoll, fivem: this.game.version.startsWith('fivem') },
      stats: this.stats,
      top: this.topSupporters(5),
    };
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
        this.applyDamage(amount, user.nickname);
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
  applyDamage(amount, source = '') {
    if (this.dead || amount <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this.emitHp(-amount, source);
    if (this.hp <= 0) this.knockOut();
  }

  knockOut() {
    if (this.dead) return;
    const cfg = this.getConfig();
    this.dead = true;
    this.deadAt = Date.now();
    this.hp = 0;
    this.deaths++;
    this.pushCmd('die');
    if (cfg.health.clearQueueOnDeath) this.queue.length = 0;
    this.emit('ko', { deaths: this.deaths });
    this.emitHp();
    this.emitStatus();
  }

  revive() {
    const cfg = this.getConfig();
    this.dead = false;
    this.hp = cfg.health.max;
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
    if (kills > 0) this.kills += kills;
    const dmg = parseFloat(q.get('dmg') || '0');
    if (dmg > 0) this.applyDamage(dmg * cfg.health.damageMultiplier, 'enemies');
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
        out.push(['spawn', `model=${ENC(tier.model)}`, `name=${ENC(tier.name)}`, `hp=${tier.health}`, `armor=${tier.armor}`,
          `weapon=${ENC(tier.weapon)}`, `acc=${tier.accuracy}`, `dmg=${tier.damage}`, `by=${ENC(user.nickname || user.uniqueId || '')}`].join('\t'));
        this.alive++;
      }
      if (n > 0) this.lastSpawnAt = now;
    }

    if (!wasConnected || dmg > 0 || kills > 0) this.emitStatus();
    return out.join('\n');
  }
}

// ---------- helpers ----------
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
