import { EventEmitter } from 'node:events';
import { WebcastPushConnection } from 'tiktok-live-connector/legacy';

// Wraps the TikTok LIVE connection, normalizes events, handles gift streaks
// and auto-reconnects while the user wants to stay connected.
export class TikTokBridge extends EventEmitter {
  constructor() {
    super();
    this.conn = null;
    this.username = '';
    this.state = 'disconnected'; // disconnected | connecting | connected | waiting
    this.error = '';
    this.wanted = false;
    this.autoReconnect = true;
    this.retryTimer = null;
    this.retryDelay = 5000;
    this.gifts = [];           // available gifts in the room
    this.streaks = new Map();  // `${user}:${gift}:${group}` -> { count, at }
    this.roomId = '';
    setInterval(() => this.cleanStreaks(), 30_000).unref();
  }

  status() {
    return { state: this.state, username: this.username, error: this.error, roomId: this.roomId, giftCount: this.gifts.length };
  }

  setState(state, error = '') {
    this.state = state;
    this.error = error;
    this.emit('status', this.status());
  }

  async connect(username, { signApiKey = '', autoReconnect = true } = {}) {
    username = String(username || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?tiktok\.com\/@/, '').replace(/\/live.*$/, '');
    if (!username) throw new Error('missing username');
    await this.disconnect(false);
    this.username = username;
    this.wanted = true;
    this.autoReconnect = autoReconnect;
    this.signApiKey = signApiKey;
    this.retryDelay = 5000;
    return this.open();
  }

  async open() {
    clearTimeout(this.retryTimer);
    this.setState('connecting');
    const options = { enableExtendedGiftInfo: true, processInitialData: false };
    if (this.signApiKey) options.signApiKey = this.signApiKey;
    const conn = new WebcastPushConnection(this.username, options);
    this.conn = conn;
    this.attach(conn);
    try {
      const state = await conn.connect();
      if (this.conn !== conn) return;
      this.roomId = String(state?.roomId || conn.roomId || '');
      this.gifts = normalizeGiftList(state?.availableGifts || conn.availableGifts);
      this.emit('gifts', this.gifts);
      this.retryDelay = 5000;
      this.setState('connected');
    } catch (err) {
      if (this.conn !== conn) return;
      const msg = friendlyError(err);
      this.conn = null;
      try { await conn.disconnect(); } catch { /* ignore */ }
      if (this.wanted && this.autoReconnect) this.scheduleRetry(msg);
      else this.setState('disconnected', msg);
    }
  }

  scheduleRetry(msg) {
    this.setState('waiting', msg);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (this.wanted) this.open(); }, this.retryDelay);
    this.retryDelay = Math.min(60_000, Math.round(this.retryDelay * 1.6));
  }

  async disconnect(emit = true) {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    const conn = this.conn;
    this.conn = null;
    if (conn) { try { await conn.disconnect(); } catch { /* ignore */ } }
    if (emit) this.setState('disconnected');
  }

  attach(conn) {
    const live = () => this.conn === conn;

    conn.on('gift', (d) => {
      if (!live()) return;
      const user = userOf(d);
      const giftId = String(d.giftId ?? d.gift?.gift_id ?? '');
      const type = d.giftType ?? d.gift?.gift_type;
      const repeat = Math.max(1, Number(d.repeatCount ?? d.gift?.repeat_count ?? 1) || 1);
      let count;
      if (type === 1) {
        // Streakable gift: TikTok re-sends the running total; process only the delta.
        const key = `${user.id || user.uniqueId}:${giftId}:${d.groupId ?? ''}`;
        const prev = this.streaks.get(key)?.count || 0;
        count = repeat - prev;
        if (d.repeatEnd) this.streaks.delete(key);
        else this.streaks.set(key, { count: repeat, at: Date.now() });
        if (count <= 0) return;
      } else {
        count = repeat;
      }
      const ext = d.extendedGiftInfo || this.gifts.find((g) => g.id === giftId) || {};
      this.emit('event', {
        kind: 'gift', user, count,
        gift: {
          id: giftId,
          name: d.giftName || ext.name || 'Gift',
          image: d.giftPictureUrl || pickUrl(ext.image) || ext.image || '',
          diamonds: Number(d.diamondCount ?? ext.diamonds ?? ext.diamond_count ?? 0) || 0,
        },
      });
    });

    conn.on('like', (d) => {
      if (!live()) return;
      const count = Number(d.likeCount ?? d.count ?? 1) || 1;
      this.emit('event', { kind: 'like', user: userOf(d), count });
    });
    conn.on('follow', (d) => live() && this.emit('event', { kind: 'follow', user: userOf(d), count: 1 }));
    conn.on('share', (d) => live() && this.emit('event', { kind: 'share', user: userOf(d), count: 1 }));
    conn.on('chat', (d) => live() && this.emit('event', { kind: 'chat', user: userOf(d), count: 1, text: String(d.comment ?? d.content ?? '') }));
    conn.on('roomUser', (d) => live() && this.emit('viewers', Number(d.viewerCount ?? d.total ?? 0) || 0));

    const dropped = (reason) => {
      if (!live()) return;
      this.conn = null;
      if (this.wanted && this.autoReconnect) this.scheduleRetry(reason);
      else this.setState('disconnected', reason);
    };
    conn.on('streamEnd', () => dropped('The LIVE has ended'));
    conn.on('disconnected', () => dropped('Connection lost'));
    // Connect errors are already reported by open(); only surface errors while LIVE.
    conn.on('error', (err) => { if (live() && this.state === 'connected') this.emit('warn', friendlyError(err)); });
  }

  cleanStreaks() {
    const cutoff = Date.now() - 60_000;
    for (const [k, v] of this.streaks) if (v.at < cutoff) this.streaks.delete(k);
  }
}

function userOf(d) {
  const u = d.user && typeof d.user === 'object' ? { ...d.user, ...d } : d;
  return {
    id: String(u.userId ?? u.id ?? ''),
    uniqueId: String(u.uniqueId ?? u.displayId ?? 'viewer'),
    nickname: String(u.nickname || u.uniqueId || 'Viewer'),
    avatar: u.profilePictureUrl || pickUrl(u.avatarThumb) || '',
  };
}

function pickUrl(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  const list = img.url_list || img.urlList || img.url || img.m_urls;
  return Array.isArray(list) ? list[0] || '' : '';
}

export function normalizeGiftList(raw) {
  let list = raw;
  if (list && !Array.isArray(list)) list = list.gifts || list.data?.gifts || list.giftList || [];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const g of list) {
    const id = String(g.id ?? g.giftId ?? '');
    const name = String(g.name ?? g.giftName ?? '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, diamonds: Number(g.diamond_count ?? g.diamondCount ?? 0) || 0, image: pickUrl(g.image ?? g.icon) });
  }
  return out.sort((a, b) => a.diamonds - b.diamonds || a.name.localeCompare(b.name));
}

function friendlyError(err) {
  const name = err?.constructor?.name || '';
  const inner = err?.exception || err?.error;
  let msg = err?.message || inner?.message || err?.info || (typeof err === 'string' ? err : '');
  if (!msg) { try { msg = JSON.stringify(err).slice(0, 200); } catch { msg = 'Unknown error'; } }
  msg = String(msg);
  if (name === 'UserOfflineError' || /offline|not.*live|isn't online/i.test(msg)) return 'The user is not LIVE right now';
  if (name === 'SignatureRateLimitError' || /rate.?limit/i.test(msg)) return 'Rate limited by the sign server - waiting and retrying';
  if (name === 'InvalidUniqueIdError') return 'Invalid TikTok username';
  return msg.slice(0, 300);
}
