// Class rosters: import the photo or PDF each department puts out, merge them into one day view,
// and get a reminder the night before.
//
// Rosters arrive one per subject, each covering a month, usually as a photo of a printed sheet
// rather than a text PDF. So this reads them with a vision model rather than parsing text, then
// always shows the result for correction — OCR on a photographed table is good, not perfect.

const Timetable = {
  NOTIFY_HOUR: 21, // 9pm the night before

  // ---------- storage ----------

  async all() { return (await DB.live('classes')).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)); },

  async forDate(iso) { return (await this.all()).filter(c => c.date === iso); },

  async upcoming(days = 14) {
    const today = this.iso(new Date());
    const end = this.iso(new Date(Date.now() + days * 864e5));
    return (await this.all()).filter(c => c.date >= today && c.date <= end);
  },

  async todays() { return this.forDate(this.iso(new Date())); },

  iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  },

  // ---------- import ----------

  /**
   * Read one roster image or PDF page into draft rows.
   * Returns rows for review — nothing is saved until the user accepts them.
   */
  async read(dataUrl, { subject = '' } = {}) {
    const prompt = `This is a class roster for medical students. Read the table and return every scheduled class.

Rules:
- "date": YYYY-MM-DD. The sheet may write dates as DD-MM-YYYY. If a year is missing, use the year in the sheet's title.
- "start"/"end": 24-hour "HH:MM". "9:00-10:00AM" means 09:00 to 10:00. "2:00-4:00PM" means 14:00 to 16:00.
- "topic": exactly what is written. If one row lists two topics (bullets, a slash, or a dash), join them with " / " and keep them as ONE class — they are taught in the same session.
- "faculty": exactly what is written, whether that is a person's name or a department.
- If a row has no topic, or the topic is an abbreviation you cannot expand, still return the row with "unclear": true and put whatever is written in "topic".
- Ignore header rows, notes, signatures and stamps.
- "subject": the subject or department this roster belongs to, from the sheet's title. Use "${subject}" if you cannot tell.

Return JSON: {"subject":"","rows":[{"date":"","start":"","end":"","topic":"","faculty":"","unclear":false}]}`;

    const p = Providers.active().find(x => x.vision && !x.ocrApi);
    const out = p
      ? await Providers.call(p, { prompt, images: [dataUrl], temperature: 0.1, maxTokens: 8000 })
      : await AI.call({ prompt, images: [dataUrl], temperature: 0.1, maxTokens: 8000 });

    const subj = (out.subject || subject || 'General').trim();
    return (out.rows || [])
      .map(r => this._clean(r, subj))
      .filter(Boolean);
  },

  _clean(r, subject) {
    const date = this._date(r.date);
    if (!date) return null;
    let start = this._time(r.start);
    let end = this._time(r.end) || this._plusHour(start);
    // "2:00-4:00PM" often comes back with the PM applied only to the end time, leaving a class that
    // either finishes before it starts or runs for half a day. Both mean the start lost its PM.
    if (start && end) {
      const mins = t => +t.slice(0, 2) * 60 + +t.slice(3);
      const amStart = +start.slice(0, 2) < 12;
      if (amStart && (end < start || mins(end) - mins(start) > 360)) {
        start = String(+start.slice(0, 2) + 12).padStart(2, '0') + start.slice(2);
      }
      if (end < start) end = this._plusHour(start);
    }
    return {
      id: 'cls-' + uid(),
      date, start: start || '09:00', end,
      topic: String(r.topic || '').replace(/\s+/g, ' ').trim() || '(not written)',
      faculty: String(r.faculty || '').replace(/\s+/g, ' ').trim(),
      subject,
      unclear: !!r.unclear || !r.topic,
      created: Date.now()
    };
  },

  _date(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return s;
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); // DD-MM-YYYY
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
  },

  _time(s) {
    s = String(s || '').trim().toUpperCase();
    const m = s.match(/^(\d{1,2})[:.]?(\d{2})?\s*(AM|PM)?$/);
    if (!m) return '';
    let h = +m[1];
    const min = m[2] || '00';
    if (m[3] === 'PM' && h < 12) h += 12;
    if (m[3] === 'AM' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + min;
  },

  _plusHour(t) {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return String((h + 1) % 24).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  },

  /**
   * Save reviewed rows. A re-issued roster for the same subject and month replaces the old one
   * rather than doubling it up — departments revise these constantly.
   */
  async commit(rows) {
    if (!rows.length) return 0;
    const subjects = [...new Set(rows.map(r => r.subject))];
    const months = [...new Set(rows.map(r => r.date.slice(0, 7)))];

    const old = (await this.all()).filter(c => subjects.includes(c.subject) && months.includes(c.date.slice(0, 7)));
    for (const c of old) { c.deleted = 1; await DB.put('classes', c); }

    await DB.putMany('classes', rows);
    await this.schedule();
    return rows.length;
  },

  async update(id, patch) {
    const c = await DB.get('classes', id);
    if (!c) return;
    Object.assign(c, patch);
    if (patch.topic) c.unclear = false;
    await DB.put('classes', c);
    await this.schedule();
  },

  async remove(id) {
    const c = await DB.get('classes', id);
    if (!c) return;
    c.deleted = 1;
    await DB.put('classes', c);
    await this.schedule();
  },

  // ---------- the night-before reminder ----------

  notifier() { return window.Capacitor?.Plugins?.LocalNotifications || null; },

  /**
   * Rebuild the reminder schedule from scratch whenever classes change.
   *
   * Only the next two weeks are scheduled: Android caps how many alarms an app may hold, and the
   * app re-schedules every time it opens anyway.
   */
  async schedule() {
    const n = this.notifier();
    if (!n) return;

    try {
      const perm = await n.checkPermissions();
      if (perm.display !== 'granted') {
        const asked = await n.requestPermissions();
        if (asked.display !== 'granted') return;
      }

      const pending = await n.getPending();
      const mine = (pending.notifications || []).filter(x => x.id >= 100000 && x.id < 200000);
      if (mine.length) await n.cancel({ notifications: mine.map(x => ({ id: x.id })) });

      const byDate = {};
      for (const c of await this.upcoming(14)) (byDate[c.date] ||= []).push(c);

      const out = [];
      for (const [date, list] of Object.entries(byDate)) {
        const [y, m, d] = date.split('-').map(Number);
        const at = new Date(y, m - 1, d - 1, this.NOTIFY_HOUR, 0, 0); // the evening before
        if (at.getTime() < Date.now() + 60000) continue;

        list.sort((a, b) => a.start.localeCompare(b.start));
        const body = list
          .map(c => `${this._pretty(c.start)} ${c.topic}${c.faculty ? ' — ' + c.faculty : ''}`)
          .join('\n');

        out.push({
          id: 100000 + Number(date.replace(/-/g, '').slice(2)), // yymmdd, stable across rebuilds
          title: list.length === 1 ? 'Tomorrow: 1 class' : `Tomorrow: ${list.length} classes`,
          body,
          largeBody: body,
          summaryText: list.map(c => c.subject).filter((v, i, a) => a.indexOf(v) === i).join(', '),
          schedule: { at, allowWhileIdle: true },
          extra: { date }
        });
      }

      if (out.length) await n.schedule({ notifications: out });
    } catch (e) {
      console.warn('could not schedule lecture reminders', e);
    }
  },

  _pretty(t) {
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am';
    const hh = h % 12 || 12;
    return m ? `${hh}:${String(m).padStart(2, '0')}${ap}` : `${hh}${ap}`;
  },

  /** The class happening right now, or the next one today — used to pre-fill the record screen. */
  async suggestNow() {
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const today = await this.todays();
    if (!today.length) return null;
    return today.find(c => c.start <= hhmm && c.end >= hhmm)
        || today.find(c => c.start >= hhmm)
        || null;
  },

  async init() { await this.schedule(); }
};
