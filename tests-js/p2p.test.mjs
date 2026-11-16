import test from 'node:test';
import assert from 'node:assert/strict';
import { P2PBackend } from '../SharedMusicSpace/wwwroot/js/p2p/engine.js';
import { MemoryNetwork } from '../SharedMusicSpace/wwwroot/js/p2p/transport-memory.js';
import { Identity } from '../SharedMusicSpace/wwwroot/js/core/identity.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const VIDEO = (n) => `video${String(n).padStart(6, '0')}`; // 11 chars
const META = { get: (id) => ({ id, title: `Song ${id}`, author: 'Artist', duration: 180 }) };

function world() {
  const net = new MemoryNetwork();
  const transports = [];
  const make = (name) => {
    let saved = null;
    const be = new P2PBackend({
      createTransport: async (code) => { const t = net.join(code); transports.push(t); be.transport = t; return t; },
      store: { load: () => saved, save: (v) => { saved = v; } },
      meta: { remember() {}, resolve: async (id) => META.get(id) },
      search: async () => [],
      helloTimeoutMs: 300, electionWaitMs: 150, tickMs: 60_000, pingMs: 60_000,
    });
    be.label = name; be.events = { state: [], chat: [], reaction: [], integrity: [] };
    for (const e of Object.keys(be.events)) be.on(e, (...a) => be.events[e].push(a));
    return be;
  };
  return { net, make };
}

async function party(n = 2) {
  const { net, make } = world();
  const host = make('host');
  const created = await host.invoke('CreateRoom', 'Host', 'c');
  assert.ok(created.ok);
  const code = created.room.code;
  const guests = [];
  for (let i = 1; i < n; i++) {
    const g = make(`guest${i}`);
    const joined = await g.invoke('JoinRoom', code, `Guest${i}`, 'c');
    assert.ok(joined.ok, joined.error);
    guests.push(g);
  }
  await settle();
  return { net, host, guests, code };
}
const snap = (be) => be.room.snapshot();

test('create + join: guest receives the room and everyone sees both members', async () => {
  const { host, guests } = await party(2);
  assert.equal(snap(host).members.length, 2);
  assert.equal(snap(guests[0]).members.length, 2);
  assert.deepEqual(snap(guests[0]).members.map((m) => m.isHost), [true, false]);
});

test('joining an unknown room fails fast with a helpful message', async () => {
  const { make } = world();
  const lonely = make('lonely');
  const res = await lonely.invoke('JoinRoom', 'ZZZZZZ', 'Nobody', 'c');
  assert.equal(res.ok, false);
  assert.match(res.error, /couldn.t reach that room/i);
});

test('a guest adds a song: it plays for everyone and the guest gets an answer', async () => {
  const { host, guests } = await party(2);
  const res = await guests[0].invoke('AddSong', `https://youtu.be/${VIDEO(1)}`);
  assert.deepEqual(res, { ok: true, message: 'Now playing' });
  await settle();
  assert.equal(snap(host).playback.song.id, VIDEO(1));
  assert.equal(snap(guests[0]).playback.song.addedBy, 'Guest1');
  const dup = await guests[0].invoke('AddSong', VIDEO(1));
  assert.equal(dup.ok, false);
});

test('playback commands from peers sync everywhere (pause, seek, skip)', async () => {
  const { host, guests } = await party(3);
  await host.invoke('AddSong', VIDEO(1));
  await host.invoke('AddSong', VIDEO(2));
  await settle();

  await guests[0].invoke('TogglePlay'); await settle();
  assert.equal(snap(host).playback.playing, false);
  assert.equal(snap(guests[1]).playback.playing, false);

  await guests[1].invoke('Seek', 77); await settle();
  assert.equal(Math.round(snap(host).playback.position), 77);
  assert.equal(Math.round(snap(guests[0]).playback.position), 77);

  await guests[1].invoke('Skip'); await settle();
  assert.equal(snap(guests[0]).playback.song.id, VIDEO(2));
  assert.equal(snap(host).history[0].id, VIDEO(1));
});

test('chat and reactions reach everyone; non-hosts can’t inject chat by themselves', async () => {
  const { host, guests } = await party(2);
  await guests[0].invoke('SendChat', 'hello <b>world</b>');
  await guests[0].invoke('React', '🔥');
  await settle();
  assert.ok(host.events.chat.some(([m]) => m.kind === 'user' && m.name === 'Guest1' && m.text === 'hello <b>world</b>'));
  assert.ok(guests[0].events.chat.some(([m]) => m.text === 'hello <b>world</b>'));
  assert.deepEqual(host.events.reaction.at(-1), ['Guest1', '🔥']);
  await guests[0].invoke('React', '💀'); await settle();          // not on the allow-list
  assert.equal(host.events.reaction.length, 1);
});

test('forged and replayed commands are rejected by the host', async () => {
  const { net, host, guests, code } = await party(2);
  await host.invoke('AddSong', VIDEO(1)); await settle();
  assert.equal(snap(host).playback.playing, true);

  // An outsider on the same network speaks as Guest1 without owning their key.
  const evil = net.join(code);
  const victim = snap(host).members.find((m) => m.name === 'Guest1');
  const mallory = await Identity.create();
  evil.send('cmd', { id: victim.id, c: { type: 'toggle' }, n: 99, sig: await mallory.sign({ x: 1 }) });
  await settle();
  assert.equal(snap(host).playback.playing, true, 'forged command must not pause the room');

  // A genuine command, replayed verbatim, only takes effect once.
  const seen = [];
  const hostT = host.transport;
  const origSend = guests[0].transport.send.bind(guests[0].transport);
  guests[0].transport.send = (type, data, to) => { if (type === 'cmd') seen.push([type, data, to]); return origSend(type, data, to); };
  await guests[0].invoke('TogglePlay'); await settle();
  assert.equal(snap(host).playback.playing, false);
  const [, cmd] = seen[0];
  evil.send('cmd', cmd, hostT.selfId); await settle();            // wrong peer id for that member
  origSend('cmd', cmd, hostT.selfId); await settle();             // right peer, stale nonce
  assert.equal(snap(host).playback.playing, false, 'replay must not toggle again');
});

test('members can’t remove other people’s songs; the host can', async () => {
  const { host, guests } = await party(3);
  await host.invoke('AddSong', VIDEO(1));
  await guests[0].invoke('AddSong', VIDEO(2));
  await settle();
  const queued = snap(host).queue[0];

  await guests[1].invoke('RemoveSong', queued.queueId); await settle();
  assert.equal(snap(host).queue.length, 1);
  await host.invoke('RemoveSong', queued.queueId); await settle();
  assert.equal(snap(host).queue.length, 0);
});

test('graceful host leave hands the room over; music and history survive', async () => {
  const { host, guests } = await party(3);
  await host.invoke('AddSong', VIDEO(1)); await settle();
  await host.invoke('LeaveRoom'); await settle(100);

  const [a, b] = guests;
  assert.equal(snap(a).members.length, 2);
  assert.equal(snap(a).members.find((m) => m.isHost).name, 'Guest1');
  assert.equal(snap(b).members.find((m) => m.isHost).name, 'Guest1');
  assert.equal(snap(b).playback.song.id, VIDEO(1));

  await b.invoke('Seek', 50); await settle();                      // the new host still serves commands
  assert.equal(Math.round(snap(a).playback.position), 50);
  assert.ok(a.integrityOk && b.integrityOk);
});

test('host vanishing abruptly: oldest remaining member takes over, chain stays valid', async () => {
  const { host, guests } = await party(3);
  await host.invoke('AddSong', VIDEO(1)); await settle();
  await host.transport.leave();                                    // tab closed, no goodbye
  await settle(300);

  const [a, b] = guests;
  const hostsSeenByA = snap(a).members.filter((m) => m.isHost).map((m) => m.name);
  assert.deepEqual(hostsSeenByA, ['Guest1']);
  assert.deepEqual(snap(b).members.filter((m) => m.isHost).map((m) => m.name), ['Guest1']);
  assert.ok(a.chat.some((m) => /Host left · Guest1 is now the host/.test(m.text)));

  await b.invoke('AddSong', VIDEO(2)); await settle();
  assert.equal(snap(a).queue[0].id, VIDEO(2));
  assert.ok(a.integrityOk && b.integrityOk, 'hash chain must continue across the failover');
});

test('a unknown-duration song learns its length from the first player', async () => {
  const { host, guests } = await party(2);
  META.get = (id) => ({ id, title: `YouTube video ${id}`, author: 'YouTube', duration: 0 });
  try {
    await guests[0].invoke('AddSong', VIDEO(5)); await settle();
    assert.equal(snap(host).playback.song.duration, 0);
    await guests[0].invoke('SongMeta', VIDEO(5), 245.3, 'Real Title'); await settle();
    assert.equal(snap(host).playback.song.duration, 245);
    assert.equal(snap(guests[0]).playback.song.title, 'Real Title');
  } finally { META.get = (id) => ({ id, title: `Song ${id}`, author: 'Artist', duration: 180 }); }
});

test('a reconnecting identity keeps its seat instead of becoming a duplicate member', async () => {
  const { net, host, code } = await (async () => { const p = await party(1); return p; })();
  const { make } = { make: null };
  // same browser tab (same stored identity) joins twice, e.g. after a page reload
  const shared = { saved: null };
  const mk = () => new P2PBackend({
    createTransport: async (c) => { const t = net.join(c); return t; },
    store: { load: () => shared.saved, save: (v) => { shared.saved = v; } },
    meta: { remember() {}, resolve: async () => null }, search: async () => [],
    helloTimeoutMs: 300, tickMs: 60_000, pingMs: 60_000,
  });
  const first = mk();
  assert.ok((await first.invoke('JoinRoom', code, 'Zed', 'c')).ok);
  await settle();
  const reloaded = mk();
  assert.ok((await reloaded.invoke('JoinRoom', code, 'Zed', 'c')).ok);
  await settle();
  assert.equal(snap(host).members.filter((m) => m.name.startsWith('Zed')).length, 1);
});

test('hold-to-2x from a guest speeds up the whole room and is released when that guest leaves', async () => {
  const { host, guests } = await party(3);
  await host.invoke('AddSong', VIDEO(1)); await settle();

  await guests[0].invoke('SetRate', 2); await settle();
  assert.equal(snap(host).playback.rate, 2);
  assert.equal(snap(guests[1]).playback.rate, 2);

  await guests[1].invoke('SetRate', 3); await settle();            // only 1x and 2x exist
  assert.equal(snap(host).playback.rate, 2);

  await guests[0].invoke('LeaveRoom'); await settle();             // the holder disappears
  assert.equal(snap(host).playback.rate, 1);
  assert.equal(snap(guests[1]).playback.rate, 1);
});

test('reactions are rate-limited per person so nobody can flood the screen', async () => {
  const { host, guests } = await party(2);
  for (let i = 0; i < 8; i++) await guests[0].invoke('React', '🔥');
  await settle();
  assert.ok(host.events.reaction.length >= 1 && host.events.reaction.length <= 2, `got ${host.events.reaction.length}`);
});
