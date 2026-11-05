import { DurableObject } from 'cloudflare:workers';
import {
  MODELS,
  isValidModel,
  isValidCycles,
  currentPhase,
} from '../../extension/lib/models.js';

// ---------------------------------------------------------------------------
// Worker entry: CORS + forward every /api/* request to the single Hub object.
// One Durable Object holds all groups, so every operation is serialised and
// rules like "one group per person" and "unique join codes" cannot race.
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'nafas-team-break' });
    }
    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'not_found' }, 404);
    }
    const hub = env.HUB.get(env.HUB.idFromName('hub'));
    return hub.fetch(request);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ONLINE_WINDOW = 90 * 1000; // extension polls every 30s
const MAX_MEMBERS = 50;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 6;
const JOIN_FAILS_LIMIT = 10; // per user per 10 minutes
const REGISTER_LIMIT = 30; // per IP per hour

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        group_id TEXT,
        last_seen INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS users_group ON users(group_id);
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        model_id TEXT,
        cycles INTEGER,
        status TEXT NOT NULL,
        started_at INTEGER,
        paused_at INTEGER,
        paused_total INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_key ON attempts(kind, key, at);
    `);
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      const body =
        request.method === 'POST' ? await request.json().catch(() => ({})) : {};

      if (route === 'POST /api/register') {
        return json(await this.register(body, request));
      }

      const user = await this.authenticate(request);
      const now = Date.now();
      this.sql.exec('UPDATE users SET last_seen = ? WHERE id = ?', now, user.id);

      switch (route) {
        case 'GET /api/state':
          break;
        case 'POST /api/me/name':
          this.rename(user, body);
          break;
        case 'POST /api/groups/create':
          this.createGroup(user, body, now);
          break;
        case 'POST /api/groups/join':
          this.joinGroup(user, body, now);
          break;
        case 'POST /api/groups/leave':
          this.leaveGroup(user);
          break;
        case 'POST /api/groups/delete':
          this.deleteGroup(this.ownedGroup(user));
          break;
        case 'POST /api/groups/kick':
          this.kick(this.ownedGroup(user), body);
          break;
        case 'POST /api/groups/regenerate-code':
          this.regenerateCode(this.ownedGroup(user));
          break;
        case 'POST /api/groups/select-model':
          this.selectModel(this.ownedGroup(user), body, now);
          break;
        case 'POST /api/groups/start':
          this.start(this.ownedGroup(user), now);
          break;
        case 'POST /api/groups/pause':
          this.pause(this.ownedGroup(user), now);
          break;
        case 'POST /api/groups/resume':
          this.resume(this.ownedGroup(user), now);
          break;
        case 'POST /api/groups/stop':
          this.stop(this.ownedGroup(user), now);
          break;
        default:
          throw new HttpError(404, 'not_found');
      }
      return json(this.stateFor(user.id, Date.now()));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'خطای داخلی سرور' }, 500);
    }
  }

  // ---- identity ----------------------------------------------------------

  async register(body, request) {
    const name = cleanName(body.name);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    this.throttle('register', ip, REGISTER_LIMIT, 60 * 60 * 1000, now,
      'تعداد ثبت‌نام از این شبکه زیاد است؛ کمی بعد دوباره امتحان کن.');
    this.recordAttempt('register', ip, now);

    const id = randomId();
    const token = randomToken();
    this.sql.exec(
      'INSERT INTO users (id, token_hash, name, group_id, last_seen, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
      id, await sha256(token), name, now, now,
    );
    return { userId: id, token, ...this.stateFor(id, now) };
  }

  async authenticate(request) {
    const header = request.headers.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'unauthorized');
    const rows = this.sql
      .exec('SELECT * FROM users WHERE token_hash = ?', await sha256(token))
      .toArray();
    if (!rows.length) throw new HttpError(401, 'unauthorized');
    return rows[0];
  }

  rename(user, body) {
    this.sql.exec('UPDATE users SET name = ? WHERE id = ?', cleanName(body.name), user.id);
    if (user.group_id) this.bump(user.group_id);
  }

  // ---- groups ------------------------------------------------------------

  createGroup(user, body, now) {
    if (user.group_id) throw new HttpError(409, 'تو الان عضو یک گروه هستی. اول از آن خارج شو.');
    const name = cleanName(body.name, 'نام گروه');
    const id = randomId();
    this.sql.exec(
      `INSERT INTO groups (id, name, code, owner_id, status, created_at)
       VALUES (?, ?, ?, ?, 'idle', ?)`,
      id, name, this.uniqueCode(), user.id, now,
    );
    this.sql.exec('UPDATE users SET group_id = ? WHERE id = ?', id, user.id);
  }

  joinGroup(user, body, now) {
    if (user.group_id) throw new HttpError(409, 'تو الان عضو یک گروه هستی. اول از آن خارج شو.');
    this.throttle('join', user.id, JOIN_FAILS_LIMIT, 10 * 60 * 1000, now,
      'تلاش ناموفق زیاد بود؛ ۱۰ دقیقه‌ی دیگر دوباره امتحان کن.');
    const code = String(body.code || '').trim().toUpperCase().replace(/[\s-]/g, '');
    const group = this.sql.exec('SELECT * FROM groups WHERE code = ?', code).toArray()[0];
    if (!group) {
      this.recordAttempt('join', user.id, now);
      throw new HttpError(404, 'گروهی با این کد پیدا نشد.');
    }
    const count = this.sql
      .exec('SELECT COUNT(*) AS n FROM users WHERE group_id = ?', group.id)
      .one().n;
    if (count >= MAX_MEMBERS) throw new HttpError(409, 'ظرفیت این گروه پر است.');
    this.sql.exec('UPDATE users SET group_id = ? WHERE id = ?', group.id, user.id);
    this.bump(group.id);
  }

  leaveGroup(user) {
    if (!user.group_id) throw new HttpError(409, 'عضو هیچ گروهی نیستی.');
    const group = this.groupById(user.group_id);
    if (group && group.owner_id === user.id) {
      throw new HttpError(409, 'سازنده‌ی گروه نمی‌تواند خارج شود؛ می‌تواند گروه را حذف کند.');
    }
    this.sql.exec('UPDATE users SET group_id = NULL WHERE id = ?', user.id);
    if (group) this.bump(group.id);
  }

  deleteGroup(group) {
    this.sql.exec('UPDATE users SET group_id = NULL WHERE group_id = ?', group.id);
    this.sql.exec('DELETE FROM groups WHERE id = ?', group.id);
  }

  kick(group, body) {
    const target = String(body.userId || '');
    if (target === group.owner_id) throw new HttpError(400, 'سازنده را نمی‌شود حذف کرد.');
    const res = this.sql.exec(
      'UPDATE users SET group_id = NULL WHERE id = ? AND group_id = ?',
      target, group.id,
    );
    if (!res.rowsWritten) throw new HttpError(404, 'این عضو در گروه نیست.');
    this.bump(group.id);
  }

  regenerateCode(group) {
    this.sql.exec('UPDATE groups SET code = ? WHERE id = ?', this.uniqueCode(), group.id);
    this.bump(group.id);
  }

  // ---- schedule ----------------------------------------------------------

  selectModel(group, body, now) {
    const state = this.phaseOf(group, now).state;
    if (state === 'running' || state === 'paused') {
      throw new HttpError(409, 'اول تایمر فعلی را متوقف کن.');
    }
    const modelId = String(body.modelId || '');
    const cycles = Number(body.cycles);
    if (!isValidModel(modelId)) throw new HttpError(400, 'مدل نامعتبر است.');
    if (!isValidCycles(cycles)) throw new HttpError(400, 'تعداد حلقه باید بین ۱ تا ۸ باشد.');
    // Durations are never accepted from the client: only the model id.
    this.sql.exec(
      `UPDATE groups SET model_id = ?, cycles = ?, status = 'ready',
       started_at = NULL, paused_at = NULL, paused_total = 0 WHERE id = ?`,
      modelId, cycles, group.id,
    );
    this.bump(group.id);
  }

  start(group, now) {
    const state = this.phaseOf(group, now).state;
    if (state !== 'ready' && state !== 'finished') {
      throw new HttpError(409, state === 'idle' ? 'اول یک مدل انتخاب کن.' : 'تایمر در حال اجراست.');
    }
    this.sql.exec(
      `UPDATE groups SET status = 'running', started_at = ?, paused_at = NULL,
       paused_total = 0 WHERE id = ?`,
      now, group.id,
    );
    this.bump(group.id);
  }

  pause(group, now) {
    if (this.phaseOf(group, now).state !== 'running') throw new HttpError(409, 'تایمر در حال اجرا نیست.');
    this.sql.exec(`UPDATE groups SET status = 'paused', paused_at = ? WHERE id = ?`, now, group.id);
    this.bump(group.id);
  }

  resume(group, now) {
    if (group.status !== 'paused') throw new HttpError(409, 'تایمر متوقف موقت نیست.');
    this.sql.exec(
      `UPDATE groups SET status = 'running', paused_total = paused_total + ?,
       paused_at = NULL WHERE id = ?`,
      now - group.paused_at, group.id,
    );
    this.bump(group.id);
  }

  stop(group) {
    if (!group.model_id) throw new HttpError(409, 'تایمری برای توقف نیست.');
    this.sql.exec(
      `UPDATE groups SET status = 'ready', started_at = NULL, paused_at = NULL,
       paused_total = 0 WHERE id = ?`,
      group.id,
    );
    this.bump(group.id);
  }

  // ---- helpers -----------------------------------------------------------

  stateFor(userId, now) {
    const user = this.sql.exec('SELECT * FROM users WHERE id = ?', userId).one();
    const base = { serverTime: now, user: { id: user.id, name: user.name }, group: null };
    if (!user.group_id) return base;
    const g = this.groupById(user.group_id);
    if (!g) return base;
    const isOwner = g.owner_id === user.id;
    const members = this.sql
      .exec('SELECT id, name, last_seen FROM users WHERE group_id = ? ORDER BY created_at', g.id)
      .toArray()
      .map((m) => ({
        id: m.id,
        name: m.name,
        isOwner: m.id === g.owner_id,
        online: now - m.last_seen < ONLINE_WINDOW,
      }));
    return {
      ...base,
      group: {
        id: g.id,
        name: g.name,
        isOwner,
        code: isOwner ? g.code : null,
        members,
        version: g.version,
        schedule: this.scheduleOf(g),
      },
    };
  }

  scheduleOf(g) {
    return {
      modelId: g.model_id,
      cycles: g.cycles,
      status: g.status,
      startedAt: g.started_at,
      pausedAt: g.paused_at,
      pausedTotal: g.paused_total,
    };
  }

  phaseOf(g, now) {
    return currentPhase(this.scheduleOf(g), now);
  }

  ownedGroup(user) {
    const group = user.group_id ? this.groupById(user.group_id) : null;
    if (!group) throw new HttpError(409, 'عضو هیچ گروهی نیستی.');
    if (group.owner_id !== user.id) throw new HttpError(403, 'فقط سازنده‌ی گروه این کار را می‌تواند بکند.');
    return group;
  }

  groupById(id) {
    return this.sql.exec('SELECT * FROM groups WHERE id = ?', id).toArray()[0] || null;
  }

  bump(groupId) {
    this.sql.exec('UPDATE groups SET version = version + 1 WHERE id = ?', groupId);
  }

  uniqueCode() {
    for (let i = 0; i < 20; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
      const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      const taken = this.sql.exec('SELECT 1 FROM groups WHERE code = ?', code).toArray().length;
      if (!taken) return code;
    }
    throw new HttpError(500, 'ساخت کد ممکن نشد؛ دوباره امتحان کن.');
  }

  throttle(kind, key, limit, windowMs, now, message) {
    this.sql.exec('DELETE FROM attempts WHERE at < ?', now - 60 * 60 * 1000);
    const n = this.sql
      .exec('SELECT COUNT(*) AS n FROM attempts WHERE kind = ? AND key = ? AND at > ?', kind, key, now - windowMs)
      .one().n;
    if (n >= limit) throw new HttpError(429, message);
  }

  recordAttempt(kind, key, now) {
    this.sql.exec('INSERT INTO attempts (kind, key, at) VALUES (?, ?, ?)', kind, key, now);
  }
}

// ---------------------------------------------------------------------------

function cleanName(value, label = 'نام') {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) throw new HttpError(400, `${label} را وارد کن.`);
  if ([...name].length > 40) throw new HttpError(400, `${label} حداکثر ۴۰ نویسه است.`);
  return name;
}

function randomId() {
  return crypto.randomUUID();
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Exported only so tests can confirm the server reads the shared model table.
export { MODELS };
