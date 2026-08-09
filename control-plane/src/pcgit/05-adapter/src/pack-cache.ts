/**
 * Cross-request byte cache for immutable packfiles.
 *
 * WHY THIS MODULE EXISTS (01-cost-model.md §1, "the read path"):
 * `src/storage/readObjectPacked.js` has NO ranged read. `fs.read` takes no
 * offset or length, so fetching one byte of one packed blob does this:
 *
 *     if (!p.pack) p.pack = fs.read(packFile)   // the ENTIRE 25 MB packfile
 *     ...
 *     shasumRange(pack, { start: 0, end: pack.length - 20 })  // SHA-1 over all of it
 *
 * isomorphic-git memoises the parsed `.idx` and the pack Buffer in its `cache`
 * argument -- but `cache` defaults to a fresh `{}` per API call. On Cloud Run
 * that means every single HTTP request re-downloads 25 MB from GCS and re-SHA-1s
 * it. `gitCache` in `firestore-gcs-fs.ts` fixes the isomorphic-git side; this
 * module fixes the transport side, so even a cold `gitCache` (new deploy, cache
 * eviction, a caller who forgot to thread it) does not pay the download twice.
 *
 * SAFETY -- AND THE LIMIT OF THE OLD ARGUMENT. The previous version of this
 * comment argued that caching by path alone is safe because a packfile is named
 * `pack-<sha1-of-its-own-contents>.pack`, so the name can never be rebound to
 * different bytes. That argument is TRUE and it is NOT ENOUGH: it covers
 * OVERWRITE and says nothing about DELETION. `gc`/repack deletes packs, and a
 * by-name cache then keeps serving bytes for an object that no longer exists --
 * on ANOTHER instance, which never saw the delete at all. Multi-instance
 * assertion 61 caught exactly that: `stat` said ENOENT while `readFile`
 * returned 2 KiB of pack.
 *
 * So an entry is now qualified by the GCS GENERATION it was read at, and
 * `GcsStore.readFile` revalidates that generation against the authoritative
 * object metadata on every read -- the same metadata `stat` consults, which is
 * what makes the two agree by construction. The cache still saves the whole
 * object BODY transfer (the expensive part: ~25 MB and a SHA-1 over all of it);
 * it no longer pretends to know that the object still exists.
 *
 * Keys are supplied by GcsStore and include the BUCKET as well as the repo
 * prefix -- two tenants on different buckets can otherwise share a prefix and
 * therefore a key. Everything else -- loose objects, refs, `.git/index`,
 * working-tree files -- is mutable and is NEVER cached here.
 */

const IMMUTABLE_PACK_NAME = /^pack-[0-9a-f]{40}\.(pack|idx)$/;

/** True if this path is safe to cache forever by name alone. */
export function isImmutablePackPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return IMMUTABLE_PACK_NAME.test(name);
}

interface Entry {
  bytes: Buffer;
  /**
   * The GCS object generation these bytes were read at. A generation is minted
   * fresh on every write, and a deleted-then-recreated object never reuses the
   * old one, so an entry whose generation no longer matches the live object is
   * either stale or orphaned and must not be served.
   */
  generation: string;
}

/**
 * Insertion-ordered LRU bounded by total bytes. A `Map` preserves insertion
 * order, so re-inserting on hit gives LRU eviction for free.
 */
export class PackCache {
  private readonly entries = new Map<string, Entry>();
  private bytesHeld = 0;
  public hits = 0;
  public misses = 0;

  constructor(private readonly maxBytes: number) {}

  /**
   * Bytes for `key`, but ONLY if they were read at `generation`.
   *
   * A caller that cannot establish the live generation must not get a hit, so
   * an empty/unknown generation always misses. A generation MISMATCH evicts on
   * the spot: the entry describes an object version that no longer exists, and
   * keeping it would only waste budget until the LRU got round to it.
   */
  get(key: string, generation: string): Buffer | undefined {
    const hit = this.entries.get(key);
    if (!hit) {
      this.misses++;
      return undefined;
    }
    if (generation === '' || hit.generation !== generation) {
      this.misses++;
      this.delete(key);
      return undefined;
    }
    this.hits++;
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.bytes;
  }

  set(key: string, bytes: Buffer, generation: string): void {
    // Without a generation there is nothing to revalidate against later, so the
    // entry could never be served. Refuse it rather than hold the bytes.
    if (generation === '') return;

    // A single object larger than the whole budget is simply not cached,
    // rather than evicting everything else to make room for it.
    if (bytes.byteLength > this.maxBytes) return;

    const existing = this.entries.get(key);
    if (existing) {
      this.bytesHeld -= existing.bytes.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, { bytes, generation });
    this.bytesHeld += bytes.byteLength;

    while (this.bytesHeld > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const victim = this.entries.get(oldest.value)!;
      this.bytesHeld -= victim.bytes.byteLength;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.bytesHeld -= existing.bytes.byteLength;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.bytesHeld = 0;
  }

  get size(): number {
    return this.bytesHeld;
  }
}
