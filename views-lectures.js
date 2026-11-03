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
           <div><p class="eyebrow">Recording</p><h2>${esc(active.topic)}</h2>
             <button class="link small" data-act="lecRename" data-id="${active.id}">Wrong class? Rename it</button></div>
           <span class="rec-dot"></span>
         </div>
         <p class="muted small">${active.chunks * 2} min recorded${active.transcript ? ` · ${active.transcript.split(/\s+/).length} words kept` : ''}${active.unclearSeconds ? ` · ${Math.round(active.unclearSeconds / 60)} min too unclear to use` : ''}${active.error ? ` · <span class="danger">${esc(active.error)}</span>` : ''}</p>
         ${native ? '<p class="muted small">Safe to lock the screen or leave the app.</p>' : '<p class="muted small warn">Keep this tab open — browser recording stops if you leave.</p>'}
         <div class="row gap mt">
           <button class="btn primary" data-act="lecSlideAdd" data-id="${active.id}">📷 Camera${active.slides?.length ? ` · ${active.slides.length}` : ''}</button>
           <button class="btn" data-act="lecSlidePick" data-id="${active.id}">From photos</button>
           <a class="btn ghost" href="#/lecture/${active.id}">Open this lecture</a>
         </div>
         <p class="muted small">The camera stays open — keep tapping for each film or diagram, and sort out what to keep at the end.</p>
         <button class="btn full danger mt" data-act="lecStop">Stop and make questions</button>
       </div>`
    : `<div class="card">
         <h2>Record a lecture</h2>
         ${!hasKey ? `<p class="warn">Add a free Groq key in <a href="#/settings">Settings</a> first — that is what turns speech into text.</p>` : ''}
         ${todays.length ? `<label>Which class?
           <select id="lec-pick" data-change="pickClass">
             ${todays.map(c => {
               const label = `${Timetable._pretty(c.start)}–${Timetable._pretty(c.end)} · ${c.topic || c.label || c.group || 'Class'}`;
               return `<option value="${esc(c.id)}" data-topic="${esc(c.topic || c.label || c.group || '')}" data-faculty="${esc(c.faculty || '')}" data-subject="${esc(c.department || c.subject || '')}"${c.id === suggestion?.id ? ' selected' : ''}>${esc(label)}</option>`;
             }).join('')}
             <option value="">Something else…</option>
           </select></label>
           <p class="muted small">Today's classes, from the roster. The one happening now is picked — change it if they have been swapped around.</p>`
         : '<p class="muted small">No classes on the roster for today, so type what is being taught.</p>'}
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

  // A lecture with no topic keeps its questions out of revision entirely, which is invisible from
  // here unless it is said plainly.
  const unfiled = list.filter(l => !l.topicId && (l.mcqIds?.length || l.slideMcqIds?.length || l.state === 'done'));

  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">College</p><h1>Lectures</h1></div>
      <div class="row gap"><a class="btn ghost" href="#/notes">Class notes</a><a class="btn ghost" href="#/timetable">Class roster</a></div></header>
    ${unfiled.length ? `<div class="card soft">
      <p class="warn-t"><b>${unfiled.length} lecture${unfiled.length === 1 ? '' : 's'} not filed under a topic.</b> Their questions exist but never come up in practice or a system test, because they belong to nothing.</p>
      <p class="muted small">${unfiled.map(l => esc(l.topic)).join(' · ')}</p>
      <button class="btn full mt" data-act="lecPlaceAll">File ${unfiled.length === 1 ? 'it' : 'them all'} now</button>
    </div>` : ''}
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
  // The notes refer to photographs by their position in l.slides, so that position is carried
  // here rather than the position in this list — one missing picture would otherwise shift every
  // reading onto the wrong photo.
  const slides = [], byIndex = {};
  for (const [i, s] of (l.slides || []).entries()) {
    const m = await DB.get('media', s.id);
    if (m?.data) { slides.push({ ...s, data: m.data }); byIndex[i] = m.data; }
  }
  const pending = slides.filter(s => !s.used).length;
  const slidesHtml = `<section class="card">
    <div class="card-head"><h3>Photos from the class</h3><span class="muted small">${slides.length || 'none'}${pending ? ` · ${pending} not used yet` : ''}</span></div>
    <p class="muted small">Films, diagrams and tables photographed in the room. They become picture questions built on what was being said at the time, and they are what the notes are written from.</p>
    ${slides.length ? `<div class="slide-strip">${slides.map(s => `<figure class="slide${s.used ? ' used' : ''}">
      <img src="${s.data}" alt="" data-act="zoomImg">
      <figcaption>${s.read?.label ? esc(s.read.label.slice(0, 40)) : s.used ? `${s.made || 0} question${s.made === 1 ? '' : 's'}` : 'not used yet'}
        <button class="link" data-act="lecSlideDrop" data-id="${l.id}" data-m="${s.id}">remove</button></figcaption></figure>`).join('')}</div>` : ''}
    <div class="row gap mt">
      <button class="btn primary" data-act="lecSlideAdd" data-id="${l.id}">📷 Camera</button>
      <button class="btn" data-act="lecSlidePick" data-id="${l.id}">From photos</button>
      ${pending ? `<button class="btn" data-act="lecSlideMcqs" data-id="${l.id}">Write questions from ${pending} photo${pending === 1 ? '' : 's'}</button>` : ''}
    </div></section>`;

  // Notes: the thing he comes back to in June, when the room is long forgotten.
  const notesHtml = `<section class="card">
    <div class="card-head"><h3>Notes</h3>${l.notes ? `<a class="btn ghost sm" href="#/notes/${l.id}">Open full page</a>` : ''}</div>
    ${l.notes
      ? `<div class="hn-mini">${Lectures.notesHTML(l.notes, byIndex)}</div>
         <div class="row gap mt"><button class="btn ghost sm" data-act="lecNotes" data-id="${l.id}">Rewrite them</button>
           <a class="btn ghost sm" href="#/notes">All class notes</a></div>`
      : `<p class="muted small">Colourful handwritten notes from the whole class — the transcript and every photo read together, each film with how to recognise it and what the examiner asks there. Made once and kept, so this is what you open before the practical.</p>
         <button class="btn full primary mt" data-act="lecNotes" data-id="${l.id}">Make notes from this class</button>`}
  </section>`;

  const qHtml = qs.map((m, i) => `<div class="card">
      <p class="muted small">Q${i + 1}${m.fromLecture ? ' · from: “' + esc(m.fromLecture) + '”' : ''}</p>
      <p><b>${esc(m.stem)}</b></p>
      <ol class="opts">${m.options.map((o, j) => `<li${j === m.ans ? ' class="right"' : ''}>${esc(o)}</li>`).join('')}</ol>
      ${m.masterLine ? `<p class="muted small">${esc(m.masterLine)}</p>` : ''}
    </div>`).join('');

  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">${new Date(l.started).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}${l.faculty ? ' · ' + esc(l.faculty) : ''}</p>
      <h1>${esc(l.topic)}</h1></div>
      <div class="row gap"><button class="btn ghost sm" data-act="lecRename" data-id="${l.id}">Rename</button><a class="btn ghost" href="#/lectures">Back</a></div></header>

    ${topic
      ? `<p class="muted small">Added to <a href="#/topic/${topic.id}">${esc(topic.name)}</a>, so these come up in normal revision too.</p>`
      : `<p class="warn-t small">Not filed under any topic yet, so these questions will not appear in revision. <button class="link" data-act="lecPlace" data-id="${l.id}">File it now</button> — it works out what the roster's shorthand means.</p>`}

    ${slidesHtml}
    ${notesHtml}
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

/**
 * Every set of class notes, in one place.
 *
 * The lecture page is where notes get made; this is where they get used, which is months later and
 * usually the night before a practical. So it is sorted by subject rather than by date — by then
 * what matters is "the paediatric imaging ones", not which Tuesday they were.
 */
Views.classNotes = async () => {
  const all = (await Lectures.all()).filter(l => l.notes);
  if (!all.length) {
    return empty('No class notes yet',
      'Open a lecture you have recorded or photographed and press "Make notes from this class".',
      '<a class="btn primary" href="#/lectures">Go to Lectures</a>');
  }

  const groups = {};
  for (const l of all) (groups[l.subject || 'Other'] ||= []).push(l);

  const body = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).map(([sub, ls]) => `
    <h3 class="mt">${esc(sub)}</h3>
    ${ls.sort((a, b) => b.started - a.started).map(l => {
      const n = l.notes, spots = n.spotters?.length || 0;
      return `<a class="card row between mid" href="#/notes/${l.id}">
        <div><b>${esc(n.title || l.topic)}</b><br><span class="muted small">${fmtDate(l.started)}${l.faculty ? ' · ' + esc(l.faculty) : ''} · ${n.sections?.length || 0} section${n.sections?.length === 1 ? '' : 's'}${spots ? ` · ${spots} photo${spots === 1 ? '' : 's'} read` : ''}</span></div>
        <span class="ni">›</span></a>`;
    }).join('')}`).join('');

  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">From your classes</p><h1>Class notes</h1></div>
      <a class="btn ghost" href="#/lectures">Lectures</a></header>
    <p class="muted small">Written from the recording and the photographs of each class. Open one before a practical: every film you photographed is in there with how to recognise it and what gets asked at that station.</p>
    ${body}</div>`;
};

Views.classNote = async id => {
  const l = await Lectures.get(id);
  if (!l?.notes) return empty('No notes', 'There are no notes for that class.', '<a class="btn" href="#/notes">All class notes</a>');

  const map = {};
  for (const [i, s] of (l.slides || []).entries()) {
    const m = await DB.get('media', s.id);
    if (m?.data) map[i] = m.data;
  }

  return `<div class="page notes-page">
    <header class="page-head no-print"><div><p class="eyebrow">${fmtDate(l.started)}${l.faculty ? ' · ' + esc(l.faculty) : ''}</p>
      <h1>${esc(l.notes.title)}</h1></div>
      <div class="row gap">
        <button class="btn ghost sm" data-act="printNotes">Print / PDF</button>
        <a class="btn ghost sm" href="#/lecture/${l.id}">The class</a>
        <a class="btn ghost" href="#/notes">All notes</a>
      </div></header>
    <div id="notes-print">${Lectures.notesHTML(l.notes, map)}</div>
  </div>`;
};

// ---- routes ----
ROUTES.push(
  [/^#\/lectures$/, () => Views.lectures()],
  [/^#\/lecture\/([\w-]+)$/, m => Views.lecture(m[1])],
  [/^#\/notes$/, () => Views.classNotes()],
  [/^#\/notes\/([\w-]+)$/, m => Views.classNote(m[1])],
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

  /**
   * Rename a recording, and re-file it.
   *
   * The roster is not always what is actually taught — classes get swapped, and sometimes the
   * lecturer announces the subject only once they start. Anything already written for the lecture
   * moves with it.
   */
  async lecRename(el) {
    const l = await Lectures.get(el.dataset.id);
    if (!l) return;
    const v = prompt('What is this lecture actually on?', l.topic || '');
    if (v === null) return;
    const name = v.trim();
    if (!name) return;

    l.topic = name;
    l.topicId = '';           // re-file it: the old topic was for the old name
    await Lectures.save(l);

    try {
      const { topic } = await Focus.study(`${name}${l.subject ? ' (' + l.subject + ')' : ''}`, { amc: 0, mbbs: 0, context: l.transcript || '' });
      l.topicId = topic.id;
      await Lectures.save(l);
      for (const qid of [...(l.mcqIds || []), ...(l.slideMcqIds || [])]) {
        const m = await DB.get('mcqs', qid);
        if (m) { m.topicId = topic.id; m.system = topic.system || ''; await DB.put('mcqs', m); }
      }
      toast(`Renamed to "${name}" and filed under "${topic.name}".`, 7000);
    } catch (e) { toast(`Renamed to "${name}".`, 5000); }
    App.render(true);
  },

  /**
   * Open the camera and leave it open.
   *
   * A file input closes after every shot, which is hopeless when a lecturer is moving through
   * twenty X-rays — by the time the picker has reopened the next film is already up. This shoots
   * continuously, then asks once at the end which to keep and whether to trim them.
   */
  lecSlideAdd(el) {
    const id = el.dataset.id;
    Capture.open(urls => A._saveShots(id, urls));
  },

  /** Photographs already taken with the normal camera app, several at a time. */
  lecSlidePick(el) {
    const id = el.dataset.id;
    Capture.pick(urls => A._saveShots(id, urls));
  },

  async _saveShots(id, urls) {
    toast(`Saving ${urls.length} photo${urls.length === 1 ? '' : 's'}…`);
    let n = 0;
    for (const u of urls) { try { await Lectures.addSlideData(id, u); n++; } catch (e) { console.warn(e); } }
    toast(n === urls.length
      ? `${n} photo${n === 1 ? '' : 's'} saved to this class.`
      : `${n} of ${urls.length} saved — the rest would not store.`, 6000);
    App.render(true);
  },

  /** Colourful notes from the whole class: the recording and every photograph, read together. */
  async lecNotes(el) {
    const id = el.dataset.id;
    if (el.dataset.busy) return;
    el.dataset.busy = '1';
    try {
      toast('Reading the class…', 6000);
      const n = await Lectures.makeNotes(id, msg => toast(msg, 6000));
      toast(`Notes ready — ${n.sections.length} section${n.sections.length === 1 ? '' : 's'}${n.spotters.length ? ` and ${n.spotters.length} photo${n.spotters.length === 1 ? '' : 's'} read one by one` : ''}.`, 8000);
      location.hash = '#/notes/' + id;
      App.render(true);
    } catch (e) {
      toast(e.message || String(e), 9000);
    } finally { delete el.dataset.busy; }
  },

  printNotes() {
    const src = $('#notes-print');
    if (!src) return;
    const area = $('#print');
    area.innerHTML = src.innerHTML;
    window.print();
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

  /** File every stranded lecture, one at a time so a rate limit does not lose the lot. */
  async lecPlaceAll() {
    const list = (await Lectures.all()).filter(l => !l.topicId && (l.mcqIds?.length || l.slideMcqIds?.length || l.state === 'done'));
    if (!list.length) return toast('Everything is already filed.');
    let done = 0, failed = 0;
    for (const l of list) {
      toast(`Filing "${l.topic}" (${done + 1} of ${list.length})…`, 3000);
      try {
        await A.lecPlace({ dataset: { id: l.id } });
        // lecPlace reports its own failures, so check what actually happened rather than trusting it.
        ((await Lectures.get(l.id))?.topicId) ? done++ : failed++;
      } catch (e) { console.warn('place', l.topic, e); failed++; }
      await sleep(1000);
    }
    toast(`Filed ${done} lecture${done === 1 ? '' : 's'}${failed ? `, ${failed} could not be worked out` : ''}.`, 8000);
    App.render(true);
  },

  /** Work out what the roster's shorthand meant, and file the lecture under it. */
  async lecPlace(el) {
    const l = await Lectures.get(el.dataset.id);
    if (!l) return;
    toast(`Working out what "${l.topic}" is…`);
    try {
      const { topic } = await Focus.study(`${l.topic}${l.subject ? ' (' + l.subject + ')' : ''}`, { amc: 0, mbbs: 0, context: l.transcript || '' });
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

  async classDelete(el) { await Timetable.remove(el.dataset.id); App.render(true); },

  // ---- the camera (capture.js) ----
  capShoot() { Capture.shoot(); },
  capFlip() { Capture.flip(); },
  capFinish() { Capture.finish(); },
  capDrop(el) { Capture.drop(+el.dataset.i); },
  capCrop(el) { Capture.crop(+el.dataset.i); },
  capRemove(el) { Capture.remove(+el.dataset.i); },
  capSave() { Capture.save(); },
  capCancel() { Capture.cancel(); },
  capCropOk() { Capture.cropOk(); },
  capCropAll() { Capture.cropAll(); }
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
