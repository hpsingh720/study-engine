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
      const q = `${url}/rest/v1/records?select=store,data,updated,synced_at&synced_at=gt.${encodeURIComponent(since)}&order=synced_at.asc&limit=150`;
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
