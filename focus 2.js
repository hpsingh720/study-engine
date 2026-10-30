// Studying something the syllabus does not name.
//
// The seeded syllabus is one line per textbook chapter — the whole of neonatology is
// "Neonatal care & neonatal jaundice". That is fine as a map of the course and useless as a place
// to put tonight's reading: there is no topic called "neonatal sepsis", so nothing ever writes
// questions on it and any question that does mention it has nowhere to be filed.
//
// This turns anything you are reading into a real topic — named, placed in a system, given the
// keywords the retrieval code needs — and then uses the generation that already exists.

const Focus = {

  /** Topics made this way, newest first. */
  async mine() {
    return (await DB.live('topics')).filter(t => t.custom).sort((a, b) => (b.created || 0) - (a.created || 0));
  },

  _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); },

  /** An existing topic for this, if there already is one — exact name first, then close enough. */
  async existing(name) {
    const want = this._norm(name);
    if (!want) return null;
    const all = await DB.live('topics');

    const exact = all.find(t => this._norm(t.name) === want);
    if (exact) return exact;

    // "neonatal sepsis" should find a topic called "Neonatal sepsis in the newborn", but must not
    // match "Neonatal care & neonatal jaundice" — one shared word is not the same subject.
    const words = want.split(' ').filter(w => w.length > 3);
    if (words.length < 2) return null;
    return all.find(t => {
      const n = this._norm(t.name);
      return words.every(w => n.includes(w));
    }) || null;
  },

  /**
   * Work out where a topic belongs and what to search the books for.
   *
   * Asked of the AI rather than guessed from keywords, because the seeded keyword lists are exactly
   * what does not contain the subject being asked about.
   */
  async classify(raw) {
    const systems = SEED.systems.map(s => `${s.code} = ${s.name}`).join('\n');
    const out = await fastAI({
      json: true,
      system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined,
      prompt: `A medical student is studying "${raw}" for MBBS finals in India.

Return JSON describing it as a syllabus topic:
{"name":"","system":"","kw":[],"parent":"","ok":true}

- "name": the proper topic name, capitalised normally (e.g. "neonatal sepsis" -> "Neonatal sepsis"). Keep it to the subject asked for — do NOT widen it to the whole chapter.
- "system": exactly one code from this list:
${systems}
- "kw": 8-14 lowercase search terms that would appear on the textbook pages about this — synonyms, the classic signs, drug names, scores, organisms, eponyms. These are used to find the right pages in the student's own books, so prefer words a textbook prints over words a student says.
- "parent": the broader chapter it sits inside (e.g. "Newborn care"), or "" if it is already a whole chapter.
- "ok": false if this is not a medical topic at all.

Return only the JSON.`
    });

    if (!out || out.ok === false) throw new Error(`"${raw}" does not look like a medical topic`);

    const name = String(out.name || raw).trim().slice(0, 80);
    const kw = [...new Set([
      ...(Array.isArray(out.kw) ? out.kw : []).map(k => String(k).toLowerCase().trim()).filter(k => k.length > 2),
      this._norm(name)
    ])].slice(0, 16);

    let system = this.systemCode(out.system, name);
    // Nothing in the name or the code says where this lives — ask the nearest existing topic,
    // which is how "Glaucoma" finds Eye & ENT without anyone having to spell it out.
    if (!system && typeof matchTopic === 'function') {
      try { system = (await matchTopic(`${name} ${kw.join(' ')}`))?.system || ''; } catch (e) {}
    }

    return { name, system, kw, parent: String(out.parent || '').trim().slice(0, 80) };
  },

  /**
   * Turn whatever came back into a real system code.
   *
   * A near miss — "OBG" for OBS, "Paeds" for PAEDS — used to fall through to the first system in
   * the list, so an obstetrics lecture was quietly filed under Cardiology. Try the code, then the
   * system's name, then the nearest existing topic; only then give up and leave it unset.
   */
  /** What a roster, a lecturer or a model is likely to write instead of the code. */
  SYS_ALIASES: {
    obg: 'OBS', obgy: 'OBS', obgyn: 'OBS', og: 'OBS', obstetrics: 'OBS', midwifery: 'OBS',
    gynae: 'GYN', gyn: 'GYN', gynaecology: 'GYN', gynecology: 'GYN',
    ophtha: 'EYEENT', ophth: 'EYEENT', ophthal: 'EYEENT', ophthalmology: 'EYEENT',
    opthalmology: 'EYEENT', eye: 'EYEENT', ent: 'EYEENT', oto: 'EYEENT',
    otorhinolaryngology: 'EYEENT', eyeent: 'EYEENT',
    peds: 'PAEDS', paeds: 'PAEDS', paedia: 'PAEDS', pedia: 'PAEDS', neonatology: 'PAEDS',
    medicine: 'GIT', generalmedicine: 'GIT', // only as a last resort; usually overridden by name
    cardio: 'CVS', cardiology: 'CVS',
    resp: 'RESP', pulmo: 'RESP', pulmonology: 'RESP', chest: 'RESP', respiratory: 'RESP',
    gastro: 'GIT', gastroenterology: 'GIT', hepatology: 'GIT',
    nephro: 'RENAL', nephrology: 'RENAL', uro: 'RENAL', urology: 'RENAL',
    endocrine: 'ENDO', endocrinology: 'ENDO', diabetes: 'ENDO',
    neuro: 'NEURO', neurology: 'NEURO',
    haem: 'HAEM', hematology: 'HAEM', haematology: 'HAEM', onco: 'HAEM', oncology: 'HAEM',
    micro: 'ID', microbiology: 'ID', infectious: 'ID',
    rheum: 'MSK', rheumatology: 'MSK', msk: 'MSK',
    skin: 'DERM', derma: 'DERM', dermatology: 'DERM', dvl: 'DERM',
    surg: 'SURG', surgery: 'SURG', generalsurgery: 'SURG',
    ortho: 'ORTHO', orthopaedics: 'ORTHO', orthopedics: 'ORTHO',
    psych: 'PSYCH', psychiatry: 'PSYCH',
    emergency: 'EMERG', toxicology: 'EMERG', casualty: 'EMERG',
    psm: 'ETHICS', spm: 'ETHICS', cfm: 'ETHICS', communitymedicine: 'ETHICS', forensic: 'ETHICS'
  },

  systemCode(raw, name = '') {
    const want = this._norm(raw).replace(/\s+/g, '');
    if (!want) return this._byName(name);

    const exact = SEED.systems.find(s => this._norm(s.code) === want);
    if (exact) return exact.code;

    const alias = this.SYS_ALIASES[want];
    if (alias && SEED.systems.some(s => s.code === alias)) return alias;

    const named = SEED.systems.find(s => {
      const n = this._norm(s.name);
      return n === want || n.includes(want) || want.includes(this._norm(s.code));
    });
    if (named) return named.code;

    return this._byName(name);
  },

  _byName(name) {
    const k = this._norm(name);
    if (!k) return '';
    const hit = SEED.systems.find(s => k.includes(this._norm(s.name)) || this._norm(s.name).includes(k));
    if (hit) return hit.code;
    // "Retinal detachment" says nothing about a system name, but a word in it may be a known alias.
    for (const w of k.split(' ')) {
      const a = this.SYS_ALIASES[w];
      if (a && SEED.systems.some(s => s.code === a)) return a;
    }
    return '';
  },

  /**
   * Make a topic for what is being read, and put it at the front of the queue.
   *
   * Questions and the revision sheet both come from the generation that already exists, so they are
   * grounded in the student's own books and land in normal systems revision rather than a silo.
   */
  async study(raw, { amc = 5, mbbs = 10 } = {}) {
    const name = String(raw || '').trim();
    if (name.length < 3) throw new Error('Type a bit more than that');

    const already = await this.existing(name);
    if (already) {
      const have = (await DB.byIndex('mcqs', 'topicId', already.id)).filter(m => !m.deleted).length;
      // Already a topic: top it up rather than making a second one with almost the same name.
      // amc + mbbs of zero means the caller only wants the topic — a lecture placing its questions.
      if (amc + mbbs > 0) await Queue.add('mcqgen', { topicId: already.id, amc, mbbs }, 0);
      return { topic: already, made: false, have };
    }

    const c = await this.classify(name);

    const t = {
      id: 'f-' + slugify(c.name) + '-' + uid().slice(0, 4),
      system: c.system,
      name: c.name,
      kw: c.kw,
      order: 999,
      done: 0, doneAt: null,
      custom: 1,
      parentName: c.parent,
      created: Date.now()
    };
    await DB.put('topics', t);

    // The sheet goes first: mcqgen uses it as the factual basis when it exists, and pulls book
    // excerpts itself when it does not, so either order works — this one just reads better.
    await Queue.add('sheet', { topicId: t.id }, 0.3);
    if (amc + mbbs > 0) await Queue.add('mcqgen', { topicId: t.id, amc, mbbs }, 0.4);

    return { topic: t, made: true, have: 0 };
  },

  /**
   * Break a chapter-sized topic into the subjects it actually contains.
   *
   * One topic per chapter is what leaves a whole subject with four questions. This asks what a
   * student would sit down and read in one evening, and makes each of those a topic of its own.
   */
  async expand(topicId) {
    const t = await DB.get('topics', topicId);
    if (!t) throw new Error('Topic not found');

    const siblings = (await DB.live('topics'))
      .filter(x => x.system === t.system && x.id !== t.id)
      .map(x => x.name);

    const out = await fastAI({
      json: true,
      system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined,
      prompt: `An MBBS student in India has one syllabus topic called "${t.name}". It is too broad — it covers a whole textbook chapter, so the app only ever writes a handful of questions across the entire subject.

Break it into the subjects a student would actually sit down and read in one evening, and that an examiner would set a question on. 5-10 of them.

Already exist as separate topics, so do NOT repeat these:
${siblings.slice(0, 120).join('\n') || '(none)'}

For each, return the proper topic name and 8-14 lowercase textbook search terms:
{"subtopics":[{"name":"","kw":[]}]}

Rules:
- Each must be examinable on its own: a disease, a syndrome, a procedure, an emergency, a well-defined management problem.
- Use the names Indian MBBS textbooks use.
- No overlaps between them, and nothing so narrow it supports fewer than ten questions.
- Return only the JSON.`
    });

    const list = Array.isArray(out?.subtopics) ? out.subtopics : [];
    const have = new Set((await DB.live('topics')).map(x => this._norm(x.name)));
    const made = [];

    for (const s of list) {
      const name = String(s?.name || '').trim().slice(0, 80);
      if (!name || have.has(this._norm(name))) continue;
      have.add(this._norm(name));

      const kw = [...new Set([
        ...(Array.isArray(s.kw) ? s.kw : []).map(k => String(k).toLowerCase().trim()).filter(k => k.length > 2),
        this._norm(name)
      ])].slice(0, 16);

      const sub = {
        id: 'f-' + slugify(name) + '-' + uid().slice(0, 4),
        system: t.system, name, kw,
        order: (t.order || 0) + 0.001 * (made.length + 1),
        done: 0, doneAt: null,
        custom: 1, parentName: t.name, created: Date.now()
      };
      await DB.put('topics', sub);
      made.push(sub);
    }

    // Queued behind anything already running: this is a background fill, not tonight's reading.
    for (const sub of made) {
      await Queue.add('sheet', { topicId: sub.id }, 2.5);
      await Queue.add('mcqgen', { topicId: sub.id, amc: 4, mbbs: 8 }, 2.6);
    }

    return made;
  },

  // ---------- building a subject the way the textbook does ----------

  /**
   * The chapters of a subject, and what sits inside each one.
   *
   * The seeded syllabus for Eye & ENT is nine presentations — "red eye", "sudden visual loss" —
   * which is an AMC symptom list, not a syllabus. There is no retina chapter, no cornea, no uvea,
   * no laryngology. Studying half of laryngology and asking for questions on it has nowhere to go.
   *
   * So the tree is built the way the standard book does it: chapters, then the subjects inside
   * each. Named after the student's own book when they have one, because that is the order they
   * will read in and the names the examiner will use.
   */
  /**
   * Books this device can build from.
   *
   * Two kinds. The ones read in here, and the ones a laptop read whose text has since been
   * downloaded — those keep their pages in the database but their record in a separate list, so
   * looking only at the books table makes an iPad full of book text report that it has no books.
   */
  async books() {
    const own = (await DB.all('books')).filter(b => ['ref', 'mbbs'].includes(b.role));
    const seen = new Set(own.map(b => b.id));
    const shared = (typeof BookText !== 'undefined' ? BookText.remote() : [])
      .filter(b => b.complete && !seen.has(b.id))
      .map(b => ({ ...b, fromLaptop: 1 }));
    return [...own, ...shared];
  },

  /** A book record whether it was read in here or downloaded from another device. */
  async book(id) {
    return (await DB.get('books', id))
      || (typeof BookText !== 'undefined' ? BookText.remote().find(b => b.id === id) : null)
      || null;
  },

  async _pageText(bookId, from, to, cap = 30000) {
    const out = [];
    let chars = 0;
    for (let p = from; p <= to; p++) {
      const pg = await DB.get('pages', [bookId, p]);
      if (!pg?.text) continue;
      const t = pg.text.slice(0, 4000);
      out.push(`[p.${p}]\n${t}`);
      chars += t.length;
      if (chars > cap) break;
    }
    return out.join('\n\n');
  },

  /**
   * The headings across a whole chapter, rather than the opening few pages of it.
   *
   * Reading full page text runs out of budget after about six pages, so a forty-page chapter came
   * back as whatever its first section happened to be — a newborn chapter that reduced to
   * "preparing for resuscitation, supplemental oxygen, chest compressions" and stopped. Headings
   * are short lines in caps or title case, so pulling just those covers the entire chapter in a
   * fraction of the space.
   */
  async _headings(bookId, from, to, cap = 26000) {
    const looksLikeHeading = l => {
      const s = l.trim();
      if (s.length < 4 || s.length > 70) return false;
      if (/[.;:,]$/.test(s)) return false;
      if (/^(fig|figure|table|box|plate|note|source|contd|continued)\b/i.test(s)) return false;
      const letters = s.replace(/[^A-Za-z]/g, '');
      if (letters.length < 4) return false;
      const caps = s === s.toUpperCase();
      const titled = /^([A-Z][a-z'-]+|and|of|the|in|with|for|to|a)(\s+([A-Z][a-z'-]+|and|of|the|in|with|for|to|a|\d+))*$/.test(s);
      const numbered = /^\d+(\.\d+)*\s+[A-Z]/.test(s);
      return caps || titled || numbered;
    };

    const out = [];
    let chars = 0;
    for (let p = from; p <= to; p++) {
      const pg = await DB.get('pages', [bookId, p]);
      if (!pg?.text) continue;
      const heads = pg.text.split('\n').filter(looksLikeHeading).slice(0, 14);
      // The opening of the page as well, so a heading the filter missed still has context.
      const piece = `[p.${p}] ${pg.text.trim().slice(0, 220).replace(/\s+/g, ' ')}`
        + (heads.length ? `\n  ${heads.map(h => h.trim()).join('\n  ')}` : '');
      out.push(piece);
      chars += piece.length;
      if (chars > cap) break;
    }
    return out.join('\n');
  },

  /**
   * Build the syllabus out of the student's own textbook.
   *
   * Not the model's idea of what a textbook contains — the book sitting in the app, read from its
   * own contents pages and its own printed headings. That is the order they will read in, the
   * names the examiner will use, and the only list that matches what they actually own.
   *
   * AMC follows from this rather than leading it: once a topic exists, generation writes both
   * AMC-style and MBBS-style questions for it.
   */
  async fromBook(bookId, { onProgress } = {}) {
    const book = await this.book(bookId);
    if (!book) throw new Error('Book not found');

    const pages = [];
    await DB.each('pages', 'bookId', bookId, pg => { if (pg.text) pages.push(pg.p); });
    if (pages.length < 10) throw new Error(`"${book.short || book.name}" has not been read into the app yet — wait for it to finish, then try again`);
    pages.sort((a, b) => a - b);
    const lastPage = pages[pages.length - 1];

    onProgress?.('Reading the contents pages…', 0);

    // The contents is almost always in the opening pages; take a generous slice of them.
    const front = await this._pageText(bookId, pages[0], pages[Math.min(34, pages.length - 1)], 36000);

    const toc = await fastAI({
      json: true,
      system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined,
      prompt: `Below are the opening pages of "${book.name}", scanned and read by OCR. Somewhere in them is the table of contents.

Copy it out exactly as this book prints it, chapters and everything listed under them:
{"chapters":[{"name":"","page":0,"topics":[{"name":"","page":0}]}]}

- "name": the title as printed. Do not rename, merge, shorten or invent anything.
- "page": the page number the contents gives, as a number. Use 0 where there is none.
- "topics": the entries listed underneath that chapter in the contents, in the book's order. Many Indian textbooks print these; copy every one. If this book's contents lists chapters only, return "topics": [] for them — do not make entries up.
- Keep the book's own order and include every chapter, to the end of the book.
- If there is no contents page in this text at all, return {"chapters":[]} rather than guessing.

PAGES:
${front}`
    });

    let chapters = (Array.isArray(toc?.chapters) ? toc.chapters : [])
      .map(c => ({
        name: String(c?.name || '').trim().slice(0, 90),
        page: +c?.page || 0,
        topics: (Array.isArray(c?.topics) ? c.topics : [])
          .map(s => ({ name: String(s?.name || '').trim().slice(0, 80), page: +s?.page || 0 }))
          .filter(s => s.name.length > 2)
      }))
      .filter(c => c.name.length > 2);

    if (!chapters.length) throw new Error(`Could not find a contents page in "${book.short || book.name}". Scan the contents pages in, or use "Break it into subtopics" on a topic instead.`);

    // The printed page numbers and the scan's page numbers rarely line up (front matter, covers).
    // Work out the offset from the first chapter that can be found in the scan by its own title.
    const needles = chapters.map(c => this._norm(c.name).slice(0, 28)).filter(n => n.length >= 8);
    let offset = 0, found = false;

    for (const c of chapters.slice(0, 6)) {
      if (!c.page) continue;
      const needle = this._norm(c.name).slice(0, 28);
      if (needle.length < 8) continue;

      for (const p of pages) {
        const pg = await DB.get('pages', [bookId, p]);
        if (!pg?.text) continue;
        const head = this._norm(pg.text.slice(0, 900));
        if (!head.includes(needle)) continue;
        // The contents page names every chapter, so it matches first and gives a nonsense offset.
        // A real chapter opening names its own chapter and almost none of the others.
        if (needles.filter(n => head.includes(n)).length > 1) continue;
        offset = p - c.page; found = true; break;
      }
      if (found) break;
    }

    const have = new Set((await DB.live('topics')).map(t => this._norm(t.name)));
    const made = [];
    let order = 0;

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      onProgress?.(ch.name, made.length);

      // The chapter's own pages, so the subtopics are the headings this book actually prints.
      // The contents already lists what is in the chapter. Reading the chapter to rediscover it
      // costs a call each and loses whatever the OCR mangled, so it is only a fallback for a book
      // whose contents gives chapter titles alone.
      if (ch.topics.length) {
        for (const s of ch.topics) {
          if (have.has(this._norm(s.name))) continue;
          have.add(this._norm(s.name));
          made.push(this._topic({
            name: s.name, chapter: ch.name, bookId,
            bookPage: s.page || ch.page || 0,
            system: book.system || '', order: 1000 + (order += 1)
          }));
        }
        continue;
      }

      let body = '';
      if (ch.page) {
        const from = Math.max(pages[0], ch.page + offset);
        const nextPage = chapters[i + 1]?.page;
        const to = Math.min(lastPage, nextPage ? nextPage + offset - 1 : from + 40);
        // The whole chapter, headings only — not the first six pages in full.
        if (to >= from) body = await this._headings(bookId, from, to);
      }

      let subs;
      try {
        subs = await fastAI({
          json: true,
          system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined,
          prompt: body
            ? `Below are the printed headings across the whole chapter "${ch.name}" of "${book.name}", page by page (OCR, so expect errors and some lines that are not really headings).

List the subjects this chapter teaches, across ALL of it — first page to last.

{"topics":[{"name":"","kw":[]}]}

- One entry per subject a student would read and revise on its own and an examiner would set a question on. A newborn chapter gives birth asphyxia, neonatal resuscitation, neonatal jaundice, neonatal sepsis, respiratory distress syndrome, necrotising enterocolitis, low birth weight and prematurity, neonatal hypoglycaemia, neonatal seizures, breastfeeding and so on — NOT "preparing for resuscitation" and "supplemental oxygen", which are steps inside one of them.
- Work at the level of a disease or a whole management problem. Roll small procedural headings up into the subject they belong to.
- Cover the late pages as well as the early ones. A chapter this long has many subjects, not three.
- Use the book's own wording where it names a subject. Do not invent what the pages do not cover.
- Skip anatomy revision, introductions, history and further reading.
- "kw": 8-14 lowercase terms printed on those pages — signs, drugs, organisms, classifications, eponyms.
- Return only the JSON.

HEADINGS BY PAGE:
${body}`
            : `"${ch.name}" is a chapter of "${book.name}", an Indian MBBS textbook. Its pages could not be located in the scan.

List the subjects this chapter teaches, as that book teaches them:
{"topics":[{"name":"","kw":[]}]}
Same rules: one entry per separately examinable subject, textbook wording, 8-14 lowercase search terms each. Return only the JSON.`
        });
      } catch (e) {
        console.warn('chapter failed', ch.name, e);
        continue;
      }

      for (const s of (Array.isArray(subs?.topics) ? subs.topics : [])) {
        const name = String(s?.name || '').trim().slice(0, 80);
        if (!name || have.has(this._norm(name))) continue;
        have.add(this._norm(name));

        const kw = [...new Set([
          ...(Array.isArray(s.kw) ? s.kw : []).map(k => String(k).toLowerCase().trim()).filter(k => k.length > 2),
          this._norm(name)
        ])].slice(0, 16);

        made.push(this._topic({
          name, kw, chapter: ch.name, bookId, bookPage: ch.page || 0,
          system: book.system || '', order: 1000 + (order += 1)
        }));
      }

      await sleep(900); // the free keys rate-limit well before the chapters run out
    }

    if (made.length) {
      await DB.putMany('topics', made);
      // Topics taken straight from the contents have only their own name to search the books with.
      // Fill in the textbook terms afterwards, in batches, so the tree appears immediately.
      this.enrich(made.filter(t => t.kw.length < 3).map(t => t.id), onProgress).catch(e => console.warn('keywords', e));
    }
    return { book, chapters: chapters.length, made };
  },

  _topic({ name, kw, chapter, bookId, bookPage, system, order }) {
    return {
      id: 'f-' + slugify(name) + '-' + uid().slice(0, 4),
      system: system || '', name,
      kw: kw && kw.length ? kw : [this._norm(name)],
      chapter, bookId, bookPage: bookPage || 0,
      order, done: 0, doneAt: null,
      custom: 1, parentName: chapter, created: Date.now()
    };
  },

  /**
   * Give contents-derived topics the search terms retrieval needs.
   *
   * A name on its own finds the page that prints that exact phrase and little else, so questions
   * come out thin. Done in batches after the tree is saved, because the tree is what the student
   * is waiting to see.
   */
  async enrich(ids, onProgress) {
    for (let i = 0; i < ids.length; i += 25) {
      const batch = [];
      for (const id of ids.slice(i, i + 25)) {
        const t = await DB.get('topics', id);
        if (t) batch.push(t);
      }
      if (!batch.length) continue;
      onProgress?.(`Adding search terms (${Math.min(i + 25, ids.length)} of ${ids.length})`, 0);

      let out;
      try {
        out = await fastAI({
          json: true,
          prompt: `For each MBBS topic below, give 8-14 lowercase terms that would be printed on the textbook pages about it — synonyms, classic signs, drug names, organisms, scores, classifications, eponyms.

{"terms":{"<topic name>":["",""]}}

Topics:
${batch.map(t => '- ' + t.name).join('\n')}

Return only the JSON.`
        });
      } catch (e) { continue; }

      const map = out?.terms || {};
      for (const t of batch) {
        const got = map[t.name] || map[t.name.toLowerCase()];
        if (!Array.isArray(got) || !got.length) continue;
        t.kw = [...new Set([...got.map(k => String(k).toLowerCase().trim()).filter(k => k.length > 2), this._norm(t.name)])].slice(0, 16);
        await DB.put('topics', t);
      }
      await sleep(900);
    }
  },

  /** Put a book's topics into a system, once the student says which subject it is. */
  async assignSystem(bookId, code) {
    const ts = (await DB.live('topics')).filter(t => t.bookId === bookId);
    for (const t of ts) { t.system = code; await DB.put('topics', t); }
    // A book downloaded from the laptop has no row here to stamp; the topics carry it instead.
    const b = await DB.get('books', bookId);
    if (b) { b.system = code; await DB.put('books', b); }
    return ts.length;
  },

  /**
   * Write questions for the topics marked as read, and only those.
   *
   * Half of laryngology read means questions on that half. Generating for the rest of the chapter
   * produces a test full of things not yet opened, which is the opposite of useful.
   */
  async fillRead(code, { max = 25 } = {}) {
    const topics = (await DB.live('topics')).filter(t => t.done && (!code || t.system === code));
    if (!topics.length) return 0;

    const counts = {};
    for (const m of await DB.live('mcqs')) if (m.topicId && !m.flagged) counts[m.topicId] = (counts[m.topicId] || 0) + 1;

    const queued = new Set((await DB.live('queue'))
      .filter(j => j.kind === 'mcqgen' && j.status !== 'done')
      .map(j => j.payload?.topicId));

    const need = topics
      .filter(t => (counts[t.id] || 0) < 15 && !queued.has(t.id))
      .sort((a, b) => (counts[a.id] || 0) - (counts[b.id] || 0))
      .slice(0, max);

    for (const t of need) {
      if (!(await DB.get('sheets', t.id))) await Queue.add('sheet', { topicId: t.id }, 1.2);
      await Queue.add('mcqgen', { topicId: t.id, amc: 4, mbbs: 9 }, 1.3);
    }
    return need.length;
  },

  /** Mark a whole chapter read or unread in one go. */
  async markChapter(code, chapter, read) {
    const ts = (await DB.live('topics')).filter(t => t.system === code && (t.chapter || t.parentName) === chapter);
    for (const t of ts) {
      t.done = read ? 1 : 0;
      t.doneAt = read ? (t.doneAt || Date.now()) : null;
      await DB.put('topics', t);
    }
    return ts.length;
  },

  /**
   * Everything being written right now, across every topic.
   *
   * Pressing "make me questions" queues work that then happens out of sight — there was no one
   * place to see it, so it looked like nothing had happened. This is that place.
   */
  async inFlight() {
    const jobs = (await DB.live('queue')).filter(j =>
      ['sheet', 'mcqgen', 'lectureMcqs'].includes(j.kind) && j.status !== 'done');
    if (!jobs.length) return [];

    const topics = {};
    for (const t of await DB.live('topics')) topics[t.id] = t;

    const counts = {};
    for (const m of await DB.live('mcqs')) if (m.topicId && !m.flagged) counts[m.topicId] = (counts[m.topicId] || 0) + 1;

    const rank = { running: 0, pending: 1, failed: 2 };
    return jobs.map(j => {
      const t = topics[j.payload?.topicId];
      return {
        id: j.id,
        topicId: j.payload?.topicId || '',
        name: t?.name || (j.kind === 'lectureMcqs' ? 'A lecture' : 'A topic'),
        chapter: t?.chapter || t?.parentName || '',
        what: j.kind === 'sheet' ? 'Mind map & notes' : 'Questions',
        status: j.status || 'pending',
        error: j.error || '',
        have: counts[j.payload?.topicId] || 0
      };
    }).sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.name.localeCompare(b.name));
  },

  /** Just the mind map and notes, now — for a topic about to be read rather than revised. */
  async mindmapFirst(topicId) {
    await Queue.add('sheet', { topicId }, 0);
    return true;
  },

  // ---------- the syllabus as a whole ----------

  /**
   * Topics that are carrying more of the course than one topic can.
   *
   * The seeded syllabus is one line per chapter across every subject, so this is not a neonatology
   * problem — ENT, ophthalmology, orthopaedics and the rest are all one or two lines each. A topic
   * with very few questions is either untouched or too broad to generate against, and both are
   * fixed the same way: break it up and let generation run per subject.
   */
  async thin(max = 12) {
    const topics = await DB.live('topics');
    const counts = {};
    for (const m of await DB.live('mcqs')) {
      if (!m.flagged && m.topicId) counts[m.topicId] = (counts[m.topicId] || 0) + 1;
    }
    return topics
      .filter(t => !t.custom && (counts[t.id] || 0) < max)
      .map(t => ({ ...t, have: counts[t.id] || 0 }))
      .sort((a, b) => a.have - b.have || a.system.localeCompare(b.system));
  },

  /** Per system, how much of it rests on how few topics. */
  async depth() {
    const topics = await DB.live('topics');
    const counts = {};
    for (const m of await DB.live('mcqs')) {
      if (!m.flagged && m.topicId) counts[m.topicId] = (counts[m.topicId] || 0) + 1;
    }
    return SEED.systems.map(s => {
      const ts = topics.filter(t => t.system === s.code);
      const qs = ts.reduce((a, t) => a + (counts[t.id] || 0), 0);
      return {
        code: s.code, name: s.name,
        topics: ts.length,
        custom: ts.filter(t => t.custom).length,
        questions: qs,
        thin: ts.filter(t => !t.custom && (counts[t.id] || 0) < 12).length
      };
    }).sort((a, b) => b.thin - a.thin);
  },

  /**
   * Break up several broad topics in one go.
   *
   * Done one at a time with a pause between, because each is a separate AI call and firing twenty
   * at once gets the free keys rate-limited — which would fail the whole run rather than slow it.
   */
  async expandMany(ids, onProgress) {
    let made = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
      onProgress?.(i + 1, ids.length, made);
      try {
        made += (await this.expand(ids[i])).length;
      } catch (e) {
        console.warn('could not expand', ids[i], e);
        failed++;
        if (failed >= 3 && made === 0) throw e; // the keys are down, not the topics
      }
      if (i < ids.length - 1) await sleep(1200);
    }
    return { made, failed };
  }
};
