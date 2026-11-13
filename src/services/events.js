/**
 * Server-Sent Events fan-out, keyed by user. A user may have several open
 * connections (phone + emulator); each gets every event addressed to them.
 */
export class EventHub {
  constructor() {
    this.clients = new Map(); // userId -> Set<res>
  }

  subscribe(userId, res) {
    let set = this.clients.get(userId);
    if (!set) this.clients.set(userId, (set = new Set()));
    set.add(res);
    return () => {
      set.delete(res);
      if (set.size === 0) this.clients.delete(userId);
    };
  }

  send(userIds, type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const id of new Set(userIds)) {
      for (const res of this.clients.get(id) ?? []) res.write(frame);
    }
  }

  isOnline(userId) {
    return this.clients.has(userId);
  }
}
