import test from 'node:test';
import assert from 'node:assert/strict';
import { HashChain } from '../SharedMusicSpace/wwwroot/js/core/chain.js';
import { Identity, verify, idFromKey } from '../SharedMusicSpace/wwwroot/js/core/identity.js';
import { RoomCore } from '../SharedMusicSpace/wwwroot/js/core/room.js';
import { parseVideoId } from '../SharedMusicSpace/wwwroot/js/p2p/meta.js';

test('hash chain links entries and detects tampering', async () => {
  const a = new HashChain('ROOM01');
  const e1 = await a.append({ by: 'x' });
  const e2 = await a.append({ by: 'y' });
  assert.equal(e2.prev, e1.hash);
  assert.ok(await a.verifyTail());

  const b = new HashChain('ROOM01');
  assert.ok(await b.accept(e1));
  assert.ok(await b.accept(e2));

  const c = new HashChain('ROOM01');
  assert.ok(await c.accept(e1));
  assert.equal(await c.accept({ ...e2, body: { by: 'forged' } }), false);        // content changed
  const d = new HashChain('ROOM01');
  assert.equal(await d.accept(e2), false);                                        // entry skipped
  assert.equal(await new HashChain('OTHER1').accept(e1), false);                  // different room's chain
});

test('identity: signatures verify, forgeries and wrong keys do not', async () => {
  const alice = await Identity.create();
  const mallory = await Identity.create();
  const msg = { cmd: 'skip', n: 1 };
  const sig = await alice.sign(msg);
  assert.ok(await verify(alice.publicKey, sig, msg));
  assert.equal(await verify(alice.publicKey, sig, { cmd: 'skip', n: 2 }), false);
  assert.equal(await verify(mallory.publicKey, sig, msg), false);
  assert.equal(alice.id, await idFromKey(alice.publicKey));
  assert.notEqual(alice.id, mallory.id);

  const restored = await Identity.restore(await alice.export());
  assert.equal(restored.id, alice.id);
  assert.ok(await verify(alice.publicKey, await restored.sign(msg), msg));
});

const clock = () => { let t = 1_000_000; return { now: () => t, advance: (s) => { t += s * 1000; } }; };
const song = (id, duration = 200, addedBy = 'Ann') => ({ queueId: `q-${id}`, id, title: id, author: 'A', duration, addedBy });

test('RoomCore mirrors the server rules: queue, playhead, host hand-over', () => {
  const c = clock();
  const r = new RoomCore({ code: 'ABC123', name: 'T', now: c.now });
  const ann = r.join({ id: 'a', key: 'ka', peerId: 'pa', name: 'Ann' }).member;
  r.join({ id: 'b', key: 'kb', peerId: 'pb', name: 'Bob' });
  assert.equal(r.hostId, ann.id);

  assert.equal(r.addSong(song('v1', 100)), 'started');
  assert.equal(r.addSong(song('v2', 100)), 'added');
  assert.equal(r.addSong(song('v1')), 'duplicate');

  c.advance(30);
  assert.equal(r.snapshot().playback.position, 30);
  r.togglePlay(); c.advance(500);
  assert.equal(r.snapshot().playback.position, 30);
  r.togglePlay();

  r.seek(9999);
  assert.equal(r.snapshot().playback.position, 99);
  assert.equal(r.trackEnded('nope'), false);
  assert.equal(r.trackEnded('v1'), true);
  assert.equal(r.trackEnded('v1'), false);
  assert.equal(r.snapshot().playback.song.id, 'v2');

  const { newHost } = r.leave('a');
  assert.equal(newHost.id, 'b');
  assert.equal(r.hostId, 'b');
});

test('RoomCore state export/import keeps the playhead on the receiver’s clock', () => {
  const host = clock();
  const r = new RoomCore({ code: 'ABC123', name: 'T', now: host.now });
  r.join({ id: 'a', key: 'k', peerId: 'p', name: 'Ann' });
  r.addSong(song('v1', 300));
  host.advance(42);
  const state = JSON.parse(JSON.stringify(r.exportState()));

  // The receiver's clock runs 5 s AHEAD of the host's (so hostClock - localClock = -5000), and 2 s of network time passed.
  let localNow = state.hostTime + 2000 + 5000;
  const replica = RoomCore.fromState(state, { now: () => localNow, skewMs: -5000 });
  assert.equal(Math.round(replica.snapshot().playback.position), 44);
});

test('RoomCore.setDuration fills in unknown lengths once', () => {
  const r = new RoomCore({ code: 'ABC123', name: 'T' });
  r.join({ id: 'a', key: 'k', peerId: 'p', name: 'Ann' });
  r.addSong({ queueId: 'q', id: 'abcdefghijk', title: 'YouTube video abcdefghijk', author: 'YouTube', duration: 0, addedBy: 'Ann' });
  assert.ok(r.setDuration('abcdefghijk', 212.6, 'Real title'));
  assert.equal(r.current.duration, 212);
  assert.equal(r.current.title, 'Real title');
  assert.equal(r.setDuration('abcdefghijk', 999), false);
});

test('parseVideoId handles the usual link shapes', () => {
  const id = 'dQw4w9WgXcQ';
  for (const input of [id, `https://www.youtube.com/watch?v=${id}&t=1s`, `https://youtu.be/${id}?si=x`, `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`, `https://music.youtube.com/watch?v=${id}`, `https://www.youtube.com/embed/${id}`]) {
    assert.equal(parseVideoId(input), id, input);
  }
  for (const bad of ['', 'hello world', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/short']) assert.equal(parseVideoId(bad), null, bad);
});

test('RoomCore speed: 2x moves the playhead twice as fast without jumping, resets per song and when its owner leaves', () => {
  const c = clock();
  const r = new RoomCore({ code: 'ABC123', name: 'T', now: c.now });
  r.join({ id: 'a', key: 'ka', peerId: 'pa', name: 'Ann' });
  r.join({ id: 'b', key: 'kb', peerId: 'pb', name: 'Bob' });
  r.addSong(song('v1', 1000)); r.addSong(song('v2', 1000));

  c.advance(10);
  assert.ok(r.setRate(2, 'b'));
  assert.equal(r.snapshot().playback.position, 10);             // no jump
  assert.equal(r.snapshot().playback.rate, 2);
  c.advance(10);
  assert.equal(r.snapshot().playback.position, 30);             // 10 s real time = 20 s of music

  for (const bad of [0.5, 1.5, 3, NaN]) assert.equal(r.setRate(bad, 'a'), false, `rate ${bad}`);
  assert.equal(r.setRate(2, 'stranger'), false);

  r.skip();                                                      // next song starts at normal speed
  assert.equal(r.snapshot().playback.rate, 1);

  r.setRate(2, 'b');
  r.leave('b');                                                  // the holder vanished → speed released
  assert.equal(r.snapshot().playback.rate, 1);

  // survives export/import (host failover keeps the speed)
  r.setRate(2, 'a');
  const replica = RoomCore.fromState(JSON.parse(JSON.stringify(r.exportState())), { now: c.now });
  assert.equal(replica.snapshot().playback.rate, 2);
  c.advance(5);
  assert.equal(Math.round(replica.snapshot().playback.position - r.snapshot().playback.position), 0);
});
