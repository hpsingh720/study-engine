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

  const qHtml = qs.map((m, i) => `<div class="card">
      <p class="muted small">Q${i + 1}${m.fromLecture ? ' · from: “' + esc(m.fromLecture) + '”' : ''}</p>
      <p><b>${esc(m.stem)}</b></p>
      <ol class="opts">${m.options.map((o, j) => `<li${j === m.ans ? ' class="right"' : ''}>${esc(o)}</li>`).join('')}</ol>
      ${m.masterLine ? `<p class="muted small">${esc(m.masterLine)}</p>` : ''}
    </div>`).join('');

  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">${new Date(l.started).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}${l.faculty ? ' · ' + esc(l.faculty) : ''}</p>
      <h1>${esc(l.topic)}</h1></div><a class="btn ghost" href="#/lectures">Back</a></header>

    ${topic ? `<p class="muted small">Added to <a href="#/topic/${topic.id}">${esc(topic.name)}</a>, so these come up in normal revision too.</p>` : '<p class="muted small">Not matched to a topic yet.</p>'}
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
    const rows = draft.map((r, i) => `<tr${r.unclear ? ' class="unclear"' : ''}>
        <td>${r.date.slice(8)}/${r.date.slice(5, 7)}</td>
        <td>${Timetable._pretty(r.start)}</td>
        <td><input data-ri="${i}" data-rf="topic" value="${esc(r.topic)}"></td>
        <td><input data-ri="${i}" data-rf="faculty" value="${esc(r.faculty)}"></td>
      </tr>`).join('');
    return `<div class="page">
      <header class="page-head"><div><p class="eyebrow">Check before saving</p><h1>${esc(draft[0]?.subject || 'Roster')}</h1></div></header>
      <p class="muted small">Rows highlighted in red were unclear on the sheet. Fix anything wrong, then save.</p>
      <table class="roster"><thead><tr><th>Date</th><th>Time</th><th>Topic</th><th>Faculty</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="row gap mt">
        <button class="btn primary" data-act="rosterSave">Save ${draft.length} classes</button>
        <button class="btn ghost" data-act="rosterCancel">Discard</button>
      </div></div>`;
  }

  const up = await Timetable.upcoming(30);
  const byDate = {};
  for (const c of up) (byDate[c.date] ||= []).push(c);

  const days = Object.entries(byDate).map(([date, list]) => {
    const d = new Date(date + 'T00:00:00');
    return `<div class="card"><p class="eyebrow">${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
      ${list.map(c => `<div class="row between mid">
        <div><b>${esc(c.topic)}</b><br><span class="muted small">${Timetable._pretty(c.start)}–${Timetable._pretty(c.end)}${c.faculty ? ' · ' + esc(c.faculty) : ''} · ${esc(c.subject)}</span></div>
        <button class="btn ghost small" data-act="classDelete" data-id="${c.id}">✕</button></div>`).join('')}
    </div>`;
  }).join('');

  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">College</p><h1>Class roster</h1></div>
      <a class="btn ghost" href="#/lectures">Lectures</a></header>
    <div class="card">
      <h2>Add a roster</h2>
      <p class="muted small">Photograph the printed sheet flat, in good light — one subject at a time. Each new roster for the same subject and month replaces the old one.</p>
      <input type="file" id="roster-file" accept="image/*,application/pdf">
      <button class="btn full primary mt" data-act="rosterRead">Read this roster</button>
    </div>
    ${days ? `<h3 class="mt">Next 30 days</h3>${days}` : empty('Nothing scheduled', 'Add a roster above and your classes appear here.')}
    ${up.length ? '<p class="muted small mt">You get a reminder at 9pm the night before each day that has classes.</p>' : ''}
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

  async lecDelete(el) {
    if (!confirm('Delete this lecture and the questions made from it?')) return;
    await Lectures.remove(el.dataset.id);
    location.hash = '#/lectures';
  },

  async rosterRead() {
    const f = $('#roster-file')?.files?.[0];
    if (!f) return toast('Pick a photo or PDF of the roster first');
    toast('Reading the roster…');
    const imgs = /pdf$/i.test(f.name) ? await pdfToImages(f, 4) : [await fileToDataUrl(f)];
    let rows = [];
    for (const img of imgs) rows = rows.concat(await Timetable.read(img));
    if (!rows.length) return toast('Could not find any classes on that sheet', 6000);
    Views._roster = rows;
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

  async classDelete(el) { await Timetable.remove(el.dataset.id); App.render(true); }
});

// ---- helpers ----
function fileToDataUrl(f) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
}

/** Render the first few pages of a PDF roster to images, since rosters are tables, not prose. */
async function pdfToImages(file, max = 4) {
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
