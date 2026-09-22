// cache.js
// A small key/value store kept in a JSON file on disk.
//
// It exists because every lookup this addon makes — an IMDb id for a filename,
// a full metadata record for an IMDb id — is expensive (a network round trip)
// and almost never changes. Without a cache a library of a few thousand files
// would hammer Cinemeta and TMDB on every single scan.
//
// Three things it does that a plain object does not:
//
//   - TTL per entry, so a record eventually gets refreshed rather than being
//     believed forever.
//   - Negative caching. A miss is stored too, with a shorter TTL: a title the
//     providers do not know should not be looked up again on every scan, but
//     it is worth retrying in a few days (metadata databases do grow).
//   - A cap on the number of entries, so a long-lived container with a
//     changing library cannot grow the file without bound.

const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {object}  opts
 * @param {string}  opts.file       Path of the JSON file backing this store.
 * @param {number}  opts.ttlDays    Lifetime of a hit.
 * @param {number}  opts.missTtlDays Lifetime of a miss (null value).
 * @param {number} [opts.maxEntries] Upper bound; the oldest entries go first.
 * @param {string} [opts.label]     Name used in log lines.
 */
function createCache({ file, ttlDays, missTtlDays, maxEntries = 50000, label = 'cache' }) {
  const ttl = ttlDays * DAY;
  const missTtl = missTtlDays * DAY;

  /** key -> { v: value, t: written-at ms } */
  let store = new Map();
  let dirty = false;
  let saveTimer = null;

  function load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;                                   // missing or corrupt: start empty
    }
    if (!raw || typeof raw !== 'object') return;

    for (const [key, rec] of Object.entries(raw)) {
      // Entries written by an older version of the addon have no timestamp.
      // They are kept but dated to now, so they expire on the normal schedule
      // instead of being thrown away on upgrade.
      if (rec && typeof rec === 'object' && 't' in rec) store.set(key, rec);
      else store.set(key, { v: rec, t: Date.now() });
    }
    console.log(`Loaded ${store.size} entries into the ${label} from ${file}.`);
  }

  function expired(rec) {
    const life = rec.v === null || rec.v === undefined ? missTtl : ttl;
    return Date.now() - rec.t > life;
  }

  /**
   * Returns `{ value }` for a live entry, or `undefined` when the key is
   * unknown or stale. The wrapper matters: a cached miss is a real answer of
   * `null`, which has to stay distinguishable from "not cached".
   */
  function get(key) {
    const rec = store.get(key);
    if (!rec) return undefined;
    if (expired(rec)) {
      store.delete(key);
      return undefined;
    }
    return { value: rec.v };
  }

  function set(key, value) {
    // Map preserves insertion order, and re-inserting moves a key to the end,
    // which is what makes the prune below drop the oldest writes.
    store.delete(key);
    store.set(key, { v: value, t: Date.now() });
    dirty = true;
    scheduleSave();
  }

  function prune() {
    for (const [key, rec] of store) {
      if (expired(rec)) store.delete(key);
    }
    const excess = store.size - maxEntries;
    if (excess > 0) {
      let n = 0;
      for (const key of store.keys()) {
        if (n++ >= excess) break;
        store.delete(key);
      }
    }
  }

  /**
   * Writes are batched: a scan sets hundreds of keys in a burst, and each one
   * serialising the whole file would dominate the scan time.
   */
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, 3000);
    // Never hold the process open just to flush a cache.
    if (saveTimer.unref) saveTimer.unref();
  }

  function save() {
    if (!dirty) return;
    prune();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Written to a sibling first: a container killed mid-write would
      // otherwise leave a truncated file that fails to parse on next start.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (err) {
      console.warn(`Could not write the ${label} to ${file}: ${err.message}`);
    }
  }

  load();

  // A restart should not throw away everything learned since the last flush.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { save(); process.exit(0); });
  }
  process.once('beforeExit', save);

  return { get, set, save, size: () => store.size };
}

module.exports = { createCache };
