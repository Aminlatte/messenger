// Messenger core: Worker (API) + D1 (data) + Durable Object "Hub" (one per user, holds that user's WebSockets).
// Every query is scoped to the authenticated user server-side; users can only be found by exact username.
import { DurableObject } from 'cloudflare:workers';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, name TEXT, username TEXT UNIQUE COLLATE NOCASE, lang TEXT, online INTEGER DEFAULT 0, last_seen INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY, uid TEXT NOT NULL, ts INTEGER)',
  'CREATE TABLE IF NOT EXISTS chats(uid TEXT, peer TEXT, read_id INTEGER DEFAULT 0, PRIMARY KEY(uid, peer))',
  'CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT, sender TEXT, body TEXT, ts INTEGER, del INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS msgs_pair ON msgs(a, b, id)',
  'CREATE TABLE IF NOT EXISTS hides(mid INTEGER, uid TEXT, PRIMARY KEY(mid, uid))',
  'CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, owner TEXT, a TEXT, b TEXT, name TEXT, size INTEGER, mime TEXT, chunks INTEGER, done INTEGER DEFAULT 0, ts INTEGER)',
  'CREATE TABLE IF NOT EXISTS pins(a TEXT, b TEXT, mid INTEGER, PRIMARY KEY(a, b))',
];
const CH = 1048576, MAXF = 100 * 2 ** 20, QUOTA = 512 * 2 ** 20; // 1 MiB chunks, 100 MB per file, 512 MB per user
const SAFE = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|webm|wav))$/; // only these are shown inline

const enc = new TextEncoder(), dec = new TextDecoder();
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const E = (e, s = 400) => J({ e }, s); // error codes are translated on the client (fa/en)
const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');
const pub = u => ({ id: u.id, name: u.name, username: u.username, lang: u.lang });
const hub = (env, id) => env.HUB.get(env.HUB.idFromName(id));
const push = (env, id, evt) => hub(env, id).push(evt).catch(() => {});
const Q = (env, sql, ...a) => env.DB.prepare(sql).bind(...a);

// Create tables on first request (no manual migration step needed when deploying from a phone)
let ready, keys, keysAt = 0;
const init = env => (ready ??= (async () => {
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  await env.DB.prepare('ALTER TABLE msgs ADD COLUMN fid TEXT').run().catch(() => {}); // fails harmlessly once the column exists
  await env.DB.prepare('ALTER TABLE users ADD COLUMN pw TEXT').run().catch(() => {});
})().catch(e => { ready = null; throw e; }));

// Verify a Google ID token (RS256) against Google's public keys
async function verifyGoogle(idt, env) {
  const [h, p, s] = String(idt).split('.');
  if (!s) throw 0;
  const head = JSON.parse(dec.decode(b64(h)));
  if (!keys || Date.now() - keysAt > 36e5) {
    keys = (await (await fetch('https://www.googleapis.com/oauth2/v3/certs')).json()).keys;
    keysAt = Date.now();
  }
  const jwk = keys.find(k => k.kid === head.kid);
  if (!jwk) throw 0;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(s), enc.encode(h + '.' + p)))) throw 0;
  const c = JSON.parse(dec.decode(b64(p)));
  if (c.aud !== env.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(c.iss) || c.exp * 1000 < Date.now() || !c.email_verified) throw 0;
  return c;
}

async function login(req, env) {
  let c;
  try { c = await verifyGoogle((await req.json()).credential, env); } catch { return E('badtoken', 401); }
  let u = await Q(env, 'SELECT * FROM users WHERE sub=?', c.sub).first();
  if (!u) {
    u = { id: crypto.randomUUID(), name: String(c.name || '').slice(0, 60) };
    await Q(env, 'INSERT INTO users(id,sub,name) VALUES(?,?,?)', u.id, c.sub, u.name).run();
  }
  const tok = crypto.randomUUID() + crypto.randomUUID();
  await Q(env, 'INSERT INTO sessions(h,uid,ts) VALUES(?,?,?)', await sha(tok), u.id, Date.now()).run();
  return J(pub(u), 200, { 'set-cookie': `sid=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` });
}

const ub64 = a => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');

async function session(env, u) {
  const tok = crypto.randomUUID() + crypto.randomUUID();
  await Q(env, 'INSERT INTO sessions(h,uid,ts) VALUES(?,?,?)', await sha(tok), u.id, Date.now()).run();
  return J(pub(u), 200, { 'set-cookie': `sid=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` });
}

// Username + password accounts. PBKDF2 runs inside the user's Durable Object (a Worker's 10 ms CPU limit is too small for it).
async function passAuth(req, env, reg) {
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  if (!(await hub(env, 'ip:' + ip).take(4).catch(() => true))) return E('rate', 429); // per-IP throttle
  const b = await req.json().catch(() => ({})), un = String(b.username || ''), pw = String(b.password || '');
  if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(un)) return E('invalid');
  if (pw.length < 8 || pw.length > 128) return E('weak');
  if (reg) {
    if (await Q(env, 'SELECT 1 x FROM users WHERE username=?', un).first()) return E('taken', 409);
    const id = crypto.randomUUID(), salt = ub64(crypto.getRandomValues(new Uint8Array(16)));
    const h = await hub(env, id).derive(pw, salt);
    try {
      await Q(env, 'INSERT INTO users(id,sub,name,username,pw) VALUES(?,?,?,?,?)', id, 'pw:' + id, String(b.name || '').trim().slice(0, 60) || un, un, salt + ':' + h).run();
    } catch (e) { return /UNIQUE/i.test(String(e)) ? E('taken', 409) : E('server', 500); }
    return session(env, await Q(env, 'SELECT * FROM users WHERE id=?', id).first());
  }
  const u = await Q(env, 'SELECT * FROM users WHERE username=? AND pw IS NOT NULL', un).first();
  if (!u) return E('badlogin', 401);
  const r = await hub(env, u.id).verify(pw, u.pw);
  return r.wait ? E('rate', 429) : r.ok ? session(env, u) : E('badlogin', 401);
}

async function auth(req, env) {
  const m = /(?:^|; )sid=([\w-]+)/.exec(req.headers.get('cookie') || '');
  return m ? Q(env, 'SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.h=?', await sha(m[1])).first() : null;
}

// Authorised download with Range support (video seeking). Only the two chat participants can read a file.
async function serveFile(req, env, u, id) {
  const f = await Q(env, 'SELECT * FROM files WHERE id=? AND done=1', id).first();
  if (!f || (f.a !== u.id && f.b !== u.id)) return E('notfound', 404);
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || ''), ranged = !!(m && (m[1] || m[2]));
  let s = 0, e = f.size - 1;
  if (ranged) { if (m[1]) { s = +m[1]; if (m[2]) e = Math.min(+m[2], e); } else s = Math.max(0, f.size - +m[2]); }
  if (s > e) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${f.size}` } });
  const store = env.FILES.get(env.FILES.idFromName(f.id));
  let n = Math.floor(s / CH);
  const stream = new ReadableStream({
    async pull(c) {
      if (n * CH > e) return c.close();
      const buf = new Uint8Array(await store.read(n));
      c.enqueue(buf.subarray(Math.max(s - n * CH, 0), Math.min(e - n * CH + 1, buf.length)));
      n++;
    },
  });
  return new Response(stream, {
    status: ranged ? 206 : 200,
    headers: {
      'content-type': f.mime, 'content-length': String(e - s + 1), 'accept-ranges': 'bytes',
      ...(ranged ? { 'content-range': `bytes ${s}-${e}/${f.size}` } : {}),
      'content-disposition': `${f.mime === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox',
    },
  });
}

export default {
  async scheduled(ev, env) { // hourly cron: drop abandoned uploads (>2h) and sessions older than a year
    await init(env);
    const old = (await Q(env, 'SELECT id FROM files WHERE done=0 AND ts<?', Date.now() - 72e5).all()).results;
    for (const { id } of old) {
      await env.FILES.get(env.FILES.idFromName(id)).wipe().catch(() => {});
      await Q(env, 'DELETE FROM files WHERE id=?', id).run();
    }
    await Q(env, 'DELETE FROM sessions WHERE ts<?', Date.now() - 365 * 864e5).run();
  },

  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname, GET = req.method === 'GET', s = url.searchParams;
    try {
      await init(env);
      const o = req.headers.get('origin'); // block cross-site writes / WebSocket hijacking
      if ((!GET || p === '/api/ws') && o && new URL(o).host !== url.host) return E('forbidden', 403);
      if (p === '/api/config') return J({ clientId: /^PASTE/.test(env.GOOGLE_CLIENT_ID || 'PASTE') ? '' : env.GOOGLE_CLIENT_ID }); // '' = Google sign-in disabled
      if (p === '/api/auth/google' && !GET) return login(req, env);
      if (p === '/api/auth/register' && !GET) return passAuth(req, env, true);
      if (p === '/api/auth/login' && !GET) return passAuth(req, env, false);

      const u = await auth(req, env);
      if (!u) return E('auth', 401);
      if (!u.username && p !== '/api/me' && p !== '/api/logout') return E('forbidden', 403);

      // files: raw chunk upload (PUT) and authorised download (GET); must run before JSON body parsing
      const fm = /^\/api\/file\/([\w-]{36})(?:\/(\d+))?$/.exec(p);
      if (fm && GET) return serveFile(req, env, u, fm[1]);
      if (fm && req.method === 'PUT') {
        const f = await Q(env, 'SELECT * FROM files WHERE id=? AND owner=? AND done=0', fm[1], u.id).first();
        const n = +fm[2];
        if (!f || !(n >= 0 && n < f.chunks)) return E('notfound', 404);
        const buf = await req.arrayBuffer();
        if (buf.byteLength !== (n < f.chunks - 1 ? CH : f.size - CH * (f.chunks - 1))) return E('bad');
        await env.FILES.get(env.FILES.idFromName(f.id)).write(n, buf);
        return J({ ok: 1 });
      }
      // per-user token bucket (lives in the user's Durable Object) for every write
      if (req.method === 'POST' && !(await hub(env, u.id).take(1).catch(() => true))) return E('rate', 429);
      const body = GET ? {} : await req.json().catch(() => ({}));

      if (p === '/api/me') {
        if (!GET) {
          if (body.lang === 'fa' || body.lang === 'en') {
            await Q(env, 'UPDATE users SET lang=? WHERE id=?', body.lang, u.id).run();
            u.lang = body.lang;
          }
          if (body.username !== undefined) {
            if (u.username) return E('locked');
            if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(String(body.username))) return E('invalid');
            try {
              await Q(env, 'UPDATE users SET username=? WHERE id=?', body.username, u.id).run();
              u.username = body.username;
            } catch (e) { return /UNIQUE/i.test(String(e)) ? E('taken', 409) : E('server', 500); }
          }
        }
        return J(pub(u));
      }

      if (p === '/api/logout') {
        const m = /sid=([\w-]+)/.exec(req.headers.get('cookie') || '');
        await Q(env, 'DELETE FROM sessions WHERE h=?', await sha(m[1])).run();
        return J({ ok: 1 }, 200, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
      }

      // Exact-username lookup only: there is no way to list or browse users
      if (p === '/api/find') {
        const r = await Q(env, 'SELECT id peer,name,username,online,last_seen FROM users WHERE username=?', (s.get('u') || '').replace(/^@/, '').trim()).first();
        return r ? J(r) : E('nouser', 404);
      }

      if (p === '/api/chats') {
        const r = await Q(env, `SELECT c.peer,u.name,u.username,u.online,u.last_seen,m.id mid,m.sender,m.ts,m.del,f.name fname,f.mime fmime,
            CASE WHEN m.del=1 THEN '' ELSE m.body END body,
            (SELECT COUNT(*) FROM msgs x WHERE x.a=MIN(c.uid,c.peer) AND x.b=MAX(c.uid,c.peer) AND x.sender<>c.uid AND x.id>c.read_id AND x.del=0) unread
          FROM chats c JOIN users u ON u.id=c.peer
          LEFT JOIN msgs m ON m.id=(SELECT MAX(y.id) FROM msgs y WHERE y.a=MIN(c.uid,c.peer) AND y.b=MAX(c.uid,c.peer) AND y.id NOT IN (SELECT mid FROM hides WHERE uid=c.uid))
          LEFT JOIN files f ON f.id=m.fid AND m.del=0 WHERE c.uid=? ORDER BY m.ts DESC`, u.id).all();
        return J({ chats: r.results });
      }

      if (p === '/api/messages') {
        const peer = s.get('peer') || '', before = +s.get('before') || 9e15, [a, b] = [u.id, peer].sort();
        const [r, pr, pn] = await env.DB.batch([
          Q(env, "SELECT m.id,m.sender,CASE WHEN m.del=1 THEN '' ELSE m.body END body,m.ts,m.del,CASE WHEN m.del=1 THEN NULL ELSE m.fid END fid,f.name fname,f.size fsize,f.mime fmime FROM msgs m LEFT JOIN files f ON f.id=m.fid AND m.del=0 WHERE m.a=? AND m.b=? AND m.id<? AND m.id NOT IN (SELECT mid FROM hides WHERE uid=?) ORDER BY m.id DESC LIMIT 50", a, b, before, u.id),
          Q(env, 'SELECT read_id FROM chats WHERE uid=? AND peer=?', peer, u.id),
          Q(env, "SELECT m.id,CASE WHEN m.del=1 THEN '' ELSE m.body END body,f.name fname FROM pins p JOIN msgs m ON m.id=p.mid LEFT JOIN files f ON f.id=m.fid AND m.del=0 WHERE p.a=? AND p.b=? AND m.del=0", a, b),
        ]);
        return J({ msgs: r.results, peerRead: pr.results[0]?.read_id || 0, pin: pn.results[0] || null });
      }

      if (p === '/api/send') {
        const text = String(body.body || '').trim().slice(0, 4000), to = String(body.to || '');
        if (!to || (!text && !body.fid)) return E('bad');
        if (!(await Q(env, 'SELECT 1 x FROM users WHERE id=?', to).first())) return E('nouser', 404);
        const [a, b] = [u.id, to].sort(), ts = Date.now();
        let f = null; // optional attachment: must be uploaded by this user for this exact chat
        if (body.fid) {
          f = await Q(env, 'SELECT * FROM files WHERE id=? AND owner=? AND a=? AND b=?', String(body.fid), u.id, a, b).first();
          if (!f) return E('notfound', 404);
          if (!f.done) {
            if ((await env.FILES.get(env.FILES.idFromName(f.id)).count()) !== f.chunks) return E('bad');
            await Q(env, 'UPDATE files SET done=1 WHERE id=?', f.id).run();
          }
        }
        const res = await env.DB.batch([
          Q(env, 'INSERT OR IGNORE INTO chats(uid,peer) VALUES(?,?)', u.id, to),
          Q(env, 'INSERT OR IGNORE INTO chats(uid,peer) VALUES(?,?)', to, u.id),
          Q(env, 'INSERT INTO msgs(a,b,sender,body,ts,fid) VALUES(?,?,?,?,?,?)', a, b, u.id, text, ts, f ? f.id : null),
        ]);
        const m = { id: res[2].meta.last_row_id, sender: u.id, to, body: text, ts, del: 0, cid: body.cid, ...(f ? { fid: f.id, fname: f.name, fsize: f.size, fmime: f.mime } : {}) };
        await Promise.all([push(env, u.id, { t: 'msg', m }), to !== u.id && push(env, to, { t: 'msg', m })]);
        return J(m);
      }

      if (p === '/api/delete') {
        const m = await Q(env, 'SELECT * FROM msgs WHERE id=?', +body.id).first();
        if (!m || (m.a !== u.id && m.b !== u.id)) return E('notfound', 404);
        if (body.all) { // delete for everyone: only the sender, content wiped server-side
          if (m.sender !== u.id) return E('forbidden', 403);
          if (m.fid) { // wipe the stored file too
            await env.FILES.get(env.FILES.idFromName(m.fid)).wipe().catch(() => {});
            await Q(env, 'DELETE FROM files WHERE id=?', m.fid).run();
          }
          await Q(env, "UPDATE msgs SET del=1, body='' WHERE id=?", m.id).run();
          await Promise.all([push(env, m.a, { t: 'del', id: m.id }), m.a !== m.b && push(env, m.b, { t: 'del', id: m.id })]);
        } else { // delete for me
          await Q(env, 'INSERT OR IGNORE INTO hides(mid,uid) VALUES(?,?)', m.id, u.id).run();
          await push(env, u.id, { t: 'hide', id: m.id });
        }
        return J({ ok: 1 });
      }

      if (p === '/api/file/init') {
        const size = Math.floor(+body.size), to = String(body.to || '');
        if (!(size > 0) || size > MAXF) return E('toobig');
        if (!(await Q(env, 'SELECT 1 x FROM users WHERE id=?', to).first())) return E('nouser', 404);
        const used = (await Q(env, 'SELECT COALESCE(SUM(size),0) s FROM files WHERE owner=?', u.id).first()).s;
        if (used + size > QUOTA) return E('quota');
        const id = crypto.randomUUID(), [a, b] = [u.id, to].sort();
        const mime = SAFE.test(String(body.mime)) ? String(body.mime) : 'application/octet-stream';
        await Q(env, 'INSERT INTO files(id,owner,a,b,name,size,mime,chunks,ts) VALUES(?,?,?,?,?,?,?,?,?)', id, u.id, a, b, String(body.name || 'file').slice(0, 120), size, mime, Math.ceil(size / CH), Date.now()).run();
        return J({ id, chunk: CH });
      }

      if (p === '/api/pin') { // one pinned message per chat, visible to both people
        const peer = String(body.peer || ''), [a, b] = [u.id, peer].sort();
        if (body.id) {
          const m = await Q(env, 'SELECT id FROM msgs WHERE id=? AND a=? AND b=? AND del=0', +body.id, a, b).first();
          if (!m) return E('notfound', 404);
          await Q(env, 'INSERT OR REPLACE INTO pins(a,b,mid) VALUES(?,?,?)', a, b, m.id).run();
        } else await Q(env, 'DELETE FROM pins WHERE a=? AND b=?', a, b).run();
        const evt = { t: 'pin', a, b };
        await Promise.all([push(env, u.id, evt), peer !== u.id && push(env, peer, evt)]);
        return J({ ok: 1 });
      }

      if (p === '/api/read') {
        const peer = String(body.peer || ''), upto = Math.floor(+body.upto) || 0;
        await Q(env, 'UPDATE chats SET read_id=MAX(read_id,?) WHERE uid=? AND peer=?', upto, u.id, peer).run();
        if (peer !== u.id) await push(env, peer, { t: 'read', by: u.id, upto });
        return J({ ok: 1 });
      }

      if (p === '/api/ws') {
        if (req.headers.get('upgrade') !== 'websocket') return E('bad', 426);
        const r = new Request(req);
        r.headers.set('x-uid', u.id); // set by the Worker only, never trusted from the client
        return hub(env, u.id).fetch(r);
      }
      return E('notfound', 404);
    } catch (e) {
      return E('server', 500);
    }
  },
};

// One Hub per user: multi-device WebSockets (hibernation API), typing relay, presence.
export class Hub extends DurableObject {
  async fetch(req) {
    const uid = req.headers.get('x-uid');
    if (!uid) return new Response(null, { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());
    const first = this.ctx.getWebSockets().length === 0;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ping: Date.now() });
    await this.ctx.storage.put('uid', uid);
    await this.ctx.storage.setAlarm(Date.now() + 60000);
    if (first) this.ctx.waitUntil(this.online(1));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Called (RPC) by the Worker / other hubs: forward an event to every open socket of this user
  async push(evt) {
    const data = JSON.stringify(evt);
    for (const w of this.ctx.getWebSockets()) try { w.send(data); } catch {}
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    ws.serializeAttachment({ ping: Date.now() });
    if (m.t === 'ping') return ws.send('{"t":"pong"}');
    if (m.t === 'typing' && typeof m.to === 'string') {
      const uid = await this.ctx.storage.get('uid');
      // only relay to people who already share a chat with this user
      if (await this.env.DB.prepare('SELECT 1 x FROM chats WHERE uid=? AND peer=?').bind(m.to, uid).first())
        await this.env.HUB.get(this.env.HUB.idFromName(m.to)).push({ t: 'typing', from: uid });
    }
  }

  async derive(pw, salt) {
    const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(salt), iterations: 100000 }, k, 256));
  }

  // password check with brute-force lockout: 5 wrong guesses lock this account for 5 minutes
  async verify(pw, stored) {
    const now = Date.now(), f = (this.fail ??= { n: 0, until: 0 });
    if (now < f.until) return { wait: 1 };
    const [salt, h] = stored.split(':'), d = await this.derive(pw, salt);
    let diff = d.length ^ h.length;
    for (let i = 0; i < d.length; i++) diff |= d.charCodeAt(i) ^ (h.charCodeAt(i) || 0);
    if (!diff) { f.n = 0; return { ok: 1 }; }
    if (++f.n >= 5) { f.n = 0; f.until = now + 300000; }
    return { ok: 0 };
  }

  // token bucket: burst 30, refills 2/s; in memory (resets if the object is evicted)
  async take(cost) {
    const now = Date.now(), b = (this.tk ??= { t: 30, at: now });
    b.t = Math.min(30, b.t + ((now - b.at) / 1000) * 2); b.at = now;
    if (b.t < cost) return false;
    b.t -= cost; return true;
  }

  async webSocketClose(ws) { try { ws.close(); } catch {} await this.sweep(); }
  async webSocketError() { await this.sweep(); }
  async alarm() { await this.sweep(); }

  // Drop dead sockets (no ping for 90s); mark offline when none remain
  async sweep() {
    const all = this.ctx.getWebSockets();
    const live = all.filter(w => w.readyState === 1 && Date.now() - (w.deserializeAttachment()?.ping || 0) < 90000);
    for (const w of all) if (!live.includes(w)) try { w.close(1001, 'stale'); } catch {}
    if (live.length) await this.ctx.storage.setAlarm(Date.now() + 60000);
    else await this.online(0);
  }

  async online(v) {
    const uid = await this.ctx.storage.get('uid'), now = Date.now();
    await this.env.DB.prepare('UPDATE users SET online=?, last_seen=? WHERE id=?').bind(v, now, uid).run();
    const peers = (await this.env.DB.prepare('SELECT peer FROM chats WHERE uid=? AND peer<>uid').bind(uid).all()).results;
    for (const { peer } of peers) this.env.HUB.get(this.env.HUB.idFromName(peer)).push({ t: 'presence', id: uid, online: v, ts: now }).catch(() => {});
  }
}

// One file = 1 MiB chunks inside its own SQLite-backed Durable Object (no R2 / payment method needed)
export class FileStore extends DurableObject {
  constructor(ctx, env) { super(ctx, env); ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS c(n INTEGER PRIMARY KEY, d BLOB)'); }
  async write(n, buf) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO c(n,d) VALUES(?,?)', n, buf); }
  async read(n) { const r = this.ctx.storage.sql.exec('SELECT d FROM c WHERE n=?', n).toArray(); return r.length ? r[0].d : new ArrayBuffer(0); }
  async count() { return this.ctx.storage.sql.exec('SELECT COUNT(*) c FROM c').one().c; }
  async wipe() { await this.ctx.storage.deleteAll(); }
}
