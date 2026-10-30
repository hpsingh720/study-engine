// Screens for college lectures and the class roster. Loaded after app.js so it can extend
// the router (ROUTES) and the click-action table (A) that app.js defines.

Views.lectures = async () => {
  const active = await Lectures.current();
  const list = await Lectures.all();
  const todays = await Timetable.todays();
  const suggestion = await Timetable.suggestNow();
  const hasKey = !!Lectures.groqKey();
  const native = !!Lectures.native();

  const recorder = active
    ? `<div class="card rec-live">
         <div class="row between mid">
           <div><p class="eyebrow">Recording</p><h2>${esc(active.topic)}</h2></div>
           <span class="rec-dot"></span>
         </div>
         <p class="muted small">${active.chunks * 2} min recorded${active.transcript ? ` · ${active.transcript.split(/\s+/).length} words kept` : ''}${active.unclearSeconds ? ` · ${Math.round(active.unclearSeconds / 60)} min too unclear to use` : ''}${active.error ? ` · <span class="danger">${esc(active.error)}</span>` : ''}</p>
         ${native ? '<p class="muted small">Safe to lock the screen or leave the app.</p>' : '<p class="muted small warn">Keep this tab open — browser recording stops if you leave.</p>'}
         <button class="btn full danger mt" data-act="lecStop">Stop and make questions</button>
       </div>`
    : `<div class="card">
         <h2>Record a lecture</h2>
         ${!hasKey ? `<p class="warn">Add a free Groq key in <a href="#/settings">Settings</a> first — that is what turns speech into text.</p>` : ''}
         ${todays.length ? `<p class="muted small">Today: ${todays.map(c => esc(c.topic)).join(' · ')}</p>` : '<p class="muted small">No classes imported for today.</p>'}
         <label>Topic<input id="lec-topic" placeholder="e.g. COPD / Bronchial Asthma" value="${esc(suggestion?.topic || '')}"></label>
         <label>Faculty (optional)<input id="lec-faculty" value="${esc(suggestion?.faculty || '')}"></label>
         <button class="btn full primary mt" data-act="lecStart"${hasKey ? '' : ' disabled'}>Start recording</button>
         ${!native ? '<p class="muted small mt">You are in a browser, so recording stops when the tab closes. Install the Android app for lecture-length recording.</p>' : ''}
       </div>`;

  const rows = list.filter(l => l.id !== active?.id).map(l => {
    const when = new Date(l.started).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const state = {
      recording: 'Recording', transcribed: 'Waiting to write questions', writing: 'Writing questions…',
      done: `${l.generated} question${l.generated === 1 ? '' : 's'}${l.reinforced?.length ? ` · ${l.reinforced.length} already in your bank` : ''}`,
      thin: 'Too little speech captured'
    }[l.state] || l.state;
    return `<a class="card row between mid" href="#/lecture/${l.id}">
        <div><b>${esc(l.topic)}</b><br><span class="muted small">${when}${l.faculty ? ' · ' + esc(l.faculty) : ''} · ${state}</span></div>
        <span class="ni">›</span>
      </a>`;
  }).join('');

  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">College</p><h1>Lectures</h1></div>
      <a class="btn ghost" href="#/timetable">Class roster</a></header>
    ${recorder}
    ${rows ? `<h3 class="mt">Earlier lectures</h3>${rows}` : empty('No lectures yet', 'Record one in class and the questions appear here afterwards.')}
  </div>`;
};

Views.lecture = async id => {
  const l = await Lectures.get(id);
  if (!l) return empty('Not found', 'That lecture is gone.', '<a class="btn" href="#/lectures">Back</a>');

  const qs = [];
  for (const qid of l.mcqIds || []) { const m = await DB.get('mcqs', qid); if (m && !m.deleted) qs.push(m); }
  const topic = l.topicId ? await DB.get('topics', l.topicId) : null;

  // Slides photographed during the class: a diagram never reaches the transcript.
  const slides = [];
  for (const s of l.slides || []) {
    const m = await DB.get('media', s.id);
    if (m?.data) slides.push({ ...s, data: m.data });
  }
  const pending = slides.filter(s => !s.used).length;
  const slidesHtml = `<section class="card">
    <div class="card-head"><h3>Slides from the class</h3><span class="muted small">${slides.length || 'none'}${pending ? ` · ${pending} not used yet` : ''}</span></div>
    <p class="muted small">Photograph the diagrams, X-rays and tables the lecturer puts up. They become picture questions built on what was being said at the time.</p>
    ${slides.length ? `<div class="slide-strip">${slides.map(s => `<figure class="slide${s.used ? ' used' : ''}">
      <img src="${s.data}" alt="">
      <figcaption>${s.used ? `${s.made || 0} question${s.made === 1 ? '' : 's'}` : 'not used yet'}
        <button class="link" data-act="lecSlideDrop" data-id="${l.id}" data-m="${s.id}">remove</button></figcaption></figure>`).join('')}</div>` : ''}
    <input type="file" id="slide-file" accept="image/*" capture="environment" multiple hidden>
    <div class="row gap mt">
      <button class="btn" data-act="lecSlideAdd" data-id="${l.id}">${slides.length ? 'Add more slides' : 'Add a slide'}</button>
      ${pending ? `<button class="btn primary" data-act="lecSlideMcqs" data-id="${l.id}">Write questions from ${pending} slide${pending === 1 ? '' : 's'}</button>` : ''}
    </div></section>`;

  const qHtml = qs.map((m, i) => `<div class="card">
      <p class="muted small">Q${i + 1}${m.fromLecture ? ' · from: “' + esc(m.fromLecture) + '”' : ''}</p>
      <p><b>${esc(m.stem)}</b></p>
      <ol class="opts">${m.options.map((o, j) => `<li${j === m.ans ? ' class="right"' : ''}>${esc(o)}</li>`).join('')}</ol>
      ${m.masterLine ? `<p class="muted small">${esc(m.masterLine)}</p>` : ''}
    </div>`).join('');

  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">${new Date(l.started).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}${l.faculty ? ' · ' + esc(l.faculty) : ''}</p>
      <h1>${esc(l.topic)}</h1></div><a class="btn ghost" href="#/lectures">Back</a></header>

    ${topic
      ? `<p class="muted small">Added to <a href="#/topic/${topic.id}">${esc(topic.name)}</a>, so these come up in normal revision too.</p>`
      : `<p class="warn-t small">Not filed under any topic yet, so these questions will not appear in revision. <button class="link" data-act="lecPlace" data-id="${l.id}">File it now</button> — it works out what the roster's shorthand means.</p>`}

    ${slidesHtml}
    ${l.state === 'transcribed' ? `<button class="btn full primary" data-act="lecGenerate" data-id="${l.id}">Write questions from this lecture</button>` : ''}
    ${l.state === 'writing' ? '<p class="muted">Writing questions…</p>' : ''}
    ${l.error ? `<p class="warn">${esc(l.error)}</p>` : ''}

    ${qs.length ? `<h3 class="mt">Questions (${qs.length})</h3>${qHtml}` : ''}
    ${l.reinforced?.length ? `<p class="muted small mt">${l.reinforced.length} point${l.reinforced.length === 1 ? ' was' : 's were'} already covered by questions you have — those were tagged rather than duplicated.</p>` : ''}

    ${l.unclearSeconds > 30 ? `<p class="muted small mt">${Math.round(l.unclearSeconds / 60)} minute${l.unclearSeconds >= 90 ? 's' : ''} of this lecture could not be transcribed reliably — usually the parts spoken in Hindi or Punjabi — and were left out rather than guessed at.</p>` : ''}
    <details class="mt"><summary>Transcript</summary><p class="transcript">${esc(l.transcript || '(nothing captured)')}</p></details>
    <button class="btn full ghost danger mt" data-act="lecDelete" data-id="${l.id}">Delete this lecture</button>
  </div>`;
};

Views.timetable = async () => {
  const draft = Views._roster;
  if (draft) {
    const subjects = [...new Set(draft.map(r => r.subject))];
    const unclear = draft.filter(r => r.unclear).length;

    // Grouped by day, because that is how it will be read back and how mistakes become obvious.
    let lastDate = '';
    const rows = draft.map((r, i) => {
      const head = r.date === lastDate ? '' : `<tr class="rdate"><td colspan="4">${new Date(r.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</td></tr>`;
      lastDate = r.date;
      return head + `<tr${r.unclear ? ' class="unclear"' : ''}>
        <td class="rtime">${Timetable._pretty(r.start)}</td>
        <td><input data-ri="${i}" data-rf="topic" value="${esc(r.topic)}"></td>
        <td><input data-ri="${i}" data-rf="subject" value="${esc(r.subject)}"></td>
        <td><input data-ri="${i}" data-rf="faculty" value="${esc(r.faculty)}"></td>
      </tr>`;
    }).join('');

    return `<div class="page">
      <header class="page-head"><div><p class="eyebrow">Check before saving</p><h1>${draft.length} classes</h1></div></header>
      <p class="muted small">From ${subjects.length} sheet${subjects.length === 1 ? '' : 's'}: ${esc(subjects.join(', '))}.${unclear ? ` <b>${unclear} row${unclear === 1 ? '' : 's'} highlighted in red could not be read properly — fix those first.</b>` : ''}</p>
      ${Views._rosterFailed?.length ? `<p class="warn">Could not read: ${esc(Views._rosterFailed.join(', '))}. Try photographing those instead.</p>` : ''}
      <table class="roster"><thead><tr><th>Time</th><th>Topic</th><th>Subject</th><th>Faculty</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="row gap mt">
        <button class="btn primary" data-act="rosterSave">Save ${draft.length} classes</button>
        <button class="btn ghost" data-act="rosterCancel">Discard</button>
      </div></div>`;
  }

  // ---- the fixed week, being edited ----
  if (Views._weekly) {
    const slots = Views._weekly;
    const groups = Timetable.groups();

    let lastDay = -1;
    const rows = slots.map((s, i) => {
      const head = +s.day === lastDay ? '' : `<tr class="rdate"><td colspan="5">${Timetable.DAYS[+s.day]}</td></tr>`;
      lastDay = +s.day;
      return head + `<tr>
      <td><select data-wi="${i}" data-wf="day">${Timetable.DAYS.map((d, n) =>
        `<option value="${n}"${n === +s.day ? ' selected' : ''}>${d.slice(0, 3)}</option>`).join('')}</select></td>
      <td><input type="time" data-wi="${i}" data-wf="start" value="${esc(s.start)}"></td>
      <td><input type="time" data-wi="${i}" data-wf="end" value="${esc(s.end)}"></td>
      <td><input data-wi="${i}" data-wf="label" value="${esc(s.label || s.group)}"></td>
      <td><select data-wi="${i}" data-wf="group">${groups.map(g =>
        `<option${g === s.group ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></td>
      <td><button class="btn ghost small" data-act="weeklyDrop" data-i="${i}">✕</button></td>
    </tr>`;
    }).join('');

    return `<div class="page">
      <header class="page-head"><div><p class="eyebrow">Set it once</p><h1>Your fixed week</h1></div></header>
      <p class="muted small"><b>Check the times</b> — they are a guess, since the printed grid shows periods rather than clock times. Everything else is already filled in from your timetable.</p>
      <p class="muted small">"Name" is what you call the slot. "Group" is what it matches on: a Medicine slot gets filled by whatever Medicine class that week is, whether that turns out to be internal medicine, pulmonology or dermatology. The clinical posting is left out on purpose, since it moves around.</p>
      ${slots.length ? `<table class="roster mt"><thead><tr><th>Day</th><th>From</th><th>To</th><th>Name</th><th>Group</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="muted mt">No slots yet.</p>'}
      <div class="row gap mt">
        <button class="btn ghost" data-act="weeklyAdd">Add a slot</button>
        <button class="btn ghost" data-act="weeklyInfer">Fill from my rosters</button>
      </div>
      <div class="row gap mt">
        <button class="btn primary" data-act="weeklySave">Save my week</button>
        <button class="btn ghost" data-act="weeklyCancel">Cancel</button>
      </div>
    </div>`;
  }

  const weekly = await Timetable.weekly();
  const byDate = await Timetable.upcomingView(30);

  const days = Object.entries(byDate).map(([date, list]) => {
    const d = new Date(date + 'T00:00:00');
    return `<div class="card"><p class="eyebrow">${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
      ${list.map(c => `<div class="row between mid">
        <div><b>${c.pending ? `<span class="muted">${esc(c.label || c.group)} — topic not up yet</span>` : esc(c.topic)}</b><br><span class="muted small">${Timetable._pretty(c.start)}–${Timetable._pretty(c.end)}${c.faculty ? ' · ' + esc(c.faculty) : ''}${c.department && !c.pending ? ' · ' + esc(c.department) : ''}${c.extra ? ' · extra' : ''}</span></div>
        ${c.pending ? '' : `<button class="btn ghost small" data-act="classDelete" data-id="${c.id}">✕</button>`}</div>`).join('')}
    </div>`;
  }).join('');

  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">College</p><h1>Class roster</h1></div>
      <a class="btn ghost" href="#/lectures">Lectures</a></header>
    <div class="card">
      <h2>Your fixed week</h2>
      <p class="muted small">${weekly.length
        ? `${weekly.length} slot${weekly.length === 1 ? '' : 's'} set. Topics drop into these from the roster sheets.`
        : 'Not set yet. Put your weekly slots in once and every roster you upload afterwards fills them in — and days whose topics have not been published still show up with the right subject.'}</p>
      <button class="btn full ${weekly.length ? 'ghost' : 'primary'} mt" data-act="weeklyEdit">${weekly.length ? 'Edit my week' : 'Set up my week'}</button>
    </div>
    <div class="card">
      <h2>Add a roster</h2>
      <p class="muted small">Pick every subject's sheet at once — photos, PDFs, or a mix. They get merged into one day-by-day list. Re-uploading a subject replaces its old entries for that month rather than duplicating them, however the file is named.</p>
      <input type="file" id="roster-file" accept="image/*,application/pdf" multiple>
      <button class="btn full primary mt" data-act="rosterRead">Read these rosters</button>
      <p class="muted small" id="roster-progress"></p>
    </div>
    ${days ? `<h3 class="mt">Next 30 days</h3>${days}` : empty('Nothing scheduled', 'Set up your week above, or add a roster, and your classes appear here.')}
    ${days ? '<p class="muted small mt">You get a reminder at 9pm the night before each day that has classes.</p>' : ''}
  </div>`;
};

// ---- routes ----
ROUTES.push(
  [/^#\/lectures$/, () => Views.lectures()],
  [/^#\/lecture\/([\w-]+)$/, m => Views.lecture(m[1])],
  [/^#\/timetable$/, () => Views.timetable()]
);

// ---- actions ----
Object.assign(A, {
  async lecStart() {
    const topic = $('#lec-topic')?.value.trim();
    if (!topic) return toast('Give the lecture a topic first');
    await Lectures.start({ topic, faculty: $('#lec-faculty')?.value.trim() || '' });
    toast('Recording. You can lock the screen.');
    App.render();
  },

  async lecStop() {
    await Lectures.stop();
    toast('Stopped — writing questions from what was said.');
    App.render();
  },

  async lecGenerate(el) {
    toast('Writing questions…');
    await Lectures.generate(el.dataset.id);
    App.render(true);
  },

  lecSlideAdd(el) {
    const inp = $('#slide-file');
    if (!inp) return;
    inp.onchange = async () => {
      const files = [...(inp.files || [])];
      if (!files.length) return;
      toast(`Saving ${files.length} slide${files.length === 1 ? '' : 's'}…`);
      for (const f of files) { try { await Lectures.addSlide(el.dataset.id, f); } catch (e) { console.warn(e); } }
      inp.value = '';
      toast('Saved. Tap "Write questions from slides" when the class is over.', 6000);
      App.render(true);
    };
    inp.click();
  },

  async lecSlideDrop(el) {
    await Lectures.removeSlide(el.dataset.id, el.dataset.m);
    App.render(true);
  },

  async lecSlideMcqs(el) {
    toast('Reading the slides…');
    try {
      const n = await Lectures.slideMcqs(el.dataset.id);
      toast(n ? `Wrote ${n} picture question${n === 1 ? '' : 's'}.` : 'Nothing examinable on those slides — title slides and bullet lists are skipped.', 8000);
      App.render(true);
    } catch (e) { toast(e.message || String(e), 7000); }
  },

  /** Work out what the roster's shorthand meant, and file the lecture under it. */
  async lecPlace(el) {
    const l = await Lectures.get(el.dataset.id);
    if (!l) return;
    toast(`Working out what "${l.topic}" is…`);
    try {
      const { topic } = await Focus.study(`${l.topic}${l.subject ? ' (' + l.subject + ')' : ''}`, { amc: 0, mbbs: 0 });
      l.topicId = topic.id;
      await Lectures.save(l);
      // Anything already written for this lecture moves across with it.
      for (const qid of [...(l.mcqIds || []), ...(l.slideMcqIds || [])]) {
        const m = await DB.get('mcqs', qid);
        if (m && !m.topicId) { m.topicId = topic.id; m.system = topic.system || ''; await DB.put('mcqs', m); }
      }
      toast(`Filed under "${topic.name}".`, 7000);
      App.render(true);
    } catch (e) { toast(e.message || String(e), 7000); }
  },

  async lecDelete(el) {
    if (!confirm('Delete this lecture and the questions made from it?')) return;
    await Lectures.remove(el.dataset.id);
    location.hash = '#/lectures';
  },

  async rosterRead() {
    const files = [...($('#roster-file')?.files || [])];
    if (!files.length) return toast('Pick the roster sheets first');

    const say = t => { const p = $('#roster-progress'); if (p) p.textContent = t; };
    let rows = [], failed = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      say(`Reading ${f.name} (${i + 1} of ${files.length})…`);
      try {
        // A subject's sheet can run to several pages; read each one.
        const imgs = /pdf$/i.test(f.name) || f.type === 'application/pdf'
          ? await pdfToImages(f, 6)
          : [await fileToDataUrl(f)];
        // The filename is usually the subject ("Medicine Oct.pdf") and is a better fallback than
        // "General" when the sheet's own title is unclear.
        const hint = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
        for (const img of imgs) rows = rows.concat(await Timetable.read(img, { subject: hint }));
      } catch (e) {
        console.warn('roster failed', f.name, e);
        failed.push(f.name);
      }
    }

    say('');
    if (!rows.length) return toast(`Could not find any classes${failed.length ? ' — ' + failed.join(', ') + ' could not be read' : ''}`, 7000);

    // One class can only be in one place at one time: drop anything the same across two sheets.
    const seen = new Set();
    rows = rows.filter(r => { const k = r.date + r.start + r.topic.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
               .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

    Views._roster = rows;
    Views._rosterFailed = failed;
    App.render();
  },

  async rosterSave() {
    // Pull any corrections typed into the review table back into the rows.
    $$('[data-ri]').forEach(i => { Views._roster[+i.dataset.ri][i.dataset.rf] = i.value.trim(); });
    Views._roster.forEach(r => { if (r.topic) r.unclear = false; });
    const n = await Timetable.commit(Views._roster);
    Views._roster = null;
    toast(`Saved ${n} classes. You will be reminded at 9pm the night before.`);
    App.render();
  },

  rosterCancel() { Views._roster = null; App.render(); },

  // ---- the fixed week ----

  async weeklyEdit() {
    const saved = await Timetable.weekly();
    // Nothing saved yet: start from the printed timetable rather than a blank table.
    Views._weekly = saved.length ? saved : Timetable.DEFAULT_WEEK.map(s => ({ ...s }));
    App.render();
  },

  /** Read the table back before any change, so edits are not lost when the page re-renders. */
  _weeklyPull() {
    $$('[data-wi]').forEach(i => { Views._weekly[+i.dataset.wi][i.dataset.wf] = i.value; });
  },

  weeklyAdd() {
    A._weeklyPull();
    const last = Views._weekly[Views._weekly.length - 1];
    Views._weekly.push({
      day: last ? last.day : 1,
      start: last ? last.end : '09:00',
      end: last ? Timetable._plusHour(last.end) : '10:00',
      group: 'Medicine', label: 'Medicine'
    });
    App.render();
  },

  weeklyDrop(el) {
    A._weeklyPull();
    Views._weekly.splice(+el.dataset.i, 1);
    App.render();
  },

  async weeklyInfer() {
    const found = await Timetable.inferWeekly();
    if (!found.length) return toast('Not enough rosters yet to see a pattern — add a couple of months first', 6000);
    Views._weekly = found;
    toast(`Found ${found.length} repeating slot${found.length === 1 ? '' : 's'}`);
    App.render();
  },

  async weeklySave() {
    A._weeklyPull();
    const n = await Timetable.saveWeekly(Views._weekly);
    Views._weekly = null;
    toast(`Saved ${n} weekly slots. Roster topics will drop into these.`);
    App.render();
  },

  weeklyCancel() { Views._weekly = null; App.render(); },

  async classDelete(el) { await Timetable.remove(el.dataset.id); App.render(true); }
});

// ---- helpers ----
function fileToDataUrl(f) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
}

/** Render the first few pages of a PDF roster to images, since rosters are tables, not prose. */
async function pdfToImages(file, max = 4) {
  await ensurePdfjs(); // the reader is fetched on demand, not at page load
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const out = [];
  for (let p = 1; p <= Math.min(pdf.numPages, max); p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 2 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    out.push(c.toDataURL('image/jpeg', 0.85));
  }
  return out;
}
