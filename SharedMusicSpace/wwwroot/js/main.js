import { $, h, icon, setIcon, formatTime, thumbUrl, avatar, toast, paintRange } from './dom.js';
import { SyncPlayer } from './player.js';
import { chooseBackend } from './backend.js';

/* ==========================================================================
   State
   ========================================================================== */
const REACTIONS = ['❤️', '🔥', '😂', '👏', '🎉', '😮'];
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const session = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

// One id per browser tab: survives reloads, lets the server restore our seat after a reconnect.
const clientId = session.get('ms.cid') ?? (() => { const id = crypto.randomUUID(); session.set('ms.cid', id); return id; })();

const state = {
  me: null,            // { id, name }
  room: null,          // latest RoomSnapshot
  chat: [],
  skew: 0,             // serverClock - localClock (ms)
  tab: 'chat',
  unread: 0,
  results: null,       // null = never searched, [] = no results
  searching: false,
  added: new Set(),
  scrubbing: false,
  busy: false,
};

const el = {
  lobby: $('#lobby'), room: $('#room'), stage: $('#stage'),
  form: $('#lobbyForm'), name: $('#nameInput'), code: $('#codeInput'),
  createBtn: $('#createBtn'), joinBtn: $('#joinBtn'), error: $('#lobbyError'),
  connStatus: $('#connStatus'), connText: $('#connText'), inviteNote: $('#inviteNote'),
  roomName: $('#roomName'), roomSub: $('#roomSub'), codeText: $('#codeText'),
  npTitle: $('#npTitle'), npMeta: $('#npMeta'),
  seek: $('#seekBar'), timeNow: $('#timeNow'), timeTotal: $('#timeTotal'),
  play: $('#playBtn'), skip: $('#skipBtn'), back: $('#backBtn'), fwd: $('#fwdBtn'),
  mute: $('#muteBtn'), volume: $('#volume'),
  emptyStage: $('#emptyStage'), tapPlay: $('#tapPlay'), reactionsLayer: $('#reactionsLayer'),
  chatLog: $('#chatLog'), chatForm: $('#chatForm'), chatInput: $('#chatInput'),
  searchForm: $('#searchForm'), searchInput: $('#searchInput'), searchResults: $('#searchResults'),
  queueView: $('#queueView'), peopleView: $('#peopleView'),
  chatBadge: $('#chatBadge'), queueBadge: $('#queueBadge'), peopleBadge: $('#peopleBadge'),
  ambient: $('#ambient'), banner: $('#connBanner'), bannerText: $('#connBannerText'),
};

/* ==========================================================================
   Connection
   ========================================================================== */
const conn = await chooseBackend();
const p2p = conn.mode === 'p2p';

const call = (method, ...args) => conn.invoke(method, ...args);

async function syncClock() {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const server = await call('GetServerTime');
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (!best || rtt < best.rtt) best = { rtt, skew: server + rtt / 2 - t1 };
  }
  state.skew = best.skew;
}

async function connect() {
  for (let attempt = 0; ; attempt++) {
    try {
      await conn.start();
      await syncClock();
      return;
    } catch {
      setConn('bad', 'Can’t reach the server — retrying…');
      await new Promise((r) => setTimeout(r, Math.min(1000 * (attempt + 1), 5000)));
    }
  }
}

conn.onreconnecting(() => showBanner('Connection lost. Reconnecting…'));
conn.onreconnected(async () => {
  try {
    await syncClock();
    if (state.me && state.room) {
      const res = await call('JoinRoom', state.room.code, state.me.name, clientId);
      if (res.ok) { applyJoin(res); hideBanner(); return; }
      toast(res.error ?? 'The room is gone.', 'error');
      leaveLocally();
    }
  } catch { /* the next reconnect cycle will retry */ }
  hideBanner();
});
conn.onclose(() => { showBanner('Disconnected. Reconnecting…'); connect().then(rejoinAfterClose); });

async function rejoinAfterClose() {
  hideBanner();
  if (state.me && state.room) {
    const res = await call('JoinRoom', state.room.code, state.me.name, clientId).catch(() => null);
    if (res?.ok) applyJoin(res); else leaveLocally();
  }
}

function showBanner(text) { el.bannerText.textContent = text; el.banner.hidden = false; }
function hideBanner() { el.banner.hidden = true; }

function setConn(kind, text) {
  el.connStatus.className = `conn-status ${kind}`;
  el.connText.textContent = text;
}

/* ==========================================================================
   Player
   ========================================================================== */
const player = new SyncPlayer('yt', {
  onEnded: (id) => call('TrackEnded', id).catch(() => {}),
  onError: (id, code) => {
    // 2 = bad id, 100 = removed/private, 101/150 = embedding disabled → nobody can play it, move on.
    if ([2, 100, 101, 150].includes(code)) call('Unplayable', id).catch(() => {});
    else toast('The player hit a snag. Try pressing play again.', 'error');
  },
  onBlocked: (blocked) => { el.tapPlay.hidden = !blocked; },
  onFail: () => toast('Couldn’t load the YouTube player. Check your connection or ad blocker.', 'error'),
});
player.setVolume(Number(store.get('ms.volume') ?? 80));
player.setMuted(store.get('ms.muted') === '1');

/* ==========================================================================
   Lobby
   ========================================================================== */
const inviteCode = (location.pathname.match(/^\/r\/([A-Za-z0-9]{4,12})/)?.[1] ?? '').toUpperCase();

const ADJECTIVES = ['Happy', 'Groovy', 'Chill', 'Cosmic', 'Funky', 'Sunny', 'Mellow', 'Electric', 'Lucky', 'Velvet', 'Neon', 'Dreamy'];
const ANIMALS = ['Panda', 'Otter', 'Falcon', 'Koala', 'Tiger', 'Dolphin', 'Fox', 'Owl', 'Penguin', 'Llama', 'Gecko', 'Raven'];
const randomNick = () => `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;

function initLobby() {
  // Returning visitors get their old name; first-timers get a fun suggestion so they can start with one click.
  el.name.value = store.get('ms.name') ?? randomNick();
  if (inviteCode) {
    el.lobby.classList.add('invited');
    el.code.value = inviteCode;
    el.inviteNote.hidden = false;
    el.inviteNote.append('You’ve been invited to room ', h('strong', { text: inviteCode }), '. Pick a nickname and hop in.');
  }
  el.name.focus({ preventScroll: true });
  el.name.select();
}

// Accept a bare code or a pasted invite link — whichever the friend sent.
el.code.addEventListener('input', () => {
  const raw = el.code.value;
  const fromLink = raw.match(/\/r\/([A-Za-z0-9]{4,12})/)?.[1];
  el.code.value = (fromLink ?? raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});

async function submitLobby(action) {
  if (state.busy) return;
  const name = el.name.value.trim();
  if (!name) return showLobbyError('Pick a nickname so your friends know who you are.', el.name);
  if (action === 'join' && !el.code.value.trim()) return showLobbyError('Enter the 6-character room code.', el.code);

  store.set('ms.name', name);
  await enterRoom(action, name, el.code.value);
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  // Enter key → implicit submit. On an invite page, or while typing a code, that means "join".
  const joining = inviteCode || document.activeElement === el.code || e.submitter?.dataset.action === 'join';
  submitLobby(joining ? 'join' : 'create');
});
// On an invite page the secondary "Create a room" button must really create, not join.
if (inviteCode) {
  el.createBtn.type = 'button';
  el.createBtn.addEventListener('click', () => submitLobby('create'));
}

async function enterRoom(action, name, code) {
  setBusy(true);
  el.error.hidden = true;
  try {
    const res = action === 'create' ? await call('CreateRoom', name, clientId) : await call('JoinRoom', code, name, clientId);
    if (!res.ok) { showLobbyError(res.error ?? 'Something went wrong.'); return false; }
    applyJoin(res);
    return true;
  } catch {
    showLobbyError('Couldn’t reach the server. Please try again.');
    return false;
  } finally { setBusy(false); }
}

function setBusy(busy) {
  state.busy = busy;
  el.createBtn.disabled = el.joinBtn.disabled = busy || !conn.state?.startsWith?.('Connected');
}

function showLobbyError(message, focus) {
  el.error.textContent = message;
  el.error.hidden = false;
  focus?.focus();
}

/* ==========================================================================
   Entering / leaving a room
   ========================================================================== */
function applyJoin(res) {
  const firstTime = !state.room;
  state.me = { id: res.memberId, name: res.name };
  state.room = res.room;
  state.chat = res.chat ?? [];
  session.set('ms.session', JSON.stringify({ code: res.room.code, name: res.name }));

  if (firstTime) {
    player.start();
    el.lobby.hidden = true;
    el.room.hidden = false;
    history.replaceState({}, '', `/r/${res.room.code}`);
    state.unread = 0;
    state.results = null;
    state.added.clear();
    setTab('chat');
  }
  renderChatFull();
  renderAll();
  player.apply(res.room.playback, res.room.serverTime, state.skew);
}

function leaveLocally() {
  state.me = null; state.room = null; state.chat = [];
  session.del('ms.session');
  player.apply({ song: null }, 0, 0);
  document.title = 'Music Space — listen together';
  el.ambient.classList.remove('has-art');
  el.room.hidden = true;
  el.lobby.hidden = false;
  if (document.fullscreenElement) document.exitFullscreen();
  history.replaceState({}, '', '/');
  setBusy(false);
}

$('#leaveBtn').addEventListener('click', async () => {
  try { await call('LeaveRoom'); } catch { /* we're leaving anyway */ }
  leaveLocally();
});

/* ==========================================================================
   Server events
   ========================================================================== */
conn.on('state', (snap) => {
  if (!state.room || snap.code !== state.room.code || snap.rev < state.room.rev) return;
  state.room = snap;
  state.scrubbing = false;
  renderAll();
  player.apply(snap.playback, snap.serverTime, state.skew);
});

conn.on('chat', (msg) => {
  state.chat.push(msg);
  if (state.chat.length > 200) state.chat.shift();
  appendChat(msg);
  const mine = msg.kind === 'user' && msg.name === state.me?.name;
  if (state.tab !== 'chat') {
    if (msg.kind === 'user' && !mine) { state.unread++; renderBadges(); }
    if (msg.kind === 'system') toast(msg.text);
  }
});

conn.on('reaction', (name, emoji) => floatReaction(emoji, name === state.me?.name ? 'You' : name));

/* ==========================================================================
   Rendering
   ========================================================================== */
const playback = () => state.room?.playback;
const song = () => playback()?.song ?? null;
const isHost = () => state.room?.members.find((m) => m.id === state.me?.id)?.isHost ?? false;
const canRemove = (s) => isHost() || s.addedBy === state.me?.name;
const inRoomQueue = (id) => song()?.id === id || state.room?.queue.some((s) => s.id === id);

function renderAll() {
  const r = state.room;
  if (!r) return;
  el.roomName.textContent = r.name;
  el.codeText.textContent = r.code;
  el.roomSub.replaceChildren(h('span', { class: 'live-dot' }), `${r.members.length} listening${p2p ? ' · serverless' : ''}`);
  renderNowPlaying();
  renderQueue();
  renderPeople();
  renderSearch();
  renderBadges();
}

function renderNowPlaying() {
  const s = song();
  const pb = playback();
  const hasSong = !!s;

  el.emptyStage.hidden = hasSong;
  el.npTitle.textContent = s?.title ?? 'Nothing playing';
  el.npMeta.textContent = s ? `${s.author} · added by ${s.addedBy === state.me?.name ? 'you' : s.addedBy}` : 'Queue is empty';
  document.title = s ? `${pb.playing ? '▶' : '⏸'} ${s.title} · Music Space` : 'Music Space';

  for (const b of [el.play, el.skip, el.back, el.fwd]) b.disabled = !hasSong;
  const known = !!s?.duration;
  el.seek.disabled = !known;
  el.seek.max = known ? s.duration : 100;
  el.timeTotal.textContent = known ? formatTime(s.duration) : '--:--';

  const playing = hasSong && pb.playing;
  el.play.dataset.state = playing ? 'playing' : 'paused';
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  setIcon(el.play, playing ? 'pause' : 'play');
  if (!hasSong) { el.seek.value = 0; paintRange(el.seek); el.timeNow.textContent = '0:00'; }

  if (s) el.ambient.style.setProperty('--art', `url(${thumbUrl(s.id)})`);
  el.ambient.classList.toggle('has-art', hasSong);

  updateMediaSession(s, playing);
}

function renderBadges() {
  const r = state.room;
  const set = (node, n, show = n > 0) => { node.hidden = !show; node.textContent = n > 9 && node === el.chatBadge ? '9+' : n; };
  set(el.chatBadge, state.unread);
  set(el.queueBadge, r?.queue.length ?? 0);
  set(el.peopleBadge, r?.members.length ?? 0);
}

function trackRow(s, { index, current, actions = [], sub } = {}) {
  const thumb = h('div', { class: 'thumb' },
    h('img', { src: thumbUrl(s.id), alt: '', loading: 'lazy', decoding: 'async' }),
    current ? h('div', { class: `eq-mini ${playback()?.playing ? '' : 'paused'}` }, h('i'), h('i'), h('i')) : (s.duration ? h('span', { class: 'dur', text: formatTime(s.duration) }) : null));
  return h('div', { class: `track ${current ? 'current' : ''}` },
    thumb,
    h('div', { class: 'track-info' },
      h('div', { class: 'track-title', title: s.title, text: s.title }),
      h('div', { class: 'track-sub', text: sub ?? `${s.author}` })),
    h('div', { class: 'track-actions' }, ...actions));
}

const emptyState = (title, text, action) => h('div', { class: 'empty' },
  h('div', { class: 'art' }, icon('music')), h('strong', { text: title }), h('span', { text }), action);

function renderQueue() {
  const r = state.room;
  const nodes = [];
  const cur = song();

  if (cur) {
    nodes.push(h('div', { class: 'section-head', text: 'Now playing' }));
    nodes.push(trackRow(cur, { current: true, sub: `${cur.author} · ${cur.addedBy === state.me?.name ? 'you' : cur.addedBy}` }));
  }

  nodes.push(h('div', { class: 'section-head' }, 'Up next', h('small', { text: r.queue.length ? `${r.queue.length} · ${formatTime(r.queue.reduce((a, s) => a + s.duration, 0))}` : '' })));
  if (r.queue.length === 0) {
    nodes.push(emptyState('The queue is empty', cur ? 'Add more songs so the music never stops.' : 'Add a song to get started.',
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => setTab('add') }, icon('plus'), 'Add songs')));
  }
  r.queue.forEach((s, i) => {
    const actions = [];
    if (i > 0) actions.push(h('button', { class: 'icon-btn sm', type: 'button', title: 'Play next', 'aria-label': `Play “${s.title}” next`, onclick: () => call('PlayNext', s.queueId) }, icon('top')));
    if (canRemove(s)) actions.push(h('button', { class: 'icon-btn sm danger', type: 'button', title: 'Remove', 'aria-label': `Remove “${s.title}”`, onclick: () => call('RemoveSong', s.queueId) }, icon('trash')));
    nodes.push(trackRow(s, { index: i, actions, sub: `${s.author} · ${s.addedBy === state.me?.name ? 'you' : s.addedBy}` }));
  });

  if (r.history.length) {
    nodes.push(h('div', { class: 'section-head' }, h('span', {}, 'Recently played')));
    for (const s of r.history.slice(0, 12)) {
      const queued = inRoomQueue(s.id);
      nodes.push(trackRow(s, {
        actions: [h('button', { class: 'icon-btn sm', type: 'button', disabled: queued, title: queued ? 'Already queued' : 'Queue again', 'aria-label': `Queue “${s.title}” again`, onclick: () => addSong(s.id) }, icon(queued ? 'check' : 'plus'))],
      }));
    }
  }

  const top = el.queueView.scrollTop;
  el.queueView.replaceChildren(...nodes);
  el.queueView.scrollTop = top;
}

function renderPeople() {
  const nodes = [];
  if (state.room.members.length === 1) {
    nodes.push(h('div', { class: 'invite-card' },
      h('p', {}, h('strong', { text: 'It’s just you here' }), 'Send the invite link so friends can join and listen along.'),
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: shareInvite }, icon('link'), 'Invite')));
  }
  nodes.push(h('div', { class: 'section-head', text: `In this room · ${state.room.members.length}` }));
  for (const m of state.room.members) {
    nodes.push(h('div', { class: 'person' },
      avatar(m.name),
      h('div', { class: 'person-name' },
        h('span', { text: m.name }),
        m.id === state.me?.id ? h('span', { class: 'tag', text: 'You' }) : null,
        m.isHost ? h('span', { class: 'tag host' }, icon('crown'), 'Host') : null)));
  }
  el.peopleView.replaceChildren(...nodes);
}

/* ---------- search / add ---------- */
function renderSearch() {
  const box = el.searchResults;
  const top = box.scrollTop;
  if (state.searching) {
    box.replaceChildren(...Array.from({ length: 5 }, () => h('div', { class: 'skeleton' })));
    return;
  }
  if (state.results === null) {
    box.replaceChildren(emptyState('Find something to play', 'Search by song or artist, or paste a YouTube link above.'));
    return;
  }
  if (state.results.length === 0) {
    box.replaceChildren(emptyState('No results', 'Try different keywords or paste a link.'));
    return;
  }
  box.replaceChildren(...state.results.map((v) => {
    const queued = inRoomQueue(v.videoId);
    const done = queued || state.added.has(v.videoId);
    return trackRow({ id: v.videoId, title: v.title, author: v.author, duration: v.duration }, {
      actions: [h('button', {
        class: `btn btn-sm ${done ? 'is-done' : 'btn-secondary'}`, type: 'button', disabled: done,
        'aria-label': `Add “${v.title}”`, onclick: () => addSong(v.videoId),
      }, icon(done ? 'check' : 'plus'), done ? 'Added' : 'Add')],
    });
  }));
  box.scrollTop = top;
}

const URL_RE = /(youtu\.be\/|youtube\.com\/|music\.youtube\.com\/)/i;

el.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el.searchInput.value.trim();
  if (!q) return;

  if (URL_RE.test(q)) {
    el.searchInput.value = '';
    await addSong(q);
    return;
  }

  state.searching = true;
  renderSearch();
  try {
    state.results = await call('Search', q);
  } catch (err) {
    state.results = [];
    toast(err?.message?.split(': ').pop() || 'Search failed. Try again.', 'error');
    if (p2p) $('#searchSettings').open = true;
  } finally {
    state.searching = false;
    renderSearch();
  }
});

async function addSong(idOrUrl) {
  try {
    const res = await call('AddSong', idOrUrl);
    if (!res.ok) { toast(res.message ?? 'Couldn’t add that song.', 'error'); return; }
    if (!URL_RE.test(idOrUrl)) state.added.add(idOrUrl);
    renderSearch();
  } catch {
    toast('Couldn’t add that song. Try again.', 'error');
  }
}

/* ---------- chat ---------- */
const timeFmt = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

function messageNode(msg, prev) {
  if (msg.kind === 'system') return h('div', { class: 'sys', text: msg.text });
  const mine = msg.name === state.me?.name;
  const cont = prev?.kind === 'user' && prev.name === msg.name && msg.time - prev.time < 120000;
  return h('div', { class: `msg ${mine ? 'mine' : ''} ${cont ? 'cont' : ''}` },
    !mine && !cont ? h('span', { class: 'msg-name', text: msg.name }) : null,
    h('div', { class: 'bubble', text: msg.text }),
    h('span', { class: 'msg-time', text: timeFmt.format(msg.time) }));
}

function renderChatFull() {
  el.chatLog.replaceChildren(...state.chat.map((m, i) => messageNode(m, state.chat[i - 1])));
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function appendChat(msg) {
  const log = el.chatLog;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  const prev = state.chat[state.chat.length - 2];
  log.append(messageNode(msg, prev));
  while (log.children.length > 200) log.firstElementChild.remove();
  if (nearBottom || msg.name === state.me?.name) log.scrollTop = log.scrollHeight;
}

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  el.chatInput.value = '';
  call('SendChat', text).catch(() => toast('Message not sent.', 'error'));
});

/* ---------- reactions ---------- */
const reactionBar = $('#reactionBar');
for (const emoji of REACTIONS) {
  reactionBar.append(h('button', { class: 'react-btn', type: 'button', 'aria-label': `React ${emoji}`, onclick: () => call('React', emoji).catch(() => {}) }, emoji));
}

function floatReaction(emoji, who) {
  const node = h('div', { class: 'float-react', style: { left: `${10 + Math.random() * 78}%` } }, h('b', { text: emoji }), h('span', { text: who }));
  node.addEventListener('animationend', () => node.remove());
  el.reactionsLayer.append(node);
}

/* ==========================================================================
   Controls
   ========================================================================== */
el.play.addEventListener('click', () => call('TogglePlay'));
el.skip.addEventListener('click', () => call('Skip'));
$('#emptyAddBtn').addEventListener('click', () => setTab('add'));
el.tapPlay.addEventListener('click', () => { el.tapPlay.hidden = true; player.resume(); });

const seekBy = (delta) => {
  const s = song();
  if (!s) return;
  call('Seek', Math.max(0, s.duration ? Math.min(player.expected() + delta, s.duration - 1) : player.expected() + delta));
};
el.back.addEventListener('click', () => seekBy(-10));
el.fwd.addEventListener('click', () => seekBy(10));

el.seek.addEventListener('input', () => {
  state.scrubbing = true;
  el.timeNow.textContent = formatTime(el.seek.value);
  paintRange(el.seek);
});
el.seek.addEventListener('change', () => {
  call('Seek', Number(el.seek.value));
  setTimeout(() => { state.scrubbing = false; }, 1500);
});

el.volume.value = player.volume;
paintRange(el.volume);
el.volume.addEventListener('input', () => {
  const v = Number(el.volume.value);
  player.setVolume(v);
  if (v > 0 && player.muted) player.setMuted(false);
  store.set('ms.volume', String(v));
  store.set('ms.muted', player.muted ? '1' : '0');
  paintRange(el.volume);
  syncMuteIcon();
});
el.mute.addEventListener('click', toggleMute);
function toggleMute() {
  player.setMuted(!player.muted);
  store.set('ms.muted', player.muted ? '1' : '0');
  syncMuteIcon();
}
function syncMuteIcon() {
  const silent = player.muted || player.volume === 0;
  setIcon(el.mute, silent ? 'mute' : 'vol');
  el.mute.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
  el.volume.value = player.muted ? 0 : player.volume;
  paintRange(el.volume);
}
syncMuteIcon();

// Smooth progress ticker driven by the server clock.
setInterval(() => {
  const s = song();
  if (!s || state.scrubbing || document.hidden) return;
  const t = Math.max(player.expected(), 0);
  el.timeNow.textContent = formatTime(t);
  if (!s.duration) return;
  el.seek.value = Math.min(t, s.duration);
  paintRange(el.seek);
}, 250);

/* fullscreen */
const fullBtn = $('#fullBtn');
if (!el.stage.requestFullscreen) fullBtn.hidden = true;
fullBtn.addEventListener('click', toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.stage.requestFullscreen?.().catch(() => {});
}
let idleTimer;
const wake = () => {
  el.stage.classList.remove('idle');
  clearTimeout(idleTimer);
  if (document.fullscreenElement) idleTimer = setTimeout(() => el.stage.classList.add('idle'), 2500);
};
for (const ev of ['mousemove', 'pointerdown', 'touchstart', 'keydown']) el.stage.addEventListener(ev, wake, { passive: true });
document.addEventListener('fullscreenchange', wake);

/* ==========================================================================
   Tabs
   ========================================================================== */
const tabs = [...document.querySelectorAll('#tabs [role=tab]')];
function setTab(name, { focus = false } = {}) {
  state.tab = name;
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    $(`#pane-${t.dataset.tab}`).hidden = !on;
    if (on && focus) t.focus();
  }
  if (name === 'chat') { state.unread = 0; renderBadges(); el.chatLog.scrollTop = el.chatLog.scrollHeight; }
  if (name === 'add' && matchMedia('(hover: hover)').matches) el.searchInput.focus({ preventScroll: true });
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => setTab(t.dataset.tab));
  t.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (dir) { e.preventDefault(); setTab(tabs[(i + dir + tabs.length) % tabs.length].dataset.tab, { focus: true }); }
  });
});

/* ==========================================================================
   Header actions
   ========================================================================== */
async function copy(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } });
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* nothing else to try */ }
    ta.remove();
  }
  toast(okMsg);
}
$('#codeBtn').addEventListener('click', () => copy(state.room.code, 'Room code copied'));
async function shareInvite() {
  const url = `${location.origin}/r/${state.room.code}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Join my Music Space', text: `Listen with me in ${state.room.name}`, url }); return; } catch { /* cancelled → fall back to copy */ }
  }
  copy(url, 'Invite link copied — send it to your friends');
}
$('#inviteBtn').addEventListener('click', shareInvite);
$('#emptyInviteBtn').addEventListener('click', shareInvite);

/* ==========================================================================
   Keyboard shortcuts & lock-screen controls
   ========================================================================== */
document.addEventListener('keydown', (e) => {
  if (!state.room || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.matches('input, textarea, select, [contenteditable], [role=tab]')) return;
  if (e.key === ' ' && !t.matches('button')) { e.preventDefault(); if (song()) call('TogglePlay'); }
  else if (e.key === 'ArrowRight') seekBy(10);
  else if (e.key === 'ArrowLeft') seekBy(-10);
  else if (e.key === 'm' || e.key === 'M') toggleMute();
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

function updateMediaSession(s, playing) {
  if (!('mediaSession' in navigator)) return;
  if (!s) { navigator.mediaSession.metadata = null; return; }
  if (navigator.mediaSession.metadata?.title !== s.title) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.author, album: state.room.name, artwork: [{ src: thumbUrl(s.id), sizes: '320x180', type: 'image/jpeg' }] });
  }
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
if ('mediaSession' in navigator) {
  const bind = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ } };
  bind('play', () => { if (!playback()?.playing) call('TogglePlay'); });
  bind('pause', () => { if (playback()?.playing) call('TogglePlay'); });
  bind('nexttrack', () => call('Skip'));
}

// Keep phone screens awake while music plays so the room doesn't fall asleep.
let wakeLock = null;
async function syncWakeLock() {
  const want = !!playback()?.playing && !document.hidden && !!navigator.wakeLock;
  try {
    if (want && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* denied (battery saver etc.) — not critical */ }
}
setInterval(syncWakeLock, 4000);

// Re-sync immediately when the tab becomes visible again (mobile browsers throttle timers).
document.addEventListener('visibilitychange', () => { if (!document.hidden) { player.reconcile(true); syncWakeLock(); } });

/* ==========================================================================
   Serverless-mode extras
   ========================================================================== */
if (p2p) {
  // Search settings: the optional personal YouTube Data API key lives only in this browser.
  const keyInput = $('#ytKey');
  keyInput.value = store.get('ms.ytkey') ?? '';
  $('#saveKey').addEventListener('click', () => {
    store.set('ms.ytkey', keyInput.value.trim());
    toast(keyInput.value.trim() ? 'Key saved in this browser' : 'Key removed');
  });
  conn.on('integrity', (msg) => toast(msg, 'error'));
  conn.on('kicked', () => { toast('You were removed from the room.', 'error'); leaveLocally(); });

  // Without a server nobody knows a pasted video's length: the first player to load it reports it.
  const reported = new Set();
  setInterval(() => {
    const s = song();
    if (!s || s.duration || reported.has(s.id)) return;
    const d = player.duration();
    if (d > 0) { reported.add(s.id); call('SongMeta', s.id, d, player.title()).catch(() => {}); }
  }, 1500);

  // Leaving politely lets the room hand over to someone else.
  addEventListener('pagehide', () => { if (state.room) conn.invoke('LeaveRoom'); });
}

/* ==========================================================================
   Boot
   ========================================================================== */
initLobby();
setConn('', 'Connecting to server…');

connect().then(async () => {
  setConn('ok', p2p ? (conn.local ? 'Ready · same-browser demo mode' : 'Ready · peer-to-peer, no server') : 'Connected');
  document.body.classList.toggle('p2p', p2p);
  setBusy(false);

  // Page reload while inside a room → quietly take our seat back.
  const saved = (() => { try { return JSON.parse(session.get('ms.session') ?? 'null'); } catch { return null; } })();
  if (saved && (!inviteCode || saved.code === inviteCode)) {
    el.name.value = saved.name;
    if (!(await enterRoom('join', saved.name, saved.code))) session.del('ms.session');
  }
});
