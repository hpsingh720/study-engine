// Class rosters: import the photo or PDF each department puts out, merge them into one day view,
// and get a reminder the night before.
//
// Rosters arrive one per subject, each covering a month, usually as a photo of a printed sheet
// rather than a text PDF. So this reads them with a vision model rather than parsing text, then
// always shows the result for correction — OCR on a photographed table is good, not perfect.

const Timetable = {
  NOTIFY_HOUR: 21, // 9pm the night before

  // ---------- departments and groups ----------

  /**
   * The week is fixed by group, not by department.
   *
   * A slot on the weekly grid says "Medicine" and the department that actually turns up varies:
   * internal medicine one week, pulmonology the next, dermatology after that. The roster sheets name
   * the department, so a department has to be resolvable to the group whose slot it fills.
   *
   * Departments the course does not use simply never appear in a roster, so there is no harm in
   * listing more than one college teaches.
   */
  GROUPS: {
    Medicine: ['Internal Medicine', 'Pulmonology', 'Dermatology', 'Psychiatry', 'Radiology'],
    Surgery: ['General Surgery', 'ENT', 'Ophthalmology', 'Anaesthesia', 'Dentistry'],
    Paediatrics: ['Paediatrics'],
    'Obs & Gynae': ['Obstetrics & Gynaecology'],
    Orthopaedics: ['Orthopaedics'],
    'Community Medicine': ['Community Medicine'],
    Integrated: ['Integrated'],
    'Forensic Medicine': ['Forensic Medicine'],
    Preclinical: ['Anatomy', 'Physiology', 'Biochemistry'],
    Paraclinical: ['Pathology', 'Pharmacology', 'Microbiology']
  },

  /**
   * The week as it stands on the college timetable, offered as a starting point to correct.
   *
   * Times are a guess — the printed grid gives periods, not clock times — so these are meant to be
   * edited once and then left alone. The clinical posting is deliberately absent: it moves from
   * block to block and belongs on the roster, not in the fixed week.
   */
  DEFAULT_WEEK: [
    { day: 1, start: '09:00', end: '10:00', group: 'Paediatrics', label: 'Paedia' },
    { day: 1, start: '10:00', end: '11:00', group: 'Medicine', label: 'Med' },
    { day: 1, start: '11:00', end: '12:00', group: 'Obs & Gynae', label: 'Prac OBG' },
    { day: 2, start: '09:00', end: '10:00', group: 'Obs & Gynae', label: 'O & G' },
    { day: 2, start: '10:00', end: '11:00', group: 'Medicine', label: 'Med' },
    { day: 2, start: '11:00', end: '12:00', group: 'Paediatrics', label: 'Prac Pedia' },
    { day: 3, start: '09:00', end: '10:00', group: 'Surgery', label: 'Surgery' },
    { day: 3, start: '10:00', end: '11:00', group: 'Medicine', label: 'Prac Med' },
    { day: 3, start: '11:00', end: '12:00', group: 'Community Medicine', label: 'CFM' },
    { day: 4, start: '09:00', end: '10:00', group: 'Paediatrics', label: 'Paedia' },
    { day: 4, start: '10:00', end: '11:00', group: 'Medicine', label: 'Med' },
    { day: 4, start: '11:00', end: '12:00', group: 'Surgery', label: 'Prac Surg' },
    { day: 5, start: '09:00', end: '10:00', group: 'Surgery', label: 'Surgery' },
    { day: 5, start: '10:00', end: '11:00', group: 'Obs & Gynae', label: 'O & G' },
    { day: 5, start: '11:00', end: '12:00', group: 'Integrated', label: 'Integrated' },
    { day: 6, start: '09:00', end: '10:00', group: 'Orthopaedics', label: 'Ortho' },
    { day: 6, start: '10:00', end: '11:00', group: 'Surgery', label: 'Surgery' }
  ],

  /** What the sheets and filenames actually say. Keys are compared with punctuation and case stripped. */
  ALIASES: {
    med: 'Internal Medicine', medicine: 'Internal Medicine', genmed: 'Internal Medicine',
    generalmedicine: 'Internal Medicine', intmed: 'Internal Medicine', internalmedicine: 'Internal Medicine',
    im: 'Internal Medicine', gm: 'Internal Medicine',
    pulmo: 'Pulmonology', pulmonology: 'Pulmonology', chest: 'Pulmonology', resp: 'Pulmonology',
    respiratory: 'Pulmonology', tbchest: 'Pulmonology', pulmonarymedicine: 'Pulmonology',
    derma: 'Dermatology', derm: 'Dermatology', dermatology: 'Dermatology', skin: 'Dermatology',
    skinvd: 'Dermatology', dvl: 'Dermatology',
    psych: 'Psychiatry', psychiatry: 'Psychiatry',
    paeds: 'Paediatrics', peds: 'Paediatrics', paediatrics: 'Paediatrics', pediatrics: 'Paediatrics',
    paedia: 'Paediatrics', pedia: 'Paediatrics', paed: 'Paediatrics',
    radio: 'Radiology', radiology: 'Radiology', radiodiagnosis: 'Radiology',
    surg: 'General Surgery', surgery: 'General Surgery', gensurg: 'General Surgery',
    generalsurgery: 'General Surgery', gs: 'General Surgery',
    ent: 'ENT', oto: 'ENT', otorhinolaryngology: 'ENT', emt: 'ENT', // "emt" is how ENT comes off a photo
    ophtha: 'Ophthalmology', ophth: 'Ophthalmology', ophthal: 'Ophthalmology',
    ophthalmology: 'Ophthalmology', eye: 'Ophthalmology', opthal: 'Ophthalmology',
    opthalmology: 'Ophthalmology',
    ortho: 'Orthopaedics', orthopaedics: 'Orthopaedics', orthopedics: 'Orthopaedics',
    anaesthesia: 'Anaesthesia', anesthesia: 'Anaesthesia', anaes: 'Anaesthesia',
    dental: 'Dentistry', dentistry: 'Dentistry',
    obg: 'Obstetrics & Gynaecology', obgy: 'Obstetrics & Gynaecology', og: 'Obstetrics & Gynaecology',
    obgyn: 'Obstetrics & Gynaecology', obstetrics: 'Obstetrics & Gynaecology',
    gynae: 'Obstetrics & Gynaecology', gynaecology: 'Obstetrics & Gynaecology',
    obstetricsgynaecology: 'Obstetrics & Gynaecology',
    psm: 'Community Medicine', communitymedicine: 'Community Medicine', spm: 'Community Medicine',
    community: 'Community Medicine', cfm: 'Community Medicine',
    communityfamilymedicine: 'Community Medicine',
    integrated: 'Integrated', integratedteaching: 'Integrated', ait: 'Integrated',
    fmt: 'Forensic Medicine', forensic: 'Forensic Medicine', forensicmedicine: 'Forensic Medicine',
    anat: 'Anatomy', anatomy: 'Anatomy',
    physio: 'Physiology', physiology: 'Physiology',
    biochem: 'Biochemistry', biochemistry: 'Biochemistry',
    patho: 'Pathology', pathology: 'Pathology',
    pharma: 'Pharmacology', pharmac: 'Pharmacology', pharmacology: 'Pharmacology',
    micro: 'Microbiology', microbiology: 'Microbiology'
  },

  _key(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); },

  /** "Prac Med", "Practical OBG", "Tutorial Surgery" are all the department plus a teaching format. */
  _bare(s) { return this._key(s).replace(/^(practicals?|prac|tutorials?|tut|lectures?|lect|sgd|sdl)/, ''); },

  MONTHS: new Set(['jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
    'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october',
    'nov', 'november', 'dec', 'december']),

  /** Words that turn up in a roster filename and say nothing about the department. */
  NOISE: new Set(['roster', 'timetable', 'time', 'table', 'schedule', 'sheet', 'final', 'revised',
    'updated', 'new', 'copy', 'scan', 'img', 'doc', 'pdf', 'unit', 'batch', 'sem', 'semester',
    'year', 'mbbs', 'prof', 'professional', 'class', 'classes', 'lecture', 'lectures', 'prac',
    'practical', 'practicals', 'tutorial', 'tut', 'posting', 'ward', 'i', 'ii', 'iii', 'iv', 'v']),

  /** Anything the user has renamed or re-grouped by hand, layered over the defaults above. */
  async overrides() { return (await DB.meta('subjectMap')) || {}; },

  async setOverride(raw, department) {
    const m = await this.overrides();
    m[this._key(raw)] = department;
    await DB.meta('subjectMap', m);
  },

  /**
   * Resolve whatever a sheet or filename called it to one department and its group.
   *
   * Falls back to tidying the raw string rather than discarding it — an unrecognised department is
   * still a real class, it just sits outside the weekly grid until it gets mapped.
   */
  async resolve(raw) {
    const k = this._key(raw);
    if (!k) return { department: '', group: '' };

    const over = await this.overrides();
    const bare = this._bare(raw);
    let dept = over[k] || this.ALIASES[k] || over[bare] || this.ALIASES[bare] || '';

    if (!dept) {
      // Filenames carry a month and a unit as well as the department — "Med Nov", "Medicine Oct
      // 2026", "ophthalmology unit II". Read it word by word and take the first word that names a
      // department, ignoring the calendar.
      const words = String(raw).toLowerCase().split(/[^a-z]+/).filter(Boolean)
        .filter(w => !this.MONTHS.has(w) && !this.NOISE.has(w));
      for (const w of words) {
        const hit = over[w] || this.ALIASES[w] || over[this._bare(w)] || this.ALIASES[this._bare(w)];
        if (hit) { dept = hit; break; }
      }
    }

    if (!dept) {
      // Last try: a known name buried inside one long run of letters ("ophthalmologyunitII").
      for (const [alias, name] of Object.entries(this.ALIASES)) {
        if (alias.length >= 4 && k.includes(alias)) { dept = name; break; }
      }
    }
    if (!dept) dept = String(raw).replace(/\s+/g, ' ').trim();

    return { department: dept, group: this.groupOf(dept) };
  },

  groupOf(department) {
    for (const [group, list] of Object.entries(this.GROUPS)) {
      if (list.some(d => d.toLowerCase() === String(department).toLowerCase())) return group;
    }
    return '';
  },

  departments() { return Object.values(this.GROUPS).flat().sort(); },
  groups() { return Object.keys(this.GROUPS); },

  // ---------- storage ----------

  async all() { return (await DB.live('classes')).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)); },

  async forDate(iso) { return (await this.all()).filter(c => c.date === iso); },

  async upcoming(days = 14) {
    const today = this.iso(new Date());
    const end = this.iso(new Date(Date.now() + days * 864e5));
    return (await this.all()).filter(c => c.date >= today && c.date <= end);
  },

  async todays() { return this.dayView(this.iso(new Date())); },

  /** The roster rows for a date, with no weekly grid applied. */
  async rosterFor(iso) { return this.forDate(iso); },

  // ---------- the fixed weekly grid ----------

  DAYS: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],

  /** [{ day: 0-6, start: 'HH:MM', end: 'HH:MM', group: 'Medicine' }] — the part of the week that never changes. */
  async weekly() {
    const w = (await DB.meta('weekly')) || [];
    return w.slice().sort((a, b) => (a.day - b.day) || a.start.localeCompare(b.start));
  },

  async saveWeekly(slots) {
    const clean = (slots || [])
      .filter(s => s && s.group && /^\d{2}:\d{2}$/.test(s.start || ''))
      .map(s => ({
        day: Math.max(0, Math.min(6, +s.day || 0)),
        start: s.start,
        end: /^\d{2}:\d{2}$/.test(s.end || '') ? s.end : this._plusHour(s.start),
        group: s.group,
        // What the printed grid calls it ("Prac Med"), kept apart from the group it matches on.
        label: String(s.label || '').trim() || s.group
      }));
    await DB.meta('weekly', clean);
    await this.schedule();
    await this.pushToTile();
    return clean.length;
  },

  /**
   * Guess the fixed week from rosters already uploaded.
   *
   * A slot that shows up on the same weekday at the same time in two or more different weeks is
   * part of the timetable rather than a one-off, and whichever group taught it most often is the
   * group that owns it. Offered as a starting point to correct, never saved automatically.
   */
  async inferWeekly() {
    const tally = new Map();

    for (const c of await this.all()) {
      const group = c.group || this.groupOf(c.department || c.subject);
      if (!group) continue;
      const day = new Date(c.date + 'T00:00:00').getDay();
      const k = `${day}|${c.start}`;
      const t = tally.get(k) || { day, start: c.start, end: c.end, weeks: new Set(), groups: {} };
      t.weeks.add(c.date);
      t.groups[group] = (t.groups[group] || 0) + 1;
      if (c.end > t.end) t.end = c.end;
      tally.set(k, t);
    }

    return [...tally.values()]
      .filter(t => t.weeks.size >= 2)
      .map(t => {
        const group = Object.entries(t.groups).sort((a, b) => b[1] - a[1])[0][0];
        return { day: t.day, start: t.start, end: t.end, group, label: group };
      })
      .sort((a, b) => (a.day - b.day) || a.start.localeCompare(b.start));
  },

  /**
   * One day, as it should actually be read: the fixed week with this week's topics dropped in.
   *
   * A roster row fills a slot when it belongs to that slot's group — so an ophthalmology class
   * fills the Surgery slot and a pulmonology class fills the Medicine one, which is the whole point
   * of grouping. A row that matches no slot is still a real class and is appended as an extra; a
   * slot nothing filled still appears, named after its group, because "Surgery, topic not up yet"
   * is more use than an empty morning.
   */
  async dayView(iso) {
    const roster = await this.forDate(iso);
    const slots = (await this.weekly()).filter(s => s.day === new Date(iso + 'T00:00:00').getDay());
    if (!slots.length) return roster.map(c => ({ ...c, slot: false }));

    const spare = roster.slice();
    const out = [];

    const take = test => {
      const i = spare.findIndex(test);
      return i === -1 ? null : spare.splice(i, 1)[0];
    };
    const mins = t => +t.slice(0, 2) * 60 + +t.slice(3);

    for (const s of slots) {
      const near = c => Math.abs(mins(c.start) - mins(s.start)) <= 45;
      const inGroup = c => (c.group || this.groupOf(c.department || c.subject)) === s.group;

      // Same group and roughly the right time, then same group anywhere that day, then anything
      // sitting exactly in this slot — a mislabelled department should not leave the slot blank.
      const hit = take(c => inGroup(c) && near(c))
               || take(c => inGroup(c))
               || take(c => near(c) && !(c.group || this.groupOf(c.department || c.subject)));

      const label = s.label || s.group;
      out.push(hit
        ? { ...hit, start: s.start, end: s.end, group: s.group, label, slot: true }
        : {
            id: `slot-${iso}-${s.start.replace(':', '')}`,
            date: iso, start: s.start, end: s.end,
            topic: '', faculty: '', subject: label, department: '', group: s.group, label,
            slot: true, pending: true
          });
    }

    for (const c of spare) out.push({ ...c, slot: false, extra: true });
    return out.sort((a, b) => a.start.localeCompare(b.start));
  },

  /**
   * The next N days as merged day views, keyed by date.
   *
   * Not the same as filtering the roster: a day whose topics have not been published yet has no
   * roster rows at all but still has classes, and those are exactly the days worth reminding about.
   */
  async upcomingView(days = 14) {
    const out = {};
    const start = new Date(); start.setHours(0, 0, 0, 0);

    for (let i = 0; i <= days; i++) {
      const iso = this.iso(new Date(start.getTime() + i * 864e5));
      const list = await this.dayView(iso);
      if (list.length) out[iso] = list;
    }
    return out;
  },

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
    const resolved = await this.resolve(subj);
    return (out.rows || [])
      .map(r => this._clean(r, subj, resolved))
      .filter(Boolean);
  },

  _clean(r, subject, resolved) {
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
      // `subject` is whatever the sheet or filename said; `department` and `group` are the resolved
      // form, and they are what everything else matches on.
      subject: resolved?.department || subject,
      department: resolved?.department || subject,
      group: resolved?.group || '',
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

    // The subject cell is editable in the review table, so resolve again here rather than trusting
    // what the filename produced at read time.
    for (const r of rows) {
      const { department, group } = await this.resolve(r.subject || r.department);
      r.department = department; r.group = group; r.subject = department;
    }

    const depts = new Set(rows.map(r => this._key(r.department)));
    const months = new Set(rows.map(r => r.date.slice(0, 7)));

    // Matched on the resolved department, not the raw string: a sheet re-uploaded as "Med Oct.pdf"
    // after "Medicine Oct.pdf" used to miss this check entirely and leave two classes in the slot.
    const old = (await this.all()).filter(c =>
      depts.has(this._key(c.department || c.subject)) && months.has(c.date.slice(0, 7)));
    for (const c of old) { c.deleted = 1; await DB.put('classes', c); }

    await DB.putMany('classes', rows);
    await this.dedupe();
    await this.schedule();
    await this.pushToTile();
    return rows.length;
  },

  /**
   * Collapse classes that occupy the same slot.
   *
   * Two sheets can both claim 9–10 on the same morning — usually the same class printed on two
   * departments' sheets. Keep the one that was read most recently and has a real topic.
   */
  async dedupe() {
    const seen = new Map();
    const kill = [];

    for (const c of await this.all()) {
      const slot = `${c.date} ${c.start} ${this._key(c.department || c.subject)}`;
      const prev = seen.get(slot);
      if (!prev) { seen.set(slot, c); continue; }

      const score = x => (x.topic && x.topic !== '(not written)' ? 2 : 0) + (x.unclear ? 0 : 1);
      const loser = score(c) > score(prev) || (score(c) === score(prev) && (c.created || 0) > (prev.created || 0))
        ? prev : c;
      kill.push(loser);
      seen.set(slot, loser === prev ? c : prev);
    }

    for (const c of kill) { c.deleted = 1; await DB.put('classes', c); }
    return kill.length;
  },

  async update(id, patch) {
    const c = await DB.get('classes', id);
    if (!c) return;
    Object.assign(c, patch);
    if (patch.topic) c.unclear = false;
    await DB.put('classes', c);
    await this.schedule();
    await this.pushToTile();
  },

  async remove(id) {
    const c = await DB.get('classes', id);
    if (!c) return;
    c.deleted = 1;
    await DB.put('classes', c);
    await this.schedule();
    await this.pushToTile();
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

      const byDate = await this.upcomingView(14);

      const out = [];
      for (const [date, list] of Object.entries(byDate)) {
        const [y, m, d] = date.split('-').map(Number);
        const at = new Date(y, m - 1, d - 1, this.NOTIFY_HOUR, 0, 0); // the evening before
        if (at.getTime() < Date.now() + 60000) continue;

        list.sort((a, b) => a.start.localeCompare(b.start));
        const body = list
          .map(c => `${this._pretty(c.start)} ${c.topic || c.label || c.group || c.subject}${c.topic && c.faculty ? ' — ' + c.faculty : ''}${c.pending ? ' (topic not up yet)' : ''}`)
          .join('\n');

        out.push({
          id: 100000 + Number(date.replace(/-/g, '').slice(2)), // yymmdd, stable across rebuilds
          title: list.length === 1 ? 'Tomorrow: 1 class' : `Tomorrow: ${list.length} classes`,
          body,
          largeBody: body,
          summaryText: list.map(c => c.group || c.subject).filter((v, i, a) => a.indexOf(v) === i).join(', '),
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
    const today = await this.dayView(this.iso(now));
    if (!today.length) return null;
    return today.find(c => c.start <= hhmm && c.end >= hhmm)
        || today.find(c => c.start >= hhmm)
        || null;
  },

  /**
   * Copy the next fortnight's classes to the Android side.
   *
   * The Quick Settings tile starts a recording with no web page loaded, so it cannot reach
   * IndexedDB. This is how it knows to call the recording "Hypertension" rather than "Lecture 2pm".
   */
  async pushToTile() {
    const n = Lectures.native();
    if (!n?.setSchedule) return;
    try {
      // A slot whose topic has not been published yet still names the recording: "Surgery" beats
      // "Lecture 9am", and the topic can be corrected in the app afterwards.
      const classes = Object.values(await this.upcomingView(14)).flat()
        .map(c => ({ date: c.date, start: c.start, end: c.end, topic: c.topic || c.label || c.group || c.subject }))
        .filter(c => c.topic);
      await n.setSchedule({ classes });
    } catch (e) { console.warn('could not mirror the roster to the tile', e); }
  },

  async init() { await this.schedule(); await this.pushToTile(); }
};
