import { randomUUID } from 'node:crypto';
export class Approvals {
  #plans = new Map();
  constructor(now = Date.now) { this.now = now; }
  issue(connectionId, plan) {
    for (const [id, entry] of this.#plans) if (entry.expiresAt <= this.now()) this.#plans.delete(id);
    if (this.#plans.size >= 100) throw new Error('Too many pending previews');
    const id = randomUUID();
    this.#plans.set(id, { connectionId, plan: structuredClone(plan), expiresAt: this.now() + 300000 });
    return id;
  }
  peek(id) {
    const entry = this.#plans.get(id);
    if (!entry || entry.expiresAt <= this.now()) { this.#plans.delete(id); return null; }
    return structuredClone(entry);
  }
  consume(id) {
    const entry = this.#plans.get(id);
    this.#plans.delete(id);
    return entry && entry.expiresAt > this.now() ? entry : null;
  }
  cancel(id) { this.#plans.delete(id); }
  removeConnection(id) { for (const [key, entry] of this.#plans) if (entry.connectionId === id) this.#plans.delete(key); }
}
