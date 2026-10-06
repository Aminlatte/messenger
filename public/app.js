// Messenger client: vanilla JS, no build step.
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const S = { me: null, chats: [], cur: null, msgs: [], pin: null, peerRead: 0, typing: {}, readSent: {}, dict: {}, lang: 'en', ws: null, tries: 0, gid: '' };
const P = JSON.parse(localStorage.getItem('prefs') || '{}'); // display prefs: { dig, cal }
const savePrefs = () => localStorage.setItem('prefs', JSON.stringify(P));
const TZ = 'Asia/Tehran';
let older = false, ct;

/* ---------- api / i18n ---------- */
async function api(path, body) {
  const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.e || 'server'), { code: j.e || 'server' });
  return j;
}
const t = (k, v = {}) => (S.dict[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? '');
const errText = e => S.dict['err.' + e.code] ? t('err.' + e.code) : t(e.code ? 'err.server' : 'err.net');
function toast(m) { const el = $('#toast'); el.textContent = m; el.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.remove('on'), 2800); }

/* ---------- text helpers ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = s => esc(s).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer" dir="ltr">${u}</a>`);
const digits = s => s.replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 1776);
// search normalisation: Persian/Arabic digits + ی/ي + ک/ك, strip diacritics and ZWNJ
const norm = s => digits((s || '').normalize('NFKD').replace(/[\u064B-\u065F\u0670\u200c\u200d]/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک')).toLowerCase();
const hue = id => [...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const ini = n => esc([...(n || '?')][0] || '?').toUpperCase();

/* ---------- dates & numbers: Asia/Tehran, Jalali in fa, Gregorian in en (overridable) ---------- */
const loc = () => `${S.lang === 'fa' ? 'fa-IR' : 'en-US'}-u-ca-${P.cal || (S.lang === 'fa' ? 'persian' : 'gregory')}-nu-${P.dig || (S.lang === 'fa' ? 'arabext' : 'latn')}`;
const fc = {};
const fmt = o => fc[loc() + JSON.stringify(o)] ??= new Intl.DateTimeFormat(loc(), { timeZone: TZ, ...o });
const fTime = ts => fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
const fDay = ts => fmt({ year: 'numeric', month: 'long', day: 'numeric' }).format(ts);
const fNum = n => new Intl.NumberFormat(loc()).format(n);
const sameDay = (a, b) => fmt({ dateStyle: 'short' }).format(a) === fmt({ dateStyle: 'short' }).format(b);
const when = ts => sameDay(ts, Date.now()) ? fTime(ts) : fDay(ts) + ' ' + fTime(ts);
const stamp = ts => sameDay(ts, Date.now()) ? fTime(ts) : fmt({ month: 'short', day: 'numeric' }).format(ts);

function applyI18n() {
  $$('[data-i]').forEach(e => e.textContent = t(e.dataset.i));
  $$('[data-ph]').forEach(e => e.placeholder = t(e.dataset.ph));
  $('#l-lang').textContent = S.lang === 'fa' ? 'English' : 'فارسی';
  $('#s-lang').value = S.lang; $('#s-dig').value = P.dig || ''; $('#s-cal').value = P.cal || '';
  document.title = t('app'); setMode();
}
// Instant language + direction switch, no reload; saved to the account so it follows the user
async function setLang(l, remote) {
  S.dict = await (await fetch(`/i18n/${l}.json`)).json();
  S.lang = l; localStorage.setItem('lang', l);
  document.documentElement.lang = l; document.documentElement.dir = l === 'fa' ? 'rtl' : 'ltr';
  applyI18n(); drawGoogle(); renderAll();
  if (remote && S.me) api('me', { lang: l }).catch(() => {});
}

/* ---------- rendering ---------- */
const show = id => $$('.v:not(#chat)').forEach(v => v.classList.toggle('on', v.id === id));
const nameOf = c => c.peer === S.me.id ? t('saved') : (c.name || c.username || '?');
const avTxt = c => c.peer === S.me.id ? '★' : ini(c.name || c.username);
const isTyping = id => S.typing[id] > Date.now();
function setAv(el, seed, txt) { el.style.setProperty('--h', hue(seed)); el.textContent = txt; }

function renderAll() {
  if (!S.me || !S.me.username) return;
  const n = S.me.name || S.me.username;
  [$('#hav'), $('#nav-av'), $('#pav')].forEach(el => setAv(el, S.me.id, ini(n)));
  $('#pname').textContent = n; $('#puser').textContent = '@' + S.me.username;
  renderList();
  if (S.cur) { renderHead(); renderMsgs(); }
}

function renderList() {
  if (!S.me) return;
  const q = norm($('#q').value).trim();
  const L = S.chats.filter(c => !q || norm((c.name || '') + ' ' + (c.username || '')).includes(q));
  $('#list').innerHTML = L.map(c => `<li data-id="${c.peer}"><div class="av" style="--h:${hue(c.peer)}">${avTxt(c)}${c.online && c.peer !== S.me.id ? '<i></i>' : ''}</div>
    <div class="mid"><div class="r1"><b dir="auto">${esc(nameOf(c))}</b><time>${c.ts ? stamp(c.ts) : ''}</time></div>
    <div class="r2"><span dir="auto" class="${isTyping(c.peer) ? 'ty' : ''}">${esc(isTyping(c.peer) ? t('typing') : c.del ? t('deleted') : c.body || (c.fname ? '📎 ' + c.fname : ''))}</span>${c.unread ? `<em>${fNum(c.unread)}</em>` : ''}</div></div></li>`).join('');
  $('#empty').hidden = S.chats.length > 0;
}

const stText = c => c.peer === S.me.id ? '' : isTyping(c.peer) ? t('typing') : c.online ? t('online') : c.last_seen ? t('lastSeen', { t: when(c.last_seen) }) : t('longAgo');
function renderHead() {
  const c = S.cur; if (!c) return;
  $('#cname').textContent = nameOf(c); setAv($('#cav'), c.peer, avTxt(c));
  const s = $('#cst'); s.textContent = stText(c); s.className = isTyping(c.peer) ? 'ty' : '';
}

function renderMsgs(bottom) {
  const box = $('#msgs'), atEnd = bottom || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const self = S.cur && S.cur.peer === S.me.id; let last = '', h = '';
  for (const m of S.msgs) {
    const d = fDay(m.ts); if (d !== last) { h += `<div class="day">${d}</div>`; last = d; }
    const out = m.sender === S.me.id;
    const tick = out && !self ? (m.id < 0 ? ' …' : m.id <= S.peerRead ? ' ✓✓' : ' ✓') : '';
    h += `<div class="m ${out ? 'out' : 'in'}${m.del ? ' del' : ''}" data-id="${m.id}" dir="auto">${m.del ? t('deleted') : media(m) + link(m.body)}<span class="meta">${fTime(m.ts)}${tick}</span></div>`;
  }
  box.innerHTML = h;
  if (atEnd) box.scrollTop = box.scrollHeight;
}

function tab(n) {
  $$('.tab').forEach(e => e.classList.toggle('on', e.id === 't-' + n));
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === n));
  $('.srch').hidden = $('#fab').hidden = n !== 'chats';
  if (n === 'find') $('#fu').focus();
}

/* ---------- data ---------- */
function loadChats(now) {
  clearTimeout(ct);
  return new Promise(res => ct = setTimeout(async () => { try { S.chats = (await api('chats')).chats; renderList(); } catch {} res(); }, now ? 0 : 60));
}

async function find() {
  const u = digits($('#fu').value).trim().replace(/^@/, ''); if (!u) return;
  try {
    const c = await api('find?u=' + encodeURIComponent(u)); c.unread = 0;
    $('#fres').innerHTML = `<div class="card" style="display:flex;gap:12px;align-items:center"><div class="av" style="--h:${hue(c.peer)}">${c.peer === S.me.id ? '★' : ini(c.name || c.username)}</div>
      <div class="mid"><b dir="auto">${esc(c.name || '')}</b><div class="hint" dir="ltr" style="text-align:start;margin:0">@${esc(c.username)}</div></div>
      <button class="btn" style="width:auto;margin:0;padding:10px 16px" id="fmsg">${t('find.msg')}</button></div>`;
    $('#fmsg').onclick = () => open(S.chats.find(x => x.peer === c.peer) || c);
  } catch (e) { $('#fres').innerHTML = ''; toast(errText(e)); }
}

async function open(c) {
  S.cur = c; S.msgs = []; S.peerRead = 0; older = false; S.pin = null; renderPin();
  history.pushState({ chat: 1 }, '');
  $('#chat').classList.add('on'); renderHead(); renderMsgs();
  try {
    const r = await api('messages?peer=' + c.peer);
    S.msgs = r.msgs.reverse(); S.peerRead = r.peerRead; S.pin = r.pin || null; renderPin(); renderMsgs(true); markRead();
  } catch (e) { toast(errText(e)); }
}
function closeChat() { S.cur = null; $('#chat').classList.remove('on'); loadChats(); }
addEventListener('popstate', () => S.cur && closeChat());

function markRead() {
  const c = S.cur; if (!c || c.peer === S.me.id || document.visibilityState !== 'visible') return;
  const last = [...S.msgs].reverse().find(m => m.sender !== S.me.id && m.id > 0);
  if (!last || (S.readSent[c.peer] || 0) >= last.id) return;
  S.readSent[c.peer] = last.id; c.unread = 0;
  api('read', { peer: c.peer, upto: last.id }).then(() => loadChats()).catch(() => {});
}

function upsert(m) {
  const i = S.msgs.findIndex(x => x.id === m.id || (m.cid && x.cid === m.cid));
  if (i < 0) S.msgs.push(m); else S.msgs[i] = m;
  S.msgs.sort((a, b) => (a.id > 0 ? a.id : 1e15) - (b.id > 0 ? b.id : 1e15));
}

async function send() {
  const i = $('#txt'), body = i.value.trim(); if (!body || !S.cur) return;
  i.value = ''; i.style.height = 'auto';
  const cid = crypto.randomUUID(), tmp = { id: -Date.now(), sender: S.me.id, to: S.cur.peer, body, ts: Date.now(), cid };
  S.msgs.push(tmp); renderMsgs(true);
  try { upsert(await api('send', { to: S.cur.peer, body, cid })); renderMsgs(true); loadChats(); }
  catch (e) { S.msgs = S.msgs.filter(x => x !== tmp); renderMsgs(); toast(errText(e)); }
}

async function del(m, all) {
  try {
    await api('delete', { id: m.id, all });
    if (all) { m.del = 1; m.body = ''; } else S.msgs = S.msgs.filter(x => x !== m);
    renderMsgs(); loadChats();
  } catch (e) { toast(errText(e)); }
}

function sheet(items) {
  $('#sh').innerHTML = items.map((x, i) => `<button class="${x.dg ? 'dg' : ''}" data-k="${i}">${esc(x.l)}</button>`).join('') + `<button data-k="x">${t('cancel')}</button>`;
  $('#sheet').classList.add('on');
  $('#sh').onclick = e => { const k = e.target.dataset.k; if (k === undefined) return; $('#sheet').classList.remove('on'); if (k !== 'x') items[k].f(); };
}

/* ---------- realtime (WebSocket to this user's Durable Object) ---------- */
function connect() {
  const w = S.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/ws');
  w.onopen = () => {
    const re = S.tries > 0; S.tries = 0; $('#net').hidden = true;
    if (re) { loadChats(true); if (S.cur) api('messages?peer=' + S.cur.peer).then(r => { S.msgs = r.msgs.reverse(); S.peerRead = r.peerRead; S.pin = r.pin || null; renderPin(); renderMsgs(); }).catch(() => {}); }
    clearInterval(S.hb); S.hb = setInterval(() => w.readyState === 1 && w.send('{"t":"ping"}'), 25000);
  };
  w.onmessage = e => { try { onEvt(JSON.parse(e.data)); } catch {} };
  w.onclose = () => { if (S.ws !== w) return; clearInterval(S.hb); $('#net').hidden = false; setTimeout(connect, Math.min(15000, 500 * 2 ** S.tries++)); };
}
addEventListener('online', () => S.ws && S.ws.readyState > 1 && connect());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { markRead(); if (S.ws && S.ws.readyState > 1) connect(); } });

function onEvt(e) {
  if (e.t === 'msg') {
    const m = e.m, peer = m.sender === S.me.id ? m.to : m.sender;
    if (S.cur && S.cur.peer === peer) { upsert(m); renderMsgs(); if (m.sender !== S.me.id) markRead(); }
    loadChats();
  } else if (e.t === 'del') {
    const m = S.msgs.find(x => x.id === e.id); if (m) { m.del = 1; m.body = ''; renderMsgs(); }
    loadChats();
  } else if (e.t === 'hide') {
    S.msgs = S.msgs.filter(x => x.id !== e.id); renderMsgs(); loadChats();
  } else if (e.t === 'read') {
    if (S.cur && S.cur.peer === e.by) { S.peerRead = Math.max(S.peerRead, e.upto); renderMsgs(); }
  } else if (e.t === 'typing') {
    S.typing[e.from] = Date.now() + 4000;
    const r = () => { renderList(); renderHead(); }; r(); setTimeout(r, 4100);
  } else if (e.t === 'pin') {
    if (S.cur && [S.me.id, S.cur.peer].sort().join() === [e.a, e.b].join()) loadPin();
  } else if (e.t === 'presence') {
    for (const c of [...S.chats, S.cur]) if (c && c.peer === e.id) { c.online = e.online; c.last_seen = e.ts; }
    renderList(); renderHead();
  }
}

/* ---------- auth ---------- */
function drawGoogle() {
  if (!window.google || !google.accounts || !S.gid) return;
  $('#gbtn').innerHTML = '';
  google.accounts.id.renderButton($('#gbtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', locale: S.lang });
}
function setMode() { // login <-> create-account form
  $('#lgo').textContent = t(S.reg ? 'reg.go' : 'login.go'); $('#lmode').textContent = t(S.reg ? 'login.have' : 'login.new');
  $('#ln').hidden = !S.reg; $('#lp').autocomplete = S.reg ? 'new-password' : 'current-password';
}
function showLogin() {
  show('login'); setMode(); $('#gbtn').hidden = !S.gid; // Google button only if a Client ID is configured
  if (!S.gid) return;
  if (window.google && google.accounts) return drawGoogle();
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => { google.accounts.id.initialize({ client_id: S.gid, callback: onCred }); drawGoogle(); };
  s.onerror = () => toast(t('err.net'));
  document.head.append(s);
}
async function onCred(r) { try { S.me = await api('auth/google', { credential: r.credential }); await start(); } catch (e) { toast(errText(e)); } }

async function start() {
  if (!S.me.username) return show('uname');
  if (S.me.lang && S.me.lang !== S.lang) await setLang(S.me.lang); else if (!S.me.lang) api('me', { lang: S.lang }).catch(() => {});
  show('home'); renderAll(); tab('chats');
  await loadChats(true); connect();
}

/* ---------- events ---------- */
$('#uf').onsubmit = async e => {
  e.preventDefault();
  try { S.me = await api('me', { username: digits($('#un').value).trim().replace(/^@/, '') }); await start(); } catch (x) { toast(errText(x)); }
};
$('#lmode').onclick = () => { S.reg = !S.reg; setMode(); };
$('#lf').onsubmit = async e => {
  e.preventDefault();
  const username = digits($('#lu').value).trim().replace(/^@/, ''), password = $('#lp').value;
  if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username)) return toast(t('err.invalid'));
  if (password.length < 8) return toast(t('err.weak'));
  try { S.me = await api(S.reg ? 'auth/register' : 'auth/login', { username, password, name: $('#ln').value }); await start(); } catch (x) { toast(errText(x)); }
};
$('#l-lang').onclick = () => setLang(S.lang === 'fa' ? 'en' : 'fa');
$('#s-lang').onchange = e => setLang(e.target.value, true);
$('#s-dig').onchange = e => { P.dig = e.target.value; savePrefs(); renderAll(); };
$('#s-cal').onchange = e => { P.cal = e.target.value; savePrefs(); renderAll(); };
$('#out').onclick = async () => { try { await api('logout', {}); } catch {} location.reload(); };
$('#fab').onclick = () => tab('find');
$('#hav').onclick = () => tab('prof');
$$('nav button').forEach(b => b.onclick = () => tab(b.dataset.tab));
$('#q').oninput = renderList;
$('#fgo').onclick = find;
$('#fu').onkeydown = e => e.key === 'Enter' && find();
$('#list').onclick = e => { const li = e.target.closest('li'); if (li) open(S.chats.find(c => c.peer === li.dataset.id)); };
$('#back').onclick = () => history.back();
$('#sheet').onclick = e => e.target.id === 'sheet' && $('#sheet').classList.remove('on');
$('#send').onmousedown = e => e.preventDefault(); // keep keyboard open
$('#send').onclick = send;

const txt = $('#txt');
txt.oninput = () => {
  txt.style.height = 'auto'; txt.style.height = Math.min(txt.scrollHeight, 120) + 'px';
  if (S.cur && S.cur.peer !== S.me.id && Date.now() - (S.lt || 0) > 2500 && S.ws && S.ws.readyState === 1) {
    S.lt = Date.now(); S.ws.send(JSON.stringify({ t: 'typing', to: S.cur.peer }));
  }
};
txt.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); } };

$('#msgs').onclick = e => {
  if (e.target.closest('a,video,audio')) return;
  if (e.target.matches('img.md')) { $('#lb img').src = e.target.src; $('#lb').hidden = false; return; }
  const el = e.target.closest('.m'); if (!el) return;
  const m = S.msgs.find(x => x.id === +el.dataset.id); if (!m || m.id < 0) return;
  const it = [];
  if (!m.del && m.body) it.push({ l: t('copy'), f: () => navigator.clipboard && navigator.clipboard.writeText(m.body).then(() => toast(t('copied'))) });
  if (!m.del) { const pinned = S.pin && S.pin.id === m.id; it.push({ l: t(pinned ? 'unpin' : 'pin'), f: () => api('pin', { peer: S.cur.peer, id: pinned ? 0 : m.id }).catch(x => toast(errText(x))) }); }
  it.push({ l: t('delMe'), dg: 1, f: () => del(m, false) });
  if (m.sender === S.me.id && !m.del) it.push({ l: t('delAll'), dg: 1, f: () => del(m, true) });
  sheet(it);
};
$('#msgs').onscroll = async e => { // older messages (pagination)
  const b = e.target; if (b.scrollTop > 60 || older || S.msgs.length < 50 || !S.cur) return;
  older = true; const h = b.scrollHeight, first = S.msgs.find(m => m.id > 0);
  try {
    const r = await api(`messages?peer=${S.cur.peer}&before=${first.id}`);
    if (r.msgs.length) { S.msgs = r.msgs.reverse().concat(S.msgs); renderMsgs(); b.scrollTop = b.scrollHeight - h; older = false; }
  } catch { older = false; }
};

/* ---------- photos, videos, files, pins ---------- */
const fSize = n => n < 1024 ? fNum(n) + ' B' : n < 1048576 ? fNum(+(n / 1024).toFixed(1)) + ' KB' : fNum(+(n / 1048576).toFixed(1)) + ' MB';
const card = (m, u) => `<div class="fl">${u ? `<a class="dl" href="${u}" download="${esc(m.fname)}"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg></a>` : `<span class="dl">${fNum(Math.round((m.up || 0) * 100))}%</span>`}<div><b dir="auto">${esc(m.fname || '')}</b><small>${fSize(m.fsize || 0)}</small></div></div>`;
function media(m) {
  if (m.id < 0 && m.fname) return card(m, '');
  if (!m.fid) return '';
  const u = '/api/file/' + m.fid;
  if (/^image\//.test(m.fmime)) return `<img class="md" loading="lazy" alt="" src="${u}">`;
  if (/^video\//.test(m.fmime)) return `<video class="md" controls preload="metadata" playsinline src="${u}"></video>`;
  if (/^audio\//.test(m.fmime)) return `<audio controls preload="none" src="${u}"></audio>`;
  return card(m, u);
}

// Images over 17 MB: re-encode at q=0.92 and cap at 4096px (visually lossless in practice)
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file), k = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const b = await new Promise(r => cv.toBlob(r, 'image/jpeg', .92));
    return b && b.size < file.size ? new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : null;
  } catch { return null; }
}

// Upload one chunk with retries (mobile networks drop often)
async function putChunk(id, i, body) {
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(`/api/file/${id}/${i}`, { method: 'PUT', body });
      if (r.ok) return;
      const j = await r.json().catch(() => ({}));
      if (r.status < 500 && r.status !== 429) throw Object.assign(new Error(), { code: j.e || 'server' });
    } catch (e) { if (e.code) throw e; }
    await new Promise(r => setTimeout(r, 600 * 2 ** k));
  }
  throw Object.assign(new Error(), { code: 'net' });
}

async function sendFile(file) {
  const c = S.cur; if (!c) return;
  if (file.size > 17 * 2 ** 20 && /^image\/(jpeg|png|webp)$/.test(file.type)) file = (await shrink(file)) || file;
  if (!file.size || file.size > 100 * 2 ** 20) return toast(t('err.toobig'));
  const tmp = { id: -Date.now(), sender: S.me.id, to: c.peer, body: '', ts: Date.now(), fname: file.name, fsize: file.size, fmime: file.type, up: 0, cid: crypto.randomUUID() };
  S.msgs.push(tmp); renderMsgs(true);
  try {
    const { id, chunk } = await api('file/init', { to: c.peer, name: file.name, size: file.size, mime: file.type });
    const n = Math.ceil(file.size / chunk);
    for (let i = 0; i < n; i++) { await putChunk(id, i, file.slice(i * chunk, (i + 1) * chunk)); tmp.up = (i + 1) / n; if (S.cur === c) renderMsgs(); }
    const m = await api('send', { to: c.peer, body: '', fid: id, cid: tmp.cid });
    if (S.cur === c) { upsert(m); renderMsgs(true); }
    loadChats();
  } catch (e) { if (S.cur === c) { S.msgs = S.msgs.filter(x => x !== tmp); renderMsgs(); } toast(errText(e)); }
}

function renderPin() { const p = S.pin; $('#pinbar').hidden = !p; if (p) $('#pintxt').textContent = p.body || (p.fname ? '📎 ' + p.fname : ''); }
const loadPin = () => S.cur && api(`messages?peer=${S.cur.peer}&before=1`).then(r => { S.pin = r.pin || null; renderPin(); }).catch(() => {});
$('#pinbar').onclick = e => {
  if (e.target.closest('#unpin')) return api('pin', { peer: S.cur.peer, id: 0 }).catch(x => toast(errText(x)));
  const el = S.pin && $(`.m[data-id="${S.pin.id}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
};
$('#att').onclick = () => $('#file').click();
$('#file').onchange = async e => { const fs = [...e.target.files]; e.target.value = ''; for (const f of fs) await sendFile(f); };
$('#lb').onclick = () => { $('#lb').hidden = true; };

/* ---------- boot ---------- */
(async () => {
  await setLang(localStorage.getItem('lang') || ((navigator.language || '').toLowerCase().startsWith('fa') ? 'fa' : 'en'));
  try { S.gid = (await api('config')).clientId; } catch (e) { toast(errText(e)); }
  try { S.me = await api('me'); await start(); } catch (e) { if (e.code !== 'auth') toast(errText(e)); showLogin(); }
})();
