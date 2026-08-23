/**
 * What this connection made recently — so a booth created later in the same
 * conversation can carry it without the model having to remember ids.
 *
 * The first real booth round showed the gap: a filter made with
 * `create_filter` three messages earlier was not on the booth, because
 * `create_booth` only adds what it is told and the Studio's default "Normal".
 * The frame saved with `save_frame` did get on, but only by luck — the
 * operator's own frames lead the starter pool. This makes both deliberate.
 *
 * In memory, keyed to the job store's owner key (a hash of the token, never
 * the token), bounded in count and age, and lost on restart — the same
 * contract as the job store, and for the same reason: this is a convenience
 * for one conversation, not a record of anything. The Studio keeps the record.
 */

export type CreationKind = "filter" | "frame";

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PER_KIND = 24;
/** Owners are pruned on write, so a long-lived process does not grow without bound. */
const MAX_OWNERS = 500;

interface Entry {
  id: string;
  at: number;
}

export class RecentCreations {
  private readonly byOwner = new Map<string, Record<CreationKind, Entry[]>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  remember(ownerKey: string, kind: CreationKind, id: string | undefined | null): void {
    if (!id) return;
    let owner = this.byOwner.get(ownerKey);
    if (!owner) {
      if (this.byOwner.size >= MAX_OWNERS) {
        // Drop the oldest owner wholesale; Map iteration is insertion order.
        const oldest = this.byOwner.keys().next().value;
        if (oldest !== undefined) this.byOwner.delete(oldest);
      }
      owner = { filter: [], frame: [] };
      this.byOwner.set(ownerKey, owner);
    }
    const list = owner[kind].filter((e) => e.id !== id);
    list.unshift({ id, at: this.now() });
    owner[kind] = list.slice(0, MAX_PER_KIND);
  }

  /** Newest first, still within the window. */
  list(ownerKey: string, kind: CreationKind): string[] {
    const owner = this.byOwner.get(ownerKey);
    if (!owner) return [];
    const cutoff = this.now() - TTL_MS;
    const live = owner[kind].filter((e) => e.at >= cutoff);
    owner[kind] = live;
    return live.map((e) => e.id);
  }

  /** For tests. */
  clear(): void {
    this.byOwner.clear();
  }
}

export const recentCreations = new RecentCreations();
