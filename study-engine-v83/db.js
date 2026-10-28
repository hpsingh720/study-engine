// IndexedDB storage. Books/pages/queue stay on the device that has the books;
// everything in SYNCED is shared across devices through Supabase.
const SYNCED = ['topics', 'sheets', 'mcqs', 'media', 'attempts', 'tests', 'notes', 'prefs', 'lectures', 'classes'];
let _db;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open('amc-engine', 3);
    r.onupgradeneeded = () => {
      const db = r.result;
      const mk = (n, opts, idx = []) => {
        if (db.objectStoreNames.contains(n)) return;
        const s = db.createObjectStore(n, opts);
        idx.forEach(([name, path]) => s.createIndex(name, path));
      };
      mk('books', { keyPath: 'id' });
      mk('pages', { keyPath: ['bookId', 'p'] }, [['bookId', 'bookId']]);
      mk('files', { keyPath: 'id' });
      mk('queue', { keyPath: 'id' }, [['status', 'status']]);
      mk('meta', { keyPath: 'k' });
      mk('topics', { keyPath: 'id' }, [['system', 'system'], ['dirty', '_dirty']]);
      mk('sheets', { keyPath: 'id' }, [['dirty', '_dirty']]);
      mk('mcqs', { keyPath: 'id' }, [['topicId', 'topicId'], ['dirty', '_dirty']]);
      mk('media', { keyPath: 'id' }, [['dirty', '_dirty']]);
      mk('attempts', { keyPath: 'id' }, [['mcqId', 'mcqId'], ['dirty', '_dirty']]);
      mk('tests', { keyPath: 'id' }, [['dirty', '_dirty']]);
      mk('notes', { keyPath: 'id' }, [['dirty', '_dirty']]);
      mk('prefs', { keyPath: 'id' }, [['dirty', '_dirty']]);
      mk('vecs', { keyPath: ['bookId', 'p', 'c'] }, [['bookId', 'bookId']]); // offline AI search index
      mk('lectures', { keyPath: 'id' }, [['dirty', '_dirty']]);             // recorded college lectures
      mk('classes', { keyPath: 'id' }, [['dirty', '_dirty'], ['date', 'date']]); // imported class rosters
    };
    r.onblocked = () => { try { toast('Close the app’s other tabs, then reload, to finish updating.', 8000); } catch (e) {} };
    r.onsuccess = () => { _db = r.result; _db.onversionchange = () => { _db.close(); location.reload(); }; res(_db); };
    r.onerror = () => rej(r.error);
  });
}

const DB = {
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async store(s, mode = 'readonly') { return (await openDB()).transaction(s, mode).objectStore(s); },
  stamp(s, o, opt) {
    if (!SYNCED.includes(s)) return;
    if (opt.fromSync) { if (o._dirty == null) o._dirty = 0; }
    else { o.updated = Date.now(); o._dirty = 1; }
  },
  async get(s, k) { return this.req((await this.store(s)).get(k)); },
  async all(s) { return this.req((await this.store(s)).getAll()); },
  async live(s) { return (await this.all(s)).filter(o => !o.deleted); },
  async byIndex(s, i, v) { return this.req((await this.store(s)).index(i).getAll(v)); },
  async count(s, i, v) { const st = await this.store(s); return this.req(i ? st.index(i).count(v) : st.count()); },
  async put(s, o, opt = {}) {
    this.stamp(s, o, opt);
    await this.req((await this.store(s, 'readwrite')).put(o));
    if (SYNCED.includes(s) && !opt.fromSync && window.Sync) Sync.soon();
    return o;
  },
  async putMany(s, arr, opt = {}) {
    if (!arr.length) return;
    const db = await openDB();
    await new Promise((res, rej) => {
      const t = db.transaction(s, 'readwrite'); const st = t.objectStore(s);
      for (const o of arr) { this.stamp(s, o, opt); st.put(o); }
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
    if (SYNCED.includes(s) && !opt.fromSync && window.Sync) Sync.soon();
  },
  async del(s, k) { return this.req((await this.store(s, 'readwrite')).delete(k)); },
  async delRange(s, index, value) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const t = db.transaction(s, 'readwrite'); const r = t.objectStore(s).index(index).openCursor(IDBKeyRange.only(value));
      r.onsuccess = () => { const c = r.result; if (c) { c.delete(); c.continue(); } };
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  },
  // Stream records through a callback without loading everything at once.
  async each(s, index, value, cb) {
    const st = await this.store(s);
    return new Promise((res, rej) => {
      const src = index ? st.index(index) : st;
      const r = src.openCursor(value != null ? IDBKeyRange.only(value) : null);
      r.onsuccess = () => { const c = r.result; if (!c) return res(); if (cb(c.value) === false) return res(); c.continue(); };
      r.onerror = () => rej(r.error);
    });
  },
  async meta(k, v) {
    if (v === undefined) return (await this.get('meta', k))?.v;
    await this.put('meta', { k, v });
  }
};

// Preferences (synced): exam dates, daily goal, per-system targets.
const DEFAULT_PREFS = {
  id: 'main', daily: 30, biweeklyCount: 40, studyDays: 6, focus: 'CVS', targets: {}, starts: {},
  exams: [
    { name: 'MBBS final exams', date: '2027-04-01' },
    { name: 'AMC portfolio & EPIC', date: '2027-05-01' },
    { name: 'AMC Part 1 MCQ', date: '2027-09-15' }
  ]
};
const Prefs = {
  async get() { const p = await DB.get('prefs', 'main'); return Object.assign(structuredClone(DEFAULT_PREFS), p || {}); },
  async set(patch) { const p = await this.get(); Object.assign(p, patch); await DB.put('prefs', p); return p; }
};
