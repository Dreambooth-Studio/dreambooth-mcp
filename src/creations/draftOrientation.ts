/**
 * Which way each booth draft's screen faces, as the operator asked for it.
 *
 * The Studio draws every draft for both screens (phone = portrait, laptop =
 * landscape) and the draft does not record which one the booth is for. That
 * is decided when the booth is created (`mode` on POST
 * /api/projects/onboarding). So a "landscape, please" said before
 * `start_booth` has to be carried here until `create_booth`. Before this, every
 * booth made from chat was created portrait, whatever was asked (2026-11-12).
 *
 * Same contract as `recentCreations`: in memory, keyed to the job store's owner
 * key, bounded in count and age, lost on restart. `create_booth` also takes the
 * orientation as an argument, so a restart loses nothing the conversation does
 * not still know.
 */

export type BoothOrientation = "portrait" | "landscape";

/** A draft lives seven days in the Studio; a conversation about one rarely spans more than a day. */
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

interface Entry {
  orientation: BoothOrientation;
  at: number;
}

export class DraftOrientations {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  remember(ownerKey: string, draftId: string | undefined, orientation: BoothOrientation | undefined): void {
    if (!draftId || !orientation) return;
    const key = `${ownerKey}:${draftId}`;
    // Re-inserted at the end, so Map order stays oldest-first for pruning.
    this.entries.delete(key);
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { orientation, at: this.now() });
  }

  get(ownerKey: string, draftId: string): BoothOrientation | undefined {
    const key = `${ownerKey}:${draftId}`;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.orientation;
  }

  /** For tests. */
  clear(): void {
    this.entries.clear();
  }
}

export const draftOrientations = new DraftOrientations();
