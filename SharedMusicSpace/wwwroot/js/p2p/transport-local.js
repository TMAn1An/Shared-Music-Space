// Same-browser transport (BroadcastChannel): lets several tabs of one browser act as separate peers.
// Used with ?p2p=local for demos and end-to-end tests — no network, no trackers.

export function createLocalTransport(roomId) {
  const peerId = `tab-${crypto.randomUUID().slice(0, 8)}`;
  const channel = new BroadcastChannel(`music-space:${roomId}`);
  const known = new Set();
  const handlers = new Map();
  const joinFns = [];
  const leaveFns = [];

  const post = (kind, extra = {}) => channel.postMessage({ kind, from: peerId, ...extra });
  const seen = (id) => { if (!known.has(id)) { known.add(id); joinFns.forEach((fn) => fn(id)); return true; } return false; };

  channel.onmessage = ({ data }) => {
    if (!data || data.from === peerId) return;
    if (data.to && data.to !== peerId) return;
    if (data.kind === 'hi') { if (seen(data.from)) post('hi', { to: data.from }); return; }
    if (data.kind === 'bye') { if (known.delete(data.from)) leaveFns.forEach((fn) => fn(data.from)); return; }
    if (data.kind === 'msg') { seen(data.from); for (const fn of handlers.get(data.type) ?? []) fn(data.data, data.from); }
  };

  const bye = () => post('bye');
  addEventListener('pagehide', bye);
  setTimeout(() => post('hi'), 0);

  return {
    ready: Promise.resolve(peerId),
    selfId: peerId,
    peers: () => new Set(known),
    send: (type, data, to) => post('msg', { type, data: JSON.parse(JSON.stringify(data ?? null)), to }),
    on: (type, fn) => (handlers.get(type) ?? handlers.set(type, []).get(type)).push(fn),
    onPeerJoin: (fn) => joinFns.push(fn),
    onPeerLeave: (fn) => leaveFns.push(fn),
    async leave() { removeEventListener('pagehide', bye); bye(); channel.close(); },
  };
}
