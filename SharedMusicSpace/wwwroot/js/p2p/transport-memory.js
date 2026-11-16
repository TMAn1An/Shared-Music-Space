// In-process "network" used by the tests (and handy for demos): same interface as the real WebRTC transport.

export class MemoryNetwork {
  #rooms = new Map();
  #seq = 0;
  latency = 0;

  join(roomId) {
    const net = this;
    const peerId = `peer-${++this.#seq}`;
    const members = this.#rooms.get(roomId) ?? new Map();
    this.#rooms.set(roomId, members);

    const handlers = { msg: new Map(), join: [], leave: [] };
    const self = {
      peerId,
      deliver: (type, data, from) => { for (const fn of handlers.msg.get(type) ?? []) fn(data, from); },
      peerJoined: (id) => handlers.join.forEach((fn) => fn(id)),
      peerLeft: (id) => handlers.leave.forEach((fn) => fn(id)),
    };

    const later = (fn) => setTimeout(fn, net.latency);
    const transport = {
      ready: Promise.resolve(peerId),
      selfId: peerId,
      peers: () => new Set([...members.keys()].filter((id) => id !== peerId)),
      send(type, data, target) {
        const copy = JSON.parse(JSON.stringify(data ?? null)); // like the wire: no shared references
        for (const [id, peer] of members) {
          if (id === peerId || (target && id !== target)) continue;
          later(() => { if (members.has(id)) peer.deliver(type, copy, peerId); });
        }
      },
      on(type, fn) { (handlers.msg.get(type) ?? handlers.msg.set(type, []).get(type)).push(fn); },
      onPeerJoin(fn) { handlers.join.push(fn); },
      onPeerLeave(fn) { handlers.leave.push(fn); },
      async leave() {
        if (!members.delete(peerId)) return;
        for (const peer of members.values()) later(() => peer.peerLeft(peerId));
      },
    };

    // Announce after the caller has had a chance to attach handlers.
    later(() => { for (const [id, peer] of members) if (id !== peerId) { peer.peerJoined(peerId); self.peerJoined(id); } });
    members.set(peerId, self);
    return transport;
  }
}
