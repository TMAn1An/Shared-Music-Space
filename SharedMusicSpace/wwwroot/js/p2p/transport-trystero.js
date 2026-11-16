// Real peer-to-peer transport: WebRTC data channels, with peers discovered through public BitTorrent trackers
// (via the vendored Trystero library). No server of ours is involved. Messages are end-to-end encrypted by WebRTC.

const APP_ID = 'music-space-p2p-v1';

export async function createTrysteroTransport(roomId, extra = {}) {
  const { joinRoom } = await import('../../vendor/trystero-torrent.js');
  const room = joinRoom({ appId: APP_ID, ...extra }, roomId);
  const channel = room.makeAction('ms');

  const handlers = new Map();
  const joinFns = [];
  const leaveFns = [];
  const peers = new Set();

  channel.onMessage((packet, ctx) => {
    for (const fn of handlers.get(packet?.t) ?? []) fn(packet.d, ctx.peerId);
  });
  room.onPeerJoin(({ peerId }) => { peers.add(peerId); joinFns.forEach((fn) => fn(peerId)); });
  room.onPeerLeave(({ peerId }) => { peers.delete(peerId); leaveFns.forEach((fn) => fn(peerId)); });

  const self = await room.getSelf();
  return {
    ready: Promise.resolve(self.peerId),
    selfId: self.peerId,
    peers: () => new Set(peers),
    send(type, data, target) {
      const packet = { t: type, d: data };
      return (target ? channel.send(packet, { peerIds: [target] }) : channel.send(packet)).catch(() => {});
    },
    on(type, fn) { (handlers.get(type) ?? handlers.set(type, []).get(type)).push(fn); },
    onPeerJoin: (fn) => joinFns.push(fn),
    onPeerLeave: (fn) => leaveFns.push(fn),
    leave: () => room.leave(),
  };
}
