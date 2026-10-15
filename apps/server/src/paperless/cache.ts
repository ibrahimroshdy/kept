// A small in-memory cache with a time limit and a size cap (D248): Paperless thumbnails and
// whether a location's Paperless answers, for a few minutes, so a thing page with ten links
// doesn't make ten calls each time it opens. Per process (one server serves a self-hosted Kept).
// What is cached is only ever handed out after the request's own access check.

export class TtlCache<V> {
  readonly #entries = new Map<string, { value: V; until: number; size: number }>();
  #size = 0;

  constructor(
    readonly ttlMs: number,
    readonly maxSize: number,
    readonly sizeOf: (value: V) => number = () => 1,
  ) {}

  get(key: string, now = Date.now()): V | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.until <= now) {
      this.delete(key);
      return undefined;
    }
    // Most recently used last.
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    const size = this.sizeOf(value);
    if (size > this.maxSize) return;
    this.delete(key);
    this.#entries.set(key, { value, until: now + this.ttlMs, size });
    this.#size += size;
    for (const [k] of this.#entries) {
      if (this.#size <= this.maxSize) break;
      this.delete(k);
    }
  }

  delete(key: string): void {
    const hit = this.#entries.get(key);
    if (!hit) return;
    this.#entries.delete(key);
    this.#size -= hit.size;
  }

  /** Drops every entry whose key starts with `prefix` (a connection that changed or went). */
  deletePrefix(prefix: string): void {
    for (const k of [...this.#entries.keys()]) if (k.startsWith(prefix)) this.delete(k);
  }

  get size(): number {
    return this.#size;
  }
}
