// Optional cross-device sync through a free Supabase project (one table).
const SYNC_SQL = `create table if not exists records (
  id text primary key,
  store text not null,
  data jsonb not null,
  updated bigint not null default 0,
  deleted boolean not null default false,
  synced_at timestamptz not null default clock_timestamp()
);
create index if not exists records_synced_at on records (synced_at);
create or replace function records_touch() returns trigger as $$
begin new.synced_at = clock_timestamp(); return new; end $$ language plpgsql;
drop trigger if exists records_touch on records;
create trigger records_touch before insert or update on records
  for each row execute function records_touch();
alter table records enable row level security;
drop policy if exists "personal access" on records;
create policy "personal access" on records for all using (true) with check (true);`;

const Sync = {
  t: null, busy: false, state: 'off', msg: '',
  cfg() { return { url: (localStorage.getItem('sb_url') || '').trim().replace(/\/$/, ''), key: (localStorage.getItem('sb_key') || '').trim() }; },
  on() { const c = this.cfg(); return !!(c.url && c.key); },
  headers() { const { key } = this.cfg(); return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }; },
  set(state, msg = '') { this.state = state; this.msg = msg; const el = $('#sync-dot'); if (el) { el.dataset.state = state; el.title = msg || state; } },
  soon(ms = 4000) { if (!this.on()) return; clearTimeout(this.t); this.t = setTimeout(() => this.run(), ms); },

  async run() {
    if (!this.on()) { this.set('off'); return; }
    if (this.busy || !navigator.onLine) return;
    this.busy = true; this.set('syncing', 'Syncing…');
    try {
      await this.push();
      const got = await this.pull();
      localStorage.setItem('sb_last', Date.now());
      this.set('ok', 'Synced ' + new Date().toLocaleTimeString());
      if (got) App.softRefresh();
    } catch (e) {
      console.warn('sync', e); this.set('error', e.message);
    } finally { this.busy = false; }
  },

  async push() {
    const { url } = this.cfg();
    for (const s of SYNCED) {
      const dirty = await DB.byIndex(s, 'dirty', 1);
      if (!dirty.length) continue;
      const size = s === 'media' ? 6 : 250;
      for (let i = 0; i < dirty.length; i += size) {
        const chunk = dirty.slice(i, i + size);
        const rows = chunk.map(o => { const { _dirty, ...data } = o; return { id: s + ':' + o.id, store: s, data, updated: o.updated || 0, deleted: !!o.deleted }; });
        const r = await fetch(url + '/rest/v1/records', {
          method: 'POST', headers: { ...this.headers(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows)
        });
        if (!r.ok) throw new Error('Upload failed (' + r.status + '): ' + (await r.text()).slice(0, 160));
        for (const o of chunk) {
          const cur = await DB.get(s, o.id);
          if (cur && cur.updated === o.updated) { cur._dirty = 0; await DB.put(s, cur, { fromSync: true }); }
        }
      }
    }
  },

  async pull() {
    const { url } = this.cfg();
    let since = localStorage.getItem('sb_since') || '1970-01-01T00:00:00Z', got = 0;
    while (true) {
      const q = `${url}/rest/v1/records?select=store,data,updated,synced_at&synced_at=gt.${encodeURIComponent(since)}&store=in.(${SYNCED.join(',')})&order=synced_at.asc&limit=150`;
      const r = await fetch(q, { headers: this.headers() });
      if (!r.ok) throw new Error('Download failed (' + r.status + '): ' + (await r.text()).slice(0, 160));
      const rows = await r.json();
      for (const row of rows) {
        if (!SYNCED.includes(row.store) || !row.data?.id) continue;
        const local = await DB.get(row.store, row.data.id);
        if (local && local._dirty && (local.updated || 0) > (row.updated || 0)) continue;
        await DB.put(row.store, { ...row.data, _dirty: 0 }, { fromSync: true });
        got++;
      }
      if (rows.length) { since = rows[rows.length - 1].synced_at; localStorage.setItem('sb_since', since); }
      if (rows.length < 150) break;
    }
    return got;
  },

  async test() {
    const { url } = this.cfg();
    const r = await fetch(url + '/rest/v1/records?select=id&limit=1', { headers: this.headers() });
    if (!r.ok) throw new Error((await r.text()).slice(0, 200));
    return true;
  }
};
window.Sync = Sync;

// Phone ↔ laptop: the phone asks for a book page (or a "where to master this" search); the laptop,
// which has the books, answers through the same Supabase table within ~15 seconds.
const PageRelay = {
  busy: false,
  pid(b, p) { return `page:${b}:${p}`; },
  rid(b, p) { return `pagereq:${b}:${p}`; },
  async upsert(rows) {
    const { url } = Sync.cfg();
    const r = await fetch(url + '/rest/v1/records', { method: 'POST', headers: { ...Sync.headers(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows), signal: AbortSignal.timeout(15000) }).catch(() => { throw new Error('Could not reach your sync — check the internet, and the Sync address/key in Settings on this device.'); });
    if (!r.ok) throw new Error('Could not reach your sync (' + r.status + ')');
  },
  row(data) { return { id: 'media:' + data.id, store: 'media', data, updated: Date.now(), deleted: false }; },
  async getRecord(id) {
    const { url } = Sync.cfg();
    const r = await fetch(`${url}/rest/v1/records?select=data&id=eq.${encodeURIComponent(id)}`, { headers: Sync.headers(), signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return (await r.json())[0]?.data || null;
  },
  async askPage(bookId, p, book) { await this.upsert([this.row({ id: this.rid(bookId, p), kind: 'pagereq', bookId, p, book, status: 'pending', at: Date.now() })]); },
  sid(q) { let h = 0; for (const c of q.toLowerCase().trim()) h = (h * 31 + c.charCodeAt(0)) | 0; return 'q' + (h >>> 0).toString(36); },
  async askSearch(q) { const id = this.sid(q); await this.upsert([this.row({ id: 'searchreq:' + id, kind: 'searchreq', q, status: 'pending', at: Date.now() })]); return 'media:searchres:' + id; },
  async askMaster(mcqId, chosen) { await this.upsert([this.row({ id: 'masterreq:' + mcqId, kind: 'masterreq', mcqId, chosen, status: 'pending', at: Date.now() })]); },
  // Wait for an answer, checking every few seconds.
  async waitFor(id, test, ms = 90000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const d = await this.getRecord(id).catch(() => null); if (d && test(d)) return d; await sleep(4000); }
    return null;
  },
  // Runs on the laptop (the device that has the books).
  async serve() {
    if (!Sync.on() || !navigator.onLine) return;
    if (this.busy && Date.now() - (this.busyAt || 0) < 180000) return; // never stay stuck if one answer hung
    this.busyAt = Date.now();
    const books = await DB.all('books'); if (!books.some(b => ['ref', 'mbbs', 'amc'].includes(b.role))) return; // only the laptop (with the processed books) answers
    this.busy = true;
    try {
      const { url } = Sync.cfg();
      const r = await fetch(`${url}/rest/v1/records?select=data&store=eq.media&data->>status=eq.pending&order=updated.desc&limit=8`, { headers: Sync.headers(), signal: AbortSignal.timeout(15000) });
      if (!r.ok) return;
      for (const { data: q } of await r.json()) try {
        if (Date.now() - (q.at || 0) > 24 * 3600 * 1000) { await this.upsert([this.row({ ...q, status: 'expired' })]); continue; }
        if (q.kind === 'pagereq') {
          const book = books.find(b => b.id === q.bookId); const file = book && await DB.get('files', book.id);
          if (!file) { await this.upsert([this.row({ ...q, status: 'missing' })]); continue; }
          const c = await renderPage(book, q.p, 1500);
          const pg = await DB.get('pages', [book.id, q.p]);
          await this.upsert([
            this.row({ id: this.pid(book.id, q.p), kind: 'page', bookId: book.id, p: q.p, book: book.short || book.name, data: c.toDataURL('image/jpeg', 0.72), text: (pg?.text || '').slice(0, 20000) }),
            this.row({ ...q, status: 'done' })
          ]);
        } else if (q.kind === 'searchreq') {
          const results = await searchBooks(q.q, 6);
          await this.upsert([this.row({ id: 'searchres:' + this.sid(q.q), kind: 'searchres', q: q.q, results, at: Date.now() }), this.row({ ...q, status: 'done' })]);
        } else if (q.kind === 'masterreq') {
          const m = await DB.get('mcqs', q.mcqId); if (!m) { await this.upsert([this.row({ ...q, status: 'done' })]); continue; }
          if (!m.master?.read?.length) await masterQuestion(m, q.chosen);
          await Sync.run();
          await this.upsert([this.row({ ...q, status: 'done' })]);
        }
      } catch (e) { console.warn('page relay item', e); await this.upsert([this.row({ ...q, status: 'failed', err: String(e.message || e).slice(0, 200) })]).catch(() => {}); }
    } catch (e) { console.warn('page relay', e); } finally { this.busy = false; }
  }
};

// ---------- Book text for phone / iPad ----------
// The laptop uploads the text it read from every book (about 3 KB a page). Phones and iPads download it once,
// so "Ask books" answers straight away on that device — no PDFs to upload there, laptop can be off.
const BookText = {
  CH: 40,
  remote() { try { return JSON.parse(localStorage.getItem('remoteBooks') || '[]'); } catch (e) { return []; } },
  async ownBooks() { return (await DB.all('books')).filter(b => ['ref', 'mbbs', 'amc'].includes(b.role)); },
  async post(rows) {
    const { url } = Sync.cfg();
    const r = await fetch(url + '/rest/v1/records', { method: 'POST', headers: { ...Sync.headers(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('Book text upload failed (' + r.status + ')');
  },
  // Laptop side.
  async share() {
    if (!Sync.on() || !navigator.onLine || this.busy) return;
    const books = await this.ownBooks(); if (!books.length) return;
    this.busy = true; let sent = 0;
    try {
      const index = [];
      for (const b of books) {
        const pages = []; await DB.each('pages', 'bookId', b.id, pg => pages.push([pg.p, String(pg.text || '').slice(0, 7000)]));
        if (!pages.length) continue;
        pages.sort((x, y) => x[0] - y[0]);
        const chunks = Math.ceil(pages.length / this.CH), ver = pages.length + ':' + pages.reduce((n, x) => n + x[1].length, 0);
        index.push({ id: b.id, name: b.name, short: b.short, role: b.role, size: b.size, pages: pages.length, chunks, ver, system: b.system || null });
        if (localStorage.getItem('bt_' + b.id) === ver) continue;
        sent++;
        // One part at a time (≈150 KB), 3 tries each, and it remembers where it got to — weak Wi-Fi just resumes later.
        const doneKey = 'btk_' + b.id, prog = JSON.parse(localStorage.getItem(doneKey) || '{}');
        if (prog.ver !== ver) { prog.ver = ver; prog.k = 0; }
        for (let k = prog.k || 0; k < chunks; k++) {
          window._btMsg = `Sending book text to your phone/iPad: ${b.short || b.name} (${Math.round(k / chunks * 100)}%)`;
          const row = { id: `booktext:${b.id}:${k}`, store: 'booktext', data: { id: `${b.id}:${k}`, bookId: b.id, k, ver, pages: pages.slice(k * this.CH, (k + 1) * this.CH) }, updated: Date.now(), deleted: false };
          for (let t = 0; ; t++) { try { await this.post([row]); break; } catch (e) { if (t >= 2) throw e; await sleep(3000 * (t + 1)); } }
          prog.k = k + 1; localStorage.setItem(doneKey, JSON.stringify(prog));
        }
        localStorage.setItem('bt_' + b.id, ver);
      }
      // One list per device, so a phone with one book never overwrites the laptop's list.
      let dev = localStorage.getItem('devId'); if (!dev) { dev = uid(); localStorage.setItem('devId', dev); }
      await this.post([{ id: 'booktext:index:' + dev, store: 'booktext', data: { id: 'index:' + dev, books: index, at: Date.now() }, updated: Date.now(), deleted: false }]);
      localStorage.setItem('bt_sharedAt', Date.now()); localStorage.removeItem('bt_err');
      if (sent) toast(`✓ Book text sent to your phone/iPad (${index.length} books). On them: Ask books → download book text.`, 12000);
    } catch (e) { console.warn('book text share', e); localStorage.setItem('bt_err', e.message); toast('Couldn’t send book text to your phone/iPad: ' + e.message, 10000); } finally { this.busy = false; window._btMsg = ''; }
  },
  // Phone / iPad side (devices without the processed books).
  async fetch(onMsg = () => {}) {
    if (!Sync.on() || !navigator.onLine || this.busy) return 0;
    const own = await this.ownBooks();
    this.busy = true; let got = 0;
    try {
      const { url } = Sync.cfg(), H = { headers: Sync.headers(), signal: AbortSignal.timeout(30000) };
      const r = await fetch(`${url}/rest/v1/records?select=data&store=eq.booktext&id=like.booktext:index*`, H);
      if (!r.ok) return 0;
      const lists = (await r.json()).map(x => x.data).filter(d => d?.books?.length).sort((a, b) => (b.books.length - a.books.length) || (b.at - a.at));
      const seen = new Set(), idx = { books: [] };
      for (const l of lists) for (const b of l.books) if (!seen.has(b.id)) { seen.add(b.id); idx.books.push(b); }
      if (!idx.books.length) return 0;
      const have = this.remote();
      for (const b of idx.books) {
        if (own.some(o => o.id === b.id || (o.size && o.size === b.size))) continue;   // this device already has that book itself
        const old = have.find(x => x.id === b.id);
        if (old && old.ver === b.ver && old.complete) continue;
        for (let k = 0; k < b.chunks; k += 5) {
          onMsg(`Downloading your book text: ${b.short || b.name} (${Math.min(100, Math.round(k / b.chunks * 100))}%)`);
          const ids = []; for (let j = k; j < Math.min(b.chunks, k + 5); j++) ids.push(`booktext:${b.id}:${j}`);
          const q = await fetch(`${url}/rest/v1/records?select=data&id=in.(${ids.map(encodeURIComponent).join(',')})`, { headers: Sync.headers(), signal: AbortSignal.timeout(60000) });
          if (!q.ok) throw new Error('download ' + q.status);
          for (const { data } of await q.json()) { await DB.putMany('pages', (data.pages || []).map(([p, text]) => ({ bookId: b.id, p, text, remote: 1 }))); got += (data.pages || []).length; }
        }
        const list = this.remote().filter(x => x.id !== b.id); list.push({ ...b, complete: 1 });
        localStorage.setItem('remoteBooks', JSON.stringify(list));
      }
      onMsg('');
      if (got) toast(`✓ Downloaded your books’ text (${got.toLocaleString()} pages) — Ask books now answers on this device.`, 10000);
    } catch (e) { console.warn('book text fetch', e); } finally { this.busy = false; }
    return got;
  }
};
