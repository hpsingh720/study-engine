// All screens. Each view returns HTML; interactions go through data-act handlers in app.js.
const SYS_LIST = SEED.systems.map(s => ({ code: s.code, name: s.name }));
const sysName = c => SYS_LIST.find(s => s.code === c)?.name || c || '—';
const TYPE_LABEL = { AMC: 'AMC', MBBS: 'MBBS', IMG: 'Image' };

async function hasBooks() { return (await DB.count('books')) > 0; }

async function loadStats() {
  const att = await DB.live('attempts');
  const by = {}, last = {}; let todayN = 0, todayOk = 0; const today = todayStr();
  const days = {};
  for (const a of att) {
    for (const k of [a.topicId || '_', 'sys:' + (a.system || '_')]) { const b = by[k] ||= { n: 0, ok: 0 }; b.n++; if (a.correct) b.ok++; }
    const d = todayStr(new Date(a.ts)); days[d] = (days[d] || 0) + 1;
    if (d === today) { todayN++; if (a.correct) todayOk++; }
    if (!last[a.mcqId] || last[a.mcqId].ts < a.ts) last[a.mcqId] = a;
  }
  const mistakes = Object.values(last).filter(a => !a.correct).length;
  return { att, by, last, todayN, todayOk, mistakes, days };
}
const accTxt = b => b && b.n ? `${pct(b.ok, b.n)}%` : '—';

function bar(p, cls = '') { return `<div class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, p))}%"></i></div>`; }
function empty(title, body, action = '') { return `<div class="empty"><h3>${title}</h3><p>${body}</p>${action}</div>`; }

const Views = {};

// ---------------- Today ----------------
Views.today = async () => {
  const [prefs, topics, st, bw, books, sheets] = await Promise.all([Prefs.get(), DB.live('topics'), loadStats(), biweeklyStatus(), hasBooks(), DB.all('sheets')]);
  const sheetSet = new Set(sheets.map(s => s.id));
  const d = new Date();
  const exams = prefs.exams.map(e => {
    const n = daysUntil(e.date);
    return `<div class="card count"><p class="eyebrow">${esc(e.name)}</p><div class="big">${n == null ? '—' : n < 0 ? 'Done' : n}<span>${n >= 0 ? ' days' : ''}</span></div><p class="muted">${e.date ? new Date(e.date + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : 'Set a date in Settings'}</p></div>`;
  }).join('');
  const goal = prefs.daily || 30;
  const focus = prefs.focus || 'CVS';
  const next = topics.filter(t => t.system === focus && !t.done).sort((a, b) => a.order - b.order).slice(0, 5);
  const lastTopic = topics.find(t => t.id === localStorage.getItem('lastTopic'));
  const weak = topics.map(t => ({ t, b: st.by[t.id] })).filter(x => x.b && x.b.n >= 5).sort((a, b) => a.b.ok / a.b.n - b.b.ok / b.b.n).slice(0, 5);
  const qc = books ? await Queue.counts() : null;
  const due = (await dueSet()).size;
  const plans = await plansForToday();
  const todays = plans.filter(p => p.today);

  return `<div class="page">
  <header class="page-head"><div><p class="eyebrow">${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p><h1>Today</h1></div></header>
  <section class="grid-3 counts">${exams}</section>
  ${plans.length ? `<section class="card mt"><div class="card-head"><h3>Today's plan</h3><a class="link small" href="#/systems">All systems ›</a></div>
    ${todays.length ? `<div class="plan">${todays.map(p => planDayRow(p.today, p.code)).join('')}</div>` : '<p class="muted">Nothing scheduled today.</p>'}
    <p class="muted small">${plans.map(p => `${sysName(p.code)}: ${p.plan.overdue ? '<span class="warn-t">deadline passed</span>' : `${p.plan.left} left, ${p.plan.pace.toFixed(1)}/day until ${new Date(p.plan.target + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}`).join(' · ')}</p></section>`
  : `<section class="card mt soft"><h3>Plan your systems</h3><p class="muted">Open a system (e.g. <a class="link" href="#/system/CVS">Cardiology</a>) and set a deadline — the app splits its topics into a daily plan around your biweekly tests.</p></section>`}
  <section class="grid-2">
    <div class="card">
      <div class="card-head"><h3>Daily questions</h3><span class="muted">${st.todayN ? pct(st.todayOk, st.todayN) + '% correct' : ''}</span></div>
      <div class="big">${st.todayN}<span> / ${goal}</span></div>${bar(pct(st.todayN, goal), st.todayN >= goal ? 'ok' : '')}
      <div class="row gap">
        <button class="btn primary" data-act="quickPractice">Practise 20 mixed</button>
        <button class="btn" data-act="startDue" ${due ? '' : 'disabled'}>Due for revision (${due})</button>
        <button class="btn" data-act="startMistakes" ${st.mistakes ? '' : 'disabled'}>Mistakes (${st.mistakes})</button>
      </div>
    </div>
    <div class="card ${bw.due ? 'due' : ''}">
      <div class="card-head"><h3>Biweekly test</h3><span class="pill ${bw.due ? 'warn' : ''}">${bw.due ? 'Due now' : bw.last ? `Next in ${bw.nextIn} day${bw.nextIn === 1 ? '' : 's'}` : 'Not taken yet'}</span></div>
      <p class="muted">Timed like AMC (84 s per question). Covers topics you finished in the last two weeks, with your past mistakes weighted in.${bw.newSince ? ` <b>${bw.newSince}</b> topic${bw.newSince === 1 ? '' : 's'} finished since the last one.` : ''}</p>
      <button class="btn ${bw.due ? 'primary' : ''}" data-act="startBiweekly" ${bw.anyDone ? '' : 'disabled'}>Start biweekly test</button>
    </div>
  </section>
  <section class="card">
    <div class="card-head"><h3>Up next</h3>
      <select data-change="setFocus" class="select-sm">${SYS_LIST.map(s => `<option value="${s.code}" ${s.code === focus ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
    </div>
    ${lastTopic ? `<a class="continue" href="#/topic/${lastTopic.id}"><span class="eyebrow">Continue</span><b>${esc(lastTopic.name)}</b><span class="chev">›</span></a>` : ''}
    <div class="list">${next.length ? next.map(t => topicRow(t, st, sheetSet)).join('') : `<p class="muted pad">All topics in ${sysName(focus)} are done. Pick another system.</p>`}</div>
  </section>
  ${weak.length ? `<section class="card"><div class="card-head"><h3>Weakest topics</h3><span class="muted">≥ 5 questions answered</span></div><div class="list">${weak.map(x => topicRow(x.t, st, sheetSet)).join('')}</div></section>` : ''}
  ${qc && (qc.pending || qc.running) ? `<section class="card"><div class="card-head"><h3>Working in the background</h3><a href="#/library" class="link">Library ›</a></div><p class="muted">${qc.pending + qc.running} jobs left. ${esc(Queue.status.ai || Queue.status.local || Queue.pauseMsg || '')}</p></section>` : ''}
  ${!books && !sheets.length ? `<section class="card soft"><h3>Getting started</h3><p class="muted">On your laptop, open <a href="#/library" class="link">Library</a> and drop in all your books at once. On your phone and iPad, turn on Sync in <a href="#/settings" class="link">Settings</a> — everything the laptop generates will appear here.</p></section>` : ''}
  </div>`;
};

function topicRow(t, st, sheetSet) {
  const b = st?.by[t.id];
  return `<a class="topic-row" href="#/topic/${t.id}">
    <span class="tick ${t.done ? 'on' : ''}">${t.done ? '✓' : ''}</span>
    <div class="tr-main"><div class="tr-name">${esc(t.name)}</div>
    <div class="tr-meta">${sheetSet?.has(t.id) ? '<span class="dotlabel ok">Sheet ready</span>' : '<span class="dotlabel">No sheet yet</span>'}${b ? ` · ${b.n} answered · ${accTxt(b)}` : ''}</div></div>
    <span class="chev">›</span></a>`;
}

// ---------------- Systems ----------------
Views.systems = async () => {
  const [topics, st, prefs] = await Promise.all([DB.live('topics'), loadStats(), Prefs.get()]);
  const cards = SYS_LIST.map(s => {
    const ts = topics.filter(t => t.system === s.code), done = ts.filter(t => t.done).length;
    const target = prefs.targets?.[s.code];
    let pace = '';
    if (target) {
      const days = daysUntil(target), left = ts.length - done;
      pace = days > 0 ? `${(left / Math.max(1, days / 7)).toFixed(1)} topics/week to hit ${new Date(target + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : left ? 'Target date passed' : 'Target met';
    }
    return `<a class="card sys-card" href="#/system/${s.code}">
      <div class="card-head"><h3>${s.name}</h3><span class="muted">${done}/${ts.length}</span></div>
      ${bar(pct(done, ts.length), done === ts.length && ts.length ? 'ok' : '')}
      <div class="sys-meta"><span>${pace || 'No target date'}</span><span>Accuracy ${accTxt(st.by['sys:' + s.code])}</span></div></a>`;
  }).join('');
  const all = topics.length, done = topics.filter(t => t.done).length;
  return `<div class="page"><header class="page-head"><div><p class="eyebrow">${done} of ${all} topics done</p><h1>Systems</h1></div></header>${bar(pct(done, all), 'thick')}<section class="grid-3 mt">${cards}</section></div>`;
};

function planDayRow(d, showSys) {
  const date = new Date(d.date + 'T00:00:00');
  const label = d.date === todayStr() ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const body = d.kind === 'biweekly' ? '<span class="pill warn">Biweekly test + revise mistakes</span>'
    : d.kind === 'revision' ? '<span class="pill">Deadline — revise the system & take a full system test</span>'
    : d.kind === 'off' ? '<span class="muted small">Day off</span>'
    : d.topics.length ? d.topics.map(t => `<a class="chip ${t.done ? 'on' : ''}" href="#/topic/${t.id}">${t.done ? '✓ ' : ''}${esc(t.name)}</a>`).join('') : '<span class="muted small">Catch-up / revision</span>';
  return `<div class="plan-day ${d.date === todayStr() ? 'today' : ''}"><div class="pd-date">${label}${showSys ? `<small>${sysName(showSys)}</small>` : ''}</div><div class="chips">${body}</div></div>`;
}

function planCard(code, plan, prefs) {
  const head = `<div class="card-head"><h3>Study plan</h3><div class="row gap wrap">
      <label class="inline small">Start <input type="date" value="${prefs.starts?.[code] || ''}" data-change="setStart" data-sys="${code}"></label>
      <label class="inline small">Deadline <input type="date" value="${prefs.targets?.[code] || ''}" data-change="setTarget" data-sys="${code}"></label>
      <label class="inline small">Order <select data-change="setPlanOrder" data-sys="${code}"><option value="book" ${prefs.planOrder?.[code] === 'weight' ? '' : 'selected'}>Book order</option><option value="weight" ${prefs.planOrder?.[code] === 'weight' ? 'selected' : ''}>Most important first</option></select></label></div></div>`;
  if (!plan) return `<section class="card mt">${head}<p class="muted">Set a deadline and the app spreads this system's topics over the days until then — keeping biweekly test days and a final revision day free.</p></section>`;
  const showAll = sessionStorage.getItem('planAll') === code;
  const days = showAll ? plan.days : plan.days.slice(0, 14);
  const summary = plan.overdue ? `<span class="warn-t">Deadline passed with ${plan.left} topics left — pick a new date.</span>`
    : `${plan.left} topics left · ${plan.studyDays} study days · <b>${plan.pace.toFixed(1)} topics a day</b>${plan.pace > 3 ? ' — that is heavy; consider a later deadline.' : ''}`;
  return `<section class="card mt">${head}<p class="muted">${summary}</p>
    <div class="plan">${days.map(d => planDayRow(d)).join('')}</div>
    ${plan.days.length > 14 ? `<button class="btn ghost full" data-act="planAll" data-sys="${code}">${showAll ? 'Show less' : `Show all ${plan.days.length} days`}</button>` : ''}
    <p class="muted small mt">The plan re-balances itself every day: if you fall behind or get ahead, the remaining topics are spread over the days left. Days off: Settings → Targets.</p></section>`;
}

// Which topics the question banks (AMC recalls, AMEDEX — the past-paper trend) ask about most.
async function topicWeights(code) {
  const all = await DB.all('mcqs'); const w = {};
  all.forEach(m => { if (m.deleted || m.merged || m.src === 'ai' || !m.topicId || (code && m.system !== code)) return; w[m.topicId] = (w[m.topicId] || 0) + 1; });
  return w;
}
function weightCard(ts, w, st) {
  const rows = ts.map(t => ({ t, n: w[t.id] || 0 })).filter(x => x.n).sort((a, b) => b.n - a.n);
  if (!rows.length) return `<section class="card mt"><h3>What to master first</h3><p class="muted">Appears once question-bank questions have been imported for this system.</p></section>`;
  const max = rows[0].n, showAll = sessionStorage.getItem('wAll') === '1', list = showAll ? rows : rows.slice(0, 12);
  return `<section class="card mt"><div class="card-head"><h3>What to master first</h3><span class="muted small">by number of past-exam-style questions</span></div>
    <div class="wlist">${list.map(({ t, n }, i) => { const b = st?.by[t.id]; const acc = b ? pct(b.ok, b.n) : null;
      return `<a class="wrow" href="#/topic/${t.id}"><span class="wrank">${i + 1}</span><span class="wname">${esc(t.name)} <b>(${n})</b>${t.done ? ' <span class="dotlabel ok">done</span>' : ''}</span>
        <span class="wbar"><i style="width:${Math.max(4, Math.round(n / max * 100))}%"></i></span><span class="wacc ${acc == null ? '' : acc >= 60 ? 'good' : 'low'}">${acc == null ? '—' : acc + '%'}</span></a>`; }).join('')}</div>
    ${rows.length > 12 ? `<button class="btn ghost full" data-act="wAll">${showAll ? 'Show top 12' : `Show all ${rows.length} topics`}</button>` : ''}
    <p class="muted small mt">Counts come from your question banks (AMEDEX, AMC recalls), which follow past-paper trends. The % is your accuracy on that topic.</p></section>`;
}

Views.system = async (code) => {
  const [topics, st, prefs, books, sheets] = await Promise.all([DB.live('topics'), loadStats(), Prefs.get(), hasBooks(), DB.all('sheets')]);
  const plan = await buildPlan(code, prefs, topics);
  const weights = await topicWeights(code);
  const sheetSet = new Set(sheets.map(s => s.id));
  const filter = sessionStorage.getItem('tfilter') || 'all';
  const ts = topics.filter(t => t.system === code).sort((a, b) => a.order - b.order);
  const shown = ts.filter(t => filter === 'left' ? !t.done : filter === 'done' ? t.done : true);
  const done = ts.filter(t => t.done).length;
  const missing = ts.filter(t => !sheetSet.has(t.id)).length;
  return `<div class="page">
  <header class="page-head"><div><p class="eyebrow"><a href="#/systems" class="link">Systems</a> / ${done} of ${ts.length} done · accuracy ${accTxt(st.by['sys:' + code])}</p><h1>${sysName(code)}</h1></div>
    <div class="row gap wrap">
      <button class="btn primary" data-act="practiseSystem" data-sys="${code}">Practise this system</button>
      ${books ? `<button class="btn" data-act="genSystem" data-sys="${code}" ${missing ? '' : 'disabled'}>${missing ? `Generate ${missing} missing topic${missing === 1 ? '' : 's'}` : 'All sheets generated'}</button>` : ''}
    </div></header>
  ${bar(pct(done, ts.length), 'thick')}
  <div class="row gap wrap mt between">
    <div class="chips">${[['all', 'All'], ['left', 'Leftover'], ['done', 'Done']].map(([k, l]) => `<button class="chip ${filter === k ? 'on' : ''}" data-act="topicFilter" data-f="${k}">${l}</button>`).join('')}</div>
  </div>
  ${weightCard(ts, weights, st)}
  ${planCard(code, plan, prefs)}
  <section class="card flush mt"><div class="list">${shown.map(t => topicRow(t, st, sheetSet)).join('') || '<p class="muted pad">Nothing here.</p>'}</div>
  <button class="btn ghost full" data-act="addTopic" data-sys="${code}">+ Add a topic</button></section>
  </div>`;
};

// ---------------- Topic ----------------
const TOPIC_TABS = [...Object.entries(SECTIONS), ['compare', 'AMC changes'], ['mcqs', 'MCQs'], ['notes', 'Notes'], ['ask', 'Ask AI']];

Views.topic = async (id, tab) => {
  const t = await DB.get('topics', id);
  if (!t) return empty('Topic not found', 'It may have been deleted.', '<a class="btn" href="#/systems">Back to systems</a>');
  localStorage.setItem('lastTopic', id);
  tab = tab || localStorage.getItem('lastTab') || 'patho';
  if (!TOPIC_TABS.some(([k]) => k === tab)) tab = 'patho';
  localStorage.setItem('lastTab', tab);
  const [sheet, books, mcqs, st, queue] = await Promise.all([DB.get('sheets', id), hasBooks(), DB.byIndex('mcqs', 'topicId', id), loadStats(), DB.all('queue')]);
  const live = mcqs.filter(m => !m.deleted && !m.flagged && !m.merged);
  const inQueue = queue.filter(j => j.payload?.topicId === id && j.status !== 'done');
  let body = '';
  if (SECTIONS[tab]) body = sectionTab(t, sheet, tab, books, inQueue);
  else if (tab === 'compare') body = compareTab(t, sheet, books, inQueue);
  else if (tab === 'mcqs') body = mcqTab(t, live, mcqs, st, books, inQueue);
  else if (tab === 'notes') body = await notesTab(t);
  else if (tab === 'ask') body = await askTab(t);
  return `<div class="page topic-page">
  <header class="page-head"><div><p class="eyebrow"><a href="#/system/${t.system}" class="link">${sysName(t.system)}</a>${t.done ? ` · finished ${fmtDate(t.doneAt)}` : ''}</p><h1>${esc(t.name)}</h1></div>
    <div class="row gap wrap">
      ${t.done ? `<button class="btn primary" data-act="testTopic" data-id="${id}">Test me again</button><button class="btn" data-act="undoneTopic" data-id="${id}">Mark not done</button>`
               : `<button class="btn primary" data-act="doneTopic" data-id="${id}">I've finished this topic → test me</button>`}
      <button class="btn icon" data-act="topicMenu" data-id="${id}" aria-label="More">⋯</button>
    </div></header>
  <nav class="tabs" role="tablist">${TOPIC_TABS.map(([k, l]) => `<a class="tab ${k === tab ? 'on' : ''} ${k === 'compare' ? 'tab-amc' : ''}" href="#/topic/${id}/${k}">${l}${k === 'mcqs' ? ` <small>${live.length}</small>` : ''}</a>`).join('')}</nav>
  <div class="tab-body">${body}</div></div>`;
};

// Honest status of this topic's background jobs: writing, waiting (and why), or failed (with the reason).
function jobStatusBox(jobs) {
  const j = jobs.find(x => x.kind === 'sheet') || jobs[0];
  const what = j.kind === 'sheet' ? 'This topic’s sheet' : 'New questions for this topic';
  let title, msg;
  if (j.status === 'failed') { title = 'Writing failed'; msg = `${what} couldn’t be written: ${esc(j.error || 'unknown error')}`; }
  else if (j.status === 'running') { title = 'Being written now'; msg = `${what} is being written right now — it appears here in a minute or two.`; }
  else {
    const until = Queue.paused.ai || 0, mistral = Providers.active().some(p => p.id === 'mistral');
    title = 'Waiting in line';
    msg = Date.now() < until
      ? `Gemini has used today’s free allowance (back around ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).${mistral ? ' Mistral is taking over and will write it as soon as it’s free.' : ' Add a free Mistral key in Settings so it can take over.'}`
      : `${what} is next in line for Gemini.`;
  }
  return empty(title, msg, `<div class="row gap center"><button class="btn primary" data-act="retryTopicJobs" data-ids="${jobs.map(x => x.id).join(',')}">Try again now</button><a class="btn" href="#/library">See queue</a></div>`);
}

function noSheet(t, books, inQueue) {
  if (inQueue.length) return jobStatusBox(inQueue);
  return books
    ? empty('No sheet yet', 'Generate it from your uploaded books. It takes about a minute.', `<button class="btn primary" data-act="genTopic" data-id="${t.id}">Generate sheet & MCQs</button>`)
    : empty('No sheet yet', 'Your books live on your laptop. Generate this topic there and it will sync here.', '');
}

function colBooks(sheet, c) {
  return [...new Set((sheet.sources || []).filter(s => s.col === c).map(s => s.book))].join(', ') || 'general knowledge';
}

function sectionTab(t, sheet, sec, books, inQueue) {
  if (!sheet) return noSheet(t, books, inQueue);
  const editing = Views._edit === t.id + sec;
  const cols = ['ref', 'mbbs', 'amc'].map(c => `<section class="col col-${c}">
      <header><span class="dot"></span><b>${COLS[c].label}</b><small>${esc(colBooks(sheet, c))}</small></header>
      ${editing ? `<textarea class="edit" data-col="${c}" rows="14">${esc(asText(sheet.sections?.[sec]?.[c]))}</textarea>`
                : `<div class="read">${md(sheet.sections?.[sec]?.[c]) || '<p class="muted">Not covered.</p>'}</div>`}
    </section>`).join('');
  return `<div class="row between mb"><h2 class="h2">${SECTIONS[sec]}</h2>
    <div class="row gap">${editing ? `<button class="btn" data-act="cancelEdit">Cancel</button><button class="btn primary" data-act="saveEdit" data-id="${t.id}" data-sec="${sec}">Save</button>`
      : `<button class="btn ghost" data-act="editSheet" data-id="${t.id}" data-sec="${sec}">Edit</button>`}</div></div>
    <div class="cols3">${cols}</div>
    ${sheet.comparison?.bottomLine && sec === 'management' ? `<a class="callout amc mt" href="#/topic/${t.id}/compare"><b>What changes for AMC</b><p>${esc(sheet.comparison.bottomLine)}</p><span class="link">Open comparison ›</span></a>` : ''}`;
}

function comparisonHTML(sheet, compact = false) {
  const c = sheet?.comparison || {};
  const rows = (c.rows || []).map(r => `<div class="cmp-row">
      <div class="cmp-aspect">${esc(r.aspect)}</div>
      <div class="cmp-in"><span class="cmp-l">India</span>${md(r.india)}</div>
      <div class="cmp-au"><span class="cmp-l">Australia</span>${md(r.australia)}</div>
      ${r.trap ? `<div class="cmp-trap"><span class="cmp-l">Exam trap</span>${md(r.trap)}</div>` : ''}
    </div>`).join('');
  return `<div class="callout amc"><b>Bottom line for AMC</b>${md(c.bottomLine) || '<p class="muted">—</p>'}</div>
    <div class="cmp ${compact ? 'compact' : ''}"><div class="cmp-row cmp-headrow"><div>Aspect</div><div>Indian MBBS answer</div><div>Australian / AMC answer</div><div>How AMC tests it</div></div>${rows || '<p class="muted pad">No differences listed.</p>'}</div>
    ${c.mustKnow?.length ? `<h4 class="mt">Australia-only must-knows</h4><div class="read">${md(c.mustKnow)}</div>` : ''}
    ${c.same ? `<h4 class="mt">Same in both — skip</h4><div class="read">${md(c.same)}</div>` : ''}`;
}

function compareTab(t, sheet, books, inQueue) {
  if (!sheet) return noSheet(t, books, inQueue);
  return `<div class="row between mb"><h2 class="h2">AMC changes</h2><span class="muted small">Read this right after your notes — no need to reread the topic in Murtagh.</span></div>${comparisonHTML(sheet)}`;
}

function mcqTab(t, live, all, st, books, inQueue) {
  const n = k => live.filter(m => m.type === k).length;
  const flagged = all.filter(m => m.flagged && !m.deleted).length;
  const merged = all.filter(m => m.merged && !m.deleted), combined = all.filter(m => m.src === 'merged' && !m.deleted);
  const b = st.by[t.id];
  return `<div class="grid-2">
    <div class="card"><h3>Practise this topic</h3>
      <p class="muted">${live.length} questions · ${n('AMC')} AMC · ${n('MBBS')} MBBS · ${n('IMG')} image · your accuracy ${accTxt(b)}</p>
      <div class="row gap wrap">
        <button class="btn primary" data-act="practiseTopic" data-id="${t.id}" data-type="ALL" ${live.length ? '' : 'disabled'}>All mixed</button>
        <button class="btn" data-act="practiseTopic" data-id="${t.id}" data-type="AMC" ${n('AMC') ? '' : 'disabled'}>AMC only</button>
        <button class="btn" data-act="practiseTopic" data-id="${t.id}" data-type="MBBS" ${n('MBBS') ? '' : 'disabled'}>MBBS only</button>
        <button class="btn" data-act="practiseTopic" data-id="${t.id}" data-type="IMG" ${n('IMG') ? '' : 'disabled'}>Images only</button>
      </div></div>
    <div class="card"><h3>Shrink & combine</h3>
      <p class="muted">${merged.length ? `${merged.length} questions folded into ${combined.length} combined ones (originals hidden). ` : ''}Fuses overlapping <b>AI-written</b> questions into fewer, harder vignettes. Questions from AMEDEX and your books are always kept exactly as they are.</p>
      <div class="row gap wrap">${AI.key ? `<button class="btn" data-act="mergeTopic" data-id="${t.id}" ${live.length >= 4 && !inQueue.some(j => j.kind === 'merge') ? '' : 'disabled'}>${inQueue.some(j => j.kind === 'merge') ? 'Combining…' : 'Combine overlapping questions'}</button>` : '<span class="muted small">Add your Gemini key in Settings to use this.</span>'}
      ${merged.length ? `<button class="btn ghost" data-act="unmergeTopic" data-id="${t.id}">Undo combining</button>` : ''}</div></div>
    <div class="card"><h3>More questions</h3>
      ${inQueue.length ? `<div class="mt">${jobStatusBox(inQueue)}</div>` : `<p class="muted">${books ? 'Write 10 new AMC + 8 MBBS questions from your books (no repeats).' : 'Generate more on your laptop — they sync here.'}</p>`}
      ${books && !inQueue.length ? `<button class="btn" data-act="moreMcqs" data-id="${t.id}">+ Write more MCQs</button>` : ''}
      ${flagged ? `<p class="muted small mt">${flagged} flagged question${flagged === 1 ? '' : 's'} hidden from practice. <button class="link" data-act="unflagAll" data-id="${t.id}">Restore</button></p>` : ''}
    </div></div>`;
}

async function notesTab(t) {
  const note = await getNote(t.id);
  const items = [];
  for (const it of note.items || []) { const m = await DB.get('media', it.mediaId); if (m) items.push({ ...it, data: m.data }); }
  return `<div class="notes-grid">
    <div class="card"><div class="card-head"><h3>Typed notes</h3><span class="muted small" id="note-saved"></span></div>
      <textarea id="note-text" data-input="saveNote" data-id="${t.id}" rows="12" placeholder="High-yield points, mnemonics, what you got wrong…">${esc(note.text)}</textarea></div>
    <div class="card"><div class="card-head"><h3>Handwriting</h3>
      <div class="row gap pad-tools">
        ${['#1d2125', '#2f5fa3', '#b4473c', '#3f7a52'].map(c => `<button class="swatch" style="--c:${c}" data-act="penColor" data-c="${c}" aria-label="colour"></button>`).join('')}
        <button class="btn sm" data-act="penEraser">Eraser</button><button class="btn sm" data-act="penUndo">Undo</button><button class="btn sm" data-act="penClear">Clear</button>
      </div></div>
      <canvas id="pad" class="inkpad"></canvas>
      <div class="row gap mt"><button class="btn primary" data-act="saveSketch" data-id="${t.id}">Save page</button>
        <label class="btn">Upload photos<input type="file" accept="image/*" multiple hidden data-change="addPhotos" data-id="${t.id}"></label>
        <label class="btn">Take photo<input type="file" accept="image/*" capture="environment" hidden data-change="addPhotos" data-id="${t.id}"></label></div>
    </div></div>
    ${items.length ? `<section class="card mt"><h3>Saved pages & photos</h3><div class="gallery">${items.map((it, i) => `<figure><img src="${it.data}" data-act="zoomImg" loading="lazy"><button class="x" data-act="delNoteItem" data-id="${t.id}" data-i="${i}" aria-label="Delete">×</button></figure>`).join('')}</div></section>` : ''}`;
}

async function askTab(t) {
  const note = await getNote(t.id);
  const thread = (note.doubts || []).slice(-20).map(d => `<div class="qa"><div class="qa-q">${esc(d.q)}</div><div class="qa-a read">${md(d.a)}</div></div>`).join('');
  return `<div class="card"><h3>Ask about ${esc(t.name)}</h3>
    <p class="muted small">Answers use this topic's sheet, and say clearly when Indian and Australian practice differ.</p>
    <div class="thread">${thread || '<p class="muted">No questions yet.</p>'}</div>
    <form class="ask" data-submit="askDoubt" data-id="${t.id}"><textarea name="q" rows="2" placeholder="e.g. Why tenecteplase over streptokinase in rural Australia?"></textarea><button class="btn primary">Ask</button></form></div>`;
}

// ---------------- Session (split screen) ----------------
Views.session = async () => {
  const s = Practice.s;
  if (!s) return empty('No test running', 'Start one from a topic, Practice, or Today.', '<a class="btn primary" href="#/practice">Go to Practice</a>');
  if (s.finished) return resultsView(s);
  const m = await DB.get('mcqs', s.qs[s.idx]);
  if (!m) { s.qs.splice(s.idx, 1); Practice.save(); return Views.session(); }
  const topic = s.topicId ? await DB.get('topics', s.topicId) : null;
  const sheet = s.topicId ? await DB.get('sheets', s.topicId) : null;
  const img = m.img ? (await DB.get('media', m.img))?.data : null;
  const a = s.ans[m.id];
  const revealed = s.mode === 'tutor' && !!a;
  const chosen = a ? a.c : s.sel;
  const multi = isMulti(m), right = correctSet(m), chosenArr = chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen];
  const opts = m.options.map((o, i) => {
    let cls = '';
    if (revealed) { if (right.includes(i)) cls = 'right'; else if (chosenArr.includes(i)) cls = 'wrong'; else cls = 'dim'; }
    else if (chosenArr.includes(i)) cls = 'sel';
    return `<button class="opt ${cls}" data-act="pick" data-i="${i}" ${revealed ? 'disabled' : ''}><span class="opt-l">${String.fromCharCode(65 + i)}</span><span class="opt-t">${esc(o)}</span></button>`;
  }).join('');
  const last = s.idx === s.qs.length - 1;
  const nav = s.qs.map((id, i) => `<button class="navq ${i === s.idx ? 'cur' : ''} ${s.ans[id] ? (s.mode === 'tutor' ? (s.ans[id].ok ? 'ok' : 'bad') : 'done') : ''}" data-act="gotoQ" data-i="${i}">${i + 1}</button>`).join('');
  const leftTab = sessionStorage.getItem('leftTab') || 'compare';
  const left = sheet ? `<div class="seg">${[['compare', 'AMC changes'], ['management', 'Management'], ['pearls', 'Pearls']].map(([k, l]) => `<button class="${leftTab === k ? 'on' : ''}" data-act="leftTab" data-k="${k}">${l}</button>`).join('')}</div>
      <div class="guide">${leftTab === 'compare' ? comparisonHTML(sheet, true) : ['ref', 'mbbs', 'amc'].map(c => `<div class="col col-${c} mini"><header><span class="dot"></span><b>${COLS[c].label}</b></header><div class="read">${md(sheet.sections?.[leftTab]?.[c])}</div></div>`).join('')}</div>`
    : `<h3>Questions</h3><div class="navgrid">${nav}</div><p class="muted small mt">${s.mode === 'exam' ? 'Exam mode — answers and explanations at the end.' : 'Tutor mode — explanation after each answer.'}</p>`;
  const pane = sessionStorage.getItem('pane') || 'q';
  return `<div class="session pane-${pane}">
    <div class="session-bar">
      <div><p class="eyebrow">${esc(s.title)}</p><b>Question ${s.idx + 1} of ${s.qs.length}</b></div>
      <div class="row gap">${s.limit ? `<span class="timer" id="timer"></span>` : ''}
      <div class="seg only-mobile"><button class="${pane === 'guide' ? 'on' : ''}" data-act="pane" data-p="guide">${sheet ? 'AMC guide' : 'Overview'}</button><button class="${pane === 'q' ? 'on' : ''}" data-act="pane" data-p="q">Question</button></div>
      <button class="btn sm" data-act="endSession">${s.mode === 'exam' ? 'Finish test' : 'End'}</button></div>
    </div>
    ${bar(pct(Object.keys(s.ans).length, s.qs.length))}
    <div class="split">
      <aside class="split-left card">${left}</aside>
      <main class="split-right">
        <div class="q-card card">
          <div class="row between"><span class="tag tag-${m.type.toLowerCase()}">${TYPE_LABEL[m.type] || m.type}</span><span class="muted small">${esc(m.src && m.src !== 'ai' ? m.src : sysName(m.system))}</span></div>
          ${img ? `<figure class="q-img"><img src="${img}" data-act="zoomImg" alt="Question image"></figure>` : ''}
          <div class="q-stem">${md(m.stem)}</div>
          ${multi ? '<p class="pill warn">More than one answer — select all that apply</p>' : ''}
          <div class="opts">${opts}</div>
          ${revealed ? `<div class="expl ${a.ok ? 'ok' : 'bad'}"><b>${a.ok ? 'Correct' : 'Not quite — answer ' + letters(right)}</b>${md(m.expl)}${m.cite ? `<p class="muted small">Source: ${esc(m.cite)}</p>` : ''}${!a.ok ? masterBlock(m, a.c) : ''}${m.keyedBy === 'ai' && m.src !== 'ai' ? '<p class="muted small">Answer chosen by AI (the book had no key on these pages).</p>' : ''}
            <div class="row gap mt"><button class="btn sm" data-act="askQ">Ask AI about this</button><button class="btn sm ghost" data-act="flagQ">Flag bad question</button></div></div>` : ''}
          <div class="q-nav">
            <button class="btn" data-act="prevQ" ${s.idx ? '' : 'disabled'}>Back</button>
            ${s.mode === 'tutor' && !revealed ? `<button class="btn primary" data-act="checkQ" ${chosenArr.length ? '' : 'disabled'}>Check answer</button>`
              : last ? `<button class="btn primary" data-act="endSession">See results</button>` : `<button class="btn primary" data-act="nextQ">Next</button>`}
          </div>
        </div>
        ${sheet ? `<div class="card navcard"><div class="navgrid">${nav}</div></div>` : ''}
      </main>
    </div></div>`;
};

// "Where to master this" box shown under a wrong answer.
function masterBlock(m, chosen) {
  const ms = m.master;
  const c = chosen == null ? '' : JSON.stringify(Array.isArray(chosen) ? chosen : [chosen]);
  const link = r => `<button class="linkbtn" data-act="openRef" data-book="${r.bookId}" data-size="${r.size || ''}" data-p="${r.p}">${esc(r.book)} p.${r.p}</button>`;
  if (!ms) return `<div class="master" id="master-${m.id}">${m.masterLine ? `<p><b>Master this:</b> ${esc(m.masterLine)}</p>` : ''}${m.refs?.length ? `<p class="small"><b>Read first:</b> ${m.refs.map(link).join(' · ')}</p>` : ''}<button class="btn sm primary" data-act="masterQ" data-id="${m.id}" data-ch='${c}'>Where do I master this?</button></div>`;
  return `<div class="master" id="master-${m.id}"><p class="eyebrow">Master this so it can’t trap you again</p>
    ${ms.points?.length ? `<ul>${ms.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${ms.trap ? `<p class="small"><b>The trap:</b> ${esc(ms.trap)}</p>` : ''}
    ${ms.read?.length ? `<p class="small"><b>Read first:</b> ${ms.read.map(r => `${link(r)}${r.why ? ` <span class="muted">— ${esc(r.why)}</span>` : ''}`).join(' · ')}</p>` : ''}</div>`;
}

async function resultsView(s) {
  const test = await DB.get('tests', s.testId);
  if (!test) { Practice.clear(); return empty('Results not found', '', '<a class="btn" href="#/practice">Practice</a>'); }
  return renderResults(test, true);
}

async function renderResults(test, live = false) {
  const p = pct(test.correct, test.total);
  const rows = [];
  for (const id of test.qs) {
    const m = await DB.get('mcqs', id); if (!m) continue;
    const c = test.ans[id]; const ok = c != null && isRight(m, c); const rs = correctSet(m), cs = c == null ? [] : Array.isArray(c) ? c : [c];
    rows.push(`<details class="rev ${c == null ? 'skip' : ok ? 'ok' : 'bad'}"><summary><span class="mark">${c == null ? '–' : ok ? '✓' : '✗'}</span><span class="rev-stem">${esc(m.stem.slice(0, 140))}${m.stem.length > 140 ? '…' : ''}</span></summary>
      <div class="rev-body">${md(m.stem)}<ol type="A" class="rev-opts">${m.options.map((o, i) => `<li class="${rs.includes(i) ? 'right' : cs.includes(i) ? 'wrong' : ''}">${esc(o)}</li>`).join('')}</ol>${md(m.expl)}${c != null && !ok ? masterBlock(m, c) : ''}</div></details>`);
  }
  const chip = (k, v) => `<span class="pill">${k}: ${v[0]}/${v[1]} (${pct(v[0], v[1])}%)</span>`;
  const wrong = test.qs.filter(id => test.ans[id] != null).length - test.correct;
  return `<div class="page">
    <header class="page-head"><div><p class="eyebrow">${esc(test.title)} · ${fmtDate(test.date)}</p><h1>Results</h1></div>
    <div class="row gap">${live ? '<button class="btn primary" data-act="closeResults">Done</button>' : '<a class="btn" href="#/progress">Back</a>'}</div></header>
    <section class="grid-3">
      <div class="card count"><p class="eyebrow">Score</p><div class="big ${p >= 60 ? 'good' : 'low'}">${p}<span>%</span></div><p class="muted">${test.correct} of ${test.total} correct${test.answered < test.total ? ` · ${test.total - test.answered} unanswered` : ''}</p></div>
      <div class="card count"><p class="eyebrow">Time</p><div class="big">${fmtDur(test.duration)}</div><p class="muted">${Math.round(test.duration / Math.max(1, test.total))} s per question (AMC pace: 84 s)</p></div>
      <div class="card"><p class="eyebrow">Breakdown</p><div class="chips mt">${Object.entries(test.byType || {}).map(([k, v]) => chip(TYPE_LABEL[k] || k, v)).join('')}</div><div class="chips mt">${Object.entries(test.bySystem || {}).map(([k, v]) => chip(sysName(k), v)).join('')}</div></div>
    </section>
    <section class="card mt"><div class="card-head"><h3>AI review of your mistakes</h3>
      <div class="row gap"><button class="btn" data-act="retryWrong" data-test="${test.id}" ${wrong ? '' : 'disabled'}>Retry wrong ones</button><button class="btn primary" data-act="aiReview" data-test="${test.id}" ${wrong ? '' : 'disabled'}>Analyse my mistakes</button></div></div>
      <div id="ai-review" class="read">${test.review ? md(test.review) : `<p class="muted">${wrong ? 'Get a short analysis of the pattern behind what you got wrong and exactly what to revise.' : 'No mistakes — nothing to analyse.'}</p>`}</div></section>
    <section class="card mt"><h3>All questions</h3><div class="revlist">${rows.join('')}</div></section></div>`;
}

// ---------------- Practice ----------------
Views.practice = async () => {
  const [st, bw, tests, all, dueS] = await Promise.all([loadStats(), biweeklyStatus(), DB.live('tests'), DB.live('mcqs'), dueSet()]);
  const mcqs = all.filter(m => !m.merged);
  const counts = {}; mcqs.forEach(m => { counts[m.system] = (counts[m.system] || 0) + 1; });
  const f = JSON.parse(localStorage.getItem('pform') || '{}');
  const sel = new Set(f.systems || []);
  const recent = tests.sort((a, b) => b.date - a.date).slice(0, 8);
  return `<div class="page"><header class="page-head"><div><p class="eyebrow">${mcqs.length} questions in your bank</p><h1>Practice</h1></div></header>
  <section class="grid-2">
    <div class="card ${bw.due ? 'due' : ''}"><div class="card-head"><h3>Biweekly test</h3><span class="pill ${bw.due ? 'warn' : ''}">${bw.due ? 'Due now' : bw.last ? 'Next in ' + bw.nextIn + ' days' : 'Not taken yet'}</span></div>
      <p class="muted">Timed exam on everything you finished recently.</p><button class="btn primary" data-act="startBiweekly" ${bw.anyDone ? '' : 'disabled'}>Start</button></div>
    <div class="card"><div class="card-head"><h3>Due for revision</h3><span class="pill ${dueS.size ? 'warn' : ''}">${dueS.size}</span></div>
      <p class="muted">Spaced repetition: questions come back after 1, 3, 7, 16, 35 and 90 days while you keep getting them right; wrong ones return the next day.</p><button class="btn ${dueS.size ? 'primary' : ''}" data-act="startDue" ${dueS.size ? '' : 'disabled'}>Revise now</button></div>
    <div class="card"><div class="card-head"><h3>Mistake bank</h3><span class="pill">${st.mistakes}</span></div>
      <p class="muted">Questions whose last attempt was wrong. Get them right to clear them.</p><button class="btn" data-act="startMistakes" ${st.mistakes ? '' : 'disabled'}>Review mistakes</button></div>
  </section>
  <form class="card mt" data-submit="customPractice">
    <h3>Build a set</h3>
    <p class="label">Systems <button type="button" class="link small" data-act="pickAllSys">all / none</button></p>
    <div class="chips">${SYS_LIST.map(s => `<label class="chip check ${sel.has(s.code) ? 'on' : ''}"><input type="checkbox" name="sys" value="${s.code}" ${sel.has(s.code) ? 'checked' : ''} hidden>${s.name} <small>${counts[s.code] || 0}</small></label>`).join('')}</div>
    <div class="form-row mt">
      <label>Type<select name="type">${[['ALL', 'All mixed'], ['AMC', 'AMC only'], ['MBBS', 'MBBS only'], ['IMG', 'Images only']].map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Questions<select name="source">${[['all', 'Any'], ['due', 'Due for revision'], ['unseen', 'Unseen only'], ['mistakes', 'Mistakes only']].map(([v, l]) => `<option value="${v}" ${f.source === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>How many<input type="number" name="count" min="5" max="150" value="${f.count || 20}"></label>
      <label>Mode<select name="mode">${Object.entries(MODES).map(([k, m]) => `<option value="${k}" ${(f.mode || 'tutor') === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
    </div>
    <button class="btn primary mt">Start</button>
  </form>
  ${recent.length ? `<section class="card mt"><h3>Recent tests</h3><div class="list">${recent.map(t => `<a class="topic-row" href="#/result/${t.id}"><span class="score ${pct(t.correct, t.total) >= 60 ? 'good' : 'low'}">${pct(t.correct, t.total)}%</span><div class="tr-main"><div class="tr-name">${esc(t.title)}</div><div class="tr-meta">${fmtDate(t.date)} · ${t.correct}/${t.total} · ${fmtDur(t.duration)}</div></div><span class="chev">›</span></a>`).join('')}</div></section>` : ''}
  </div>`;
};

Views.result = async (id) => {
  const t = await DB.get('tests', id);
  return t ? renderResults(t) : empty('Not found', '', '');
};

// ---------------- Library (laptop) ----------------
Views.library = async () => {
  const [books, qc, est, allQ] = await Promise.all([DB.all('books'), Queue.counts(), navigator.storage?.estimate?.() || Promise.resolve(null), DB.live('mcqs')]);
  const qByBook = {}; allQ.forEach(m => { const k = (m.src || '').replace(/ p\.\d+$/, ''); qByBook[k] = (qByBook[k] || 0) + 1; });
  const ocrLeft = {}; for (const j of qc.all) if (j.kind === 'ocr' && j.status !== 'done') ocrLeft[j.payload.bookId] = (ocrLeft[j.payload.bookId] || 0) + j.payload.pages.length - (j.payload.done || []).length;
  const staged = App.staged || [];
  // Scanned pages: count real pages (jobs hold 4–10 pages each) and estimate the time left from the last hour's speed.
  let ocrBox = '';
  if (qc.byKind.ocr) {
    let tot = 0, dn = 0, failedPages = 0;
    for (const j of qc.all) if (j.kind === 'ocr') { const n = j.payload.pages.length; tot += n; if (j.status === 'done') dn += n; else { dn += (j.payload.done || []).length; if (j.status === 'failed') failedPages += n - (j.payload.done || []).length; } }
    const rate = (Queue.ocrTimes || []).filter(t => t > Date.now() - 3600e3).length, left = tot - dn;
    const eta = rate >= 5 && left ? (left / rate < 48 ? `about ${Math.ceil(left / rate)} h left` : `about ${Math.ceil(left / rate / 24)} days left`) : '';
    ocrBox = `<div class="qk"><span>Scanned pages read</span><b>${dn.toLocaleString()}</b><small>/ ${tot.toLocaleString()} pages${eta ? ' · ' + eta : ''}${failedPages ? ` · ${failedPages} to retry` : ''}</small></div>`;
  }
  const kindTotals = ocrBox + Object.entries(qc.byKind).filter(([k]) => k !== 'ocr').map(([k, v]) => `<div class="qk"><span>${JOB_LABEL[k]}</span><b>${v.done}</b><small>/ ${v.done + v.pending + v.running + v.failed}${v.failed ? ` · ${v.failed} failed` : ''}</small></div>`).join('');
  const failed = qc.all.filter(j => j.status === 'failed').slice(0, 6);
  return `<div class="page"><header class="page-head"><div><p class="eyebrow">Books stay on this device · ${est ? (est.usage / 1e9).toFixed(1) + ' GB used of ' + (est.quota / 1e9).toFixed(0) + ' GB available' : ''}</p><h1>Library</h1></div></header>
  <section class="card">
    <label class="drop" id="drop"><input type="file" multiple accept="application/pdf,image/*,.zip,.rar" hidden data-change="stageFiles">
      <b>Drop all your books here, or click to choose</b><span class="muted">PDFs (text or scanned) and photos of question-bank screens. Select everything at once — books already added are skipped.</span></label>
    <label class="btn mt">Choose a whole folder (with all its subfolders)<input type="file" webkitdirectory multiple hidden data-change="stageFiles"></label>
    ${staged.length ? `<div class="staged"><div class="row gap wrap mb"><span class="muted small">Set all to:</span><select data-change="stageRoleAll"><option value="">—</option>${Object.entries(ROLES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>${staged.map((e, i) => `<div class="stage-row">
        <input value="${esc(e.name)}" data-change="stageName" data-i="${i}" aria-label="Name">
        <select data-change="stageRole" data-i="${i}">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}" ${e.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="muted small">${e.files.length > 1 ? e.files.length + ' images' : (e.files[0].size / 1e6).toFixed(0) + ' MB'}</span>
        <button class="btn sm ghost" data-act="unstage" data-i="${i}">Remove</button></div>`).join('')}
      <p class="muted small">Check each book's type — it decides what the app does with it. Reference / MBBS / AMC books become the three columns of every sheet. MCQ books and question banks are split into questions by topic. Practical books become image questions.</p>
      <button class="btn primary" data-act="startIngest">Add ${staged.length} item${staged.length === 1 ? '' : 's'} and start processing</button></div>` : ''}
  </section>
  <section class="card mt"><div class="card-head"><h3>Background work</h3>
    <div class="row gap wrap">
      ${Queue.manualPause ? '<button class="btn" data-act="resumeQueue">Resume</button>' : '<button class="btn" data-act="pauseQueue">Pause AI</button>'}
      ${qc.failed ? `<button class="btn" data-act="retryFailed">Retry ${qc.failed} failed</button>` : ''}
      ${qc.done ? '<button class="btn ghost" data-act="clearDone">Clear finished</button>' : ''}
      <button class="btn" data-act="mergeEverything">Combine questions in every topic</button>
      <button class="btn primary" data-act="genEverything" ${books.length ? '' : 'disabled'}>Generate every topic</button>
    </div></div>
    <div class="qstatus" id="qstatus">${queueLine()}</div>
    ${kindTotals ? `<div class="qkinds">${kindTotals}</div>` : '<p class="muted">Nothing queued.</p>'}
    ${failed.length ? `<div class="failed"><p class="label">Recent failures</p>${failed.map(j => `<p class="small"><b>${JOB_LABEL[j.kind]}</b> — ${esc(j.error || '')}</p>`).join('')}</div>` : ''}
    <label class="inline small mt">Page readers on this laptop <select class="select-sm" data-change="ocrWorkers">${[[1, '1 — quiet'], [2, '2 — balanced'], [3, '3 — fastest (loud fan)']].map(([v, l]) => `<option value="${v}" ${(+localStorage.getItem('ocrWorkers') || 3) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><br>
    <label class="inline small mt"><input type="checkbox" data-change="keepAwake" ${localStorage.getItem('keepAwake') === '0' ? '' : 'checked'}> Keep the screen on while working (untick to let Windows turn the display off — set Windows “Sleep” to Never when plugged in)</label>
    <label class="inline small"><input type="checkbox" data-change="bgRun" ${localStorage.getItem('bgRun') === '0' ? '' : 'checked'}> Keep working when Chrome is minimised (the tab shows a speaker icon, but makes no sound)</label>
    <p class="muted small">Keep this tab open while it works. If a daily limit is hit, it pauses and carries on by itself later.</p>
  </section>
  <section class="card mt flush"><div class="card-head pad"><h3>Your books</h3><span class="muted">${books.length}</span></div>
    <div class="list">${books.sort((a, b) => a.role.localeCompare(b.role)).map(b => `<div class="topic-row static">
      <span class="role role-${b.role}">${ROLES[b.role]}</span>
      <div class="tr-main"><div class="tr-name">${esc(b.name)}</div><div class="tr-meta">${b.pages} pages${b.scannedPages ? ` · ${b.scannedPages} scanned` : ''}${qByBook[b.short] ? ` · <b>${qByBook[b.short]} questions imported</b>` : ''} · ${statusText(b.status)}${b.fileLost ? ' · <b class="warn-t">saved copy unreadable — add this PDF again to repair it</b>' : ''}${ocrLeft[b.id] ? ` · <b>${ocrLeft[b.id].toLocaleString()} scanned pages left to read</b> <button class="linkbtn" data-act="skipOcr" data-id="${b.id}">Skip reading</button>` : ''}${b.ocrSkipped ? ' · <span class="muted">reading skipped</span>' : ''}</div></div>
      <select class="select-sm" data-change="bookRole" data-id="${b.id}">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}" ${b.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${['ready', 'partial'].includes(b.status) ? '' : `<button class="btn sm" data-act="bookFirst" data-id="${b.id}">Do this first</button>`}
      <button class="btn sm ghost" data-act="delBook" data-id="${b.id}">Delete</button></div>`).join('') || '<p class="muted pad">No books yet.</p>'}</div></section>
  </div>`;
};
function statusText(s) { return { queued: 'waiting', reading: 'reading…', ocr: 'reading scanned pages…', importing: 'making questions…', ready: 'ready', partial: 'done, some pages failed — retry below' }[s] || s; }
function queueLine() {
  const parts = [];
  Object.entries(Queue.status).forEach(([lane, txt]) => { if (txt) parts.push(`<span class="spin"></span>${esc(txt)}`); });
  if (Queue.pauseMsg) parts.push(`<span class="warn-t">${esc(Queue.pauseMsg)}</span>`);
  if (Queue.manualPause) parts.push('<span class="warn-t">AI jobs paused.</span>');
  const hr = (Queue.ocrTimes || []).filter(t => t > Date.now() - 3600e3).length, since = Queue.startedAt ? Math.round((Date.now() - Queue.startedAt) / 60000) : 0;
  if (parts.length) parts.push(`<span class="muted small">Scanned pages read in the last hour: <b>${hr}</b>${since < 60 ? ` (app opened ${since} min ago)` : ''} · app ${APP_VERSION}</span>`);
  if (parts.length && KeepAlive.wanted() && !(KeepAlive.ctx && KeepAlive.ctx.state === 'running')) parts.push('<span class="warn-t">Click anywhere on this page once, so it keeps working when Chrome is minimised.</span>');
  return parts.join('<br>') || '<span class="muted">Idle.</span>';
}

// ---------------- Ask your books ----------------
Views.search = async () => {
  let recent = []; try { recent = JSON.parse(localStorage.getItem('recentSearch') || '[]'); } catch (e) {}
  const last = Views._lastSearch;
  return `<div class="page"><header class="page-head"><div><p class="eyebrow">Exact lines from your own books</p><h1>Ask your books</h1></div></header>
    <form class="card" data-submit="doSearch"><div class="row gap wrap"><input id="search-q" name="q" placeholder="e.g. define normal labour · stages of labour · Bishop score" value="${esc(last?.q || '')}" style="flex:1;min-width:0" autocomplete="off"><button class="btn primary">Search</button></div>
    ${recent.length ? `<div class="chips mt">${recent.map(r => `<button type="button" class="chip" data-act="searchAgain" data-q="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}</form>
    <div id="search-out" class="mt">${last ? searchResultsHtml(last) : '<p class="muted">Type what the teacher asked. You get the book’s own words with the page number, then an optional simple explanation.</p>'}</div></div>`;
};
function searchResultsHtml(r) {
  if (r.waiting) return `<p class="muted"><span class="spin"></span>${esc(r.waiting)}</p>`;
  if (!r.results?.length) return `<div class="card"><p>Nothing found for “${esc(r.q)}” in ${r.where === 'laptop' ? 'your laptop’s books' : 'the books on this device'}.</p><p class="muted small">Try fewer, simpler words (e.g. “normal labour”), or ask the AI.</p><button class="btn" data-act="explainSearch">Ask the AI anyway</button></div>`;
  return `${r.results.map(x => `<article class="card mt quote-card"><div class="row between wrap gap"><button class="linkbtn" data-act="openRef" data-book="${x.bookId}" data-size="${x.size || ''}" data-p="${x.p}">${esc(x.book)} — page ${x.p}</button><span class="role role-${x.role}">${esc(ROLES[x.role] || '')}</span></div>
      <blockquote class="bookquote">${esc(x.passage)}</blockquote>
      <button class="btn sm ghost" data-act="copyQuote" data-t="${esc(`${x.passage} (${x.book}, p.${x.p})`)}">Copy with reference</button></article>`).join('')}
    <section class="card mt"><div class="row between wrap gap"><h3>In simple words</h3><button class="btn primary sm" data-act="explainSearch">Explain with AI</button></div><div id="search-ai" class="read">${r.ai ? md(r.ai) : '<p class="muted small">Gives the exact book line first, then a simple explanation and the points examiners expect.</p>'}</div></section>`;
}

// ---------------- Progress ----------------
Views.progress = async () => {
  const [topics, st, tests, mcqs] = await Promise.all([DB.live('topics'), loadStats(), DB.live('tests'), DB.live('mcqs')]);
  const rows = SYS_LIST.map(s => {
    const ts = topics.filter(t => t.system === s.code), done = ts.filter(t => t.done).length, b = st.by['sys:' + s.code];
    return `<div class="prow"><a href="#/system/${s.code}" class="link">${s.name}</a><div>${bar(pct(done, ts.length))}<small class="muted">${done}/${ts.length} topics</small></div><div>${b ? bar(pct(b.ok, b.n), pct(b.ok, b.n) >= 60 ? 'ok' : 'low') + `<small class="muted">${accTxt(b)} of ${b.n}</small>` : '<small class="muted">no answers</small>'}</div><small class="muted">${mcqs.filter(m => m.system === s.code).length} Qs</small></div>`;
  }).join('');
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); days.push([d, st.days[todayStr(d)] || 0]); }
  const max = Math.max(10, ...days.map(x => x[1]));
  const total = st.att.length, ok = st.att.filter(a => a.correct).length;
  return `<div class="page"><header class="page-head"><div><p class="eyebrow">${total} answered · ${pct(ok, total)}% correct overall</p><h1>Progress</h1></div>
    <div class="row gap"><button class="btn" data-act="exportData">Download backup</button></div></header>
  <section class="card"><h3>Last 14 days</h3><div class="days">${days.map(([d, n]) => `<div class="day" title="${n} questions"><i style="height:${n / max * 100}%"></i><small>${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</small></div>`).join('')}</div></section>
  <section class="card mt"><div class="prow head"><span>System</span><span>Topics done</span><span>Accuracy</span><span></span></div>${rows}</section>
  <section class="card mt"><h3>Test history</h3><div class="list">${tests.sort((a, b) => b.date - a.date).slice(0, 30).map(t => `<a class="topic-row" href="#/result/${t.id}"><span class="score ${pct(t.correct, t.total) >= 60 ? 'good' : 'low'}">${pct(t.correct, t.total)}%</span><div class="tr-main"><div class="tr-name">${esc(t.title)}</div><div class="tr-meta">${fmtDate(t.date)} · ${t.correct}/${t.total} · ${t.mode === 'exam' ? 'timed' : 'tutor'}</div></div><span class="chev">›</span></a>`).join('') || '<p class="muted pad">No tests yet.</p>'}</div></section></div>`;
};

// ---------------- Settings ----------------
Views.settings = async () => {
  setTimeout(() => { const h = document.querySelector('.page-head h1'); if (h && !h.dataset.v) { h.dataset.v = 1; h.insertAdjacentHTML('beforeend', ` <small class="muted small">${APP_VERSION}</small>`); } }, 0);
  const prefs = await Prefs.get();
  const last = +localStorage.getItem('sb_last') || 0;
  return `<div class="page"><header class="page-head"><div><h1>Settings</h1></div><a class="btn" href="#/library">Library & background jobs ›</a></header>
  <form class="card" data-submit="saveAI"><h3>Gemini (writes sheets & questions)</h3>
    <p class="muted small">Get a free key at aistudio.google.com → “Get API key”. The free key has daily limits; the app paces itself and waits when it hits them. Your Gemini app subscription does not raise these API limits — turning on billing for the key does. Only needed on the laptop.</p>
    <label>API key<input type="password" name="key" value="${esc(AI.key)}" autocomplete="off" placeholder="AIza…"></label>
    <div class="form-row"><label>Model<input name="model" list="models" value="${esc(AI.model)}"><datalist id="models"></datalist></label>
    <label>Requests per minute<input type="number" name="rpm" min="1" max="60" value="${AI.rpm}"></label></div>
    <div class="form-row"><label>Bulk model (importing question banks & spotters)<input name="bulk" list="models" value="${esc(AI.bulkModel)}"></label></div>
    <p class="muted small">Importing thousands of questions is simple work, so it uses the cheaper "lite" model, which has much higher free limits. Sheets and new questions use the main model.</p>
    <div class="row gap mt"><button class="btn primary">Save</button><button type="button" class="btn" data-act="testKey">Test key & list models</button></div>
    <p class="muted small" id="key-msg"></p></form>
  <form class="card mt" data-submit="saveProviders"><h3>Extra free AI — make it faster</h3>
    <p class="muted small">Each free service you add works <b>at the same time</b> as Gemini on importing question banks, image questions and reading scanned pages, so the work finishes several times faster. Sign up (free), create an API key, paste it here and click Test. Topic sheets and new MCQs use Gemini for best quality; when Gemini’s free allowance runs out for the day, Mistral takes over.</p>
    ${Providers.list().map(p => `<div class="prov">
      <div class="row between wrap gap"><b>${p.name}</b><a class="link small" href="${p.signup}" target="_blank" rel="noopener">Get a free key ›</a></div>
      <p class="muted small">${p.note}${p.vision ? ' Reads images too.' : ''}</p>
      ${p.custom ? `<div class="form-row"><label>Name<input name="name_${p.id}" value="${esc(p.name)}"></label><label>Address (base URL)<input name="base_${p.id}" value="${esc(p.base || '')}" placeholder="https://…/v1"></label></div>` : ''}
      <div class="form-row"><label>API key<input type="password" name="key_${p.id}" value="${esc(p.key || '')}" autocomplete="off"></label>
      <label>Model<input name="model_${p.id}" list="pm_${p.id}" value="${esc(p.model || '')}" placeholder="click Test to choose"><datalist id="pm_${p.id}"></datalist></label>
      <label>Requests / minute<input type="number" min="1" max="60" name="rpm_${p.id}" value="${p.rpm}"></label></div>
      <div class="row gap mt"><button type="button" class="btn sm" data-act="testProvider" data-id="${p.id}">Test</button><span class="muted small" id="pmsg_${p.id}">${p.key && p.model ? (p.on === false ? 'Off' : 'Active') : ''}</span></div>
    </div>`).join('')}
    <div class="prov"><b>Relay — for services that block browser apps (NVIDIA, GitHub), and WiFi that blocks Gemini</b>
      <p class="muted small">A tiny free helper on your own Cloudflare account that passes the messages through. One-time, 5 minutes, no card:<br>
      1. Sign up free at <a class="link" href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">dash.cloudflare.com</a>.<br>
      2. Left menu: <b>Compute (Workers)</b> → <b>Workers &amp; Pages</b> → <b>Create</b> → <b>Start with Hello World</b> → <b>Deploy</b>.<br>
      3. Click <b>Edit code</b>, delete everything in the box, click <b>Copy relay code</b> here and paste it there, then <b>Deploy</b>.<br>
      4. Copy the address it shows (ends in <i>.workers.dev</i>), paste it below, click <b>Test relay</b>, then Save and Test NVIDIA again.</p>
      <div class="form-row"><label>Relay address<input name="relay" value="${esc(localStorage.getItem('relay') || '')}" placeholder="https://something.yourname.workers.dev"></label></div>
      <div class="row gap mt"><button type="button" class="btn sm" data-act="copyRelay">Copy relay code</button><button type="button" class="btn sm" data-act="testRelay">Test relay</button><span class="muted small" id="relay-msg"></span></div>
    </div>
    <button class="btn primary mt">Save</button></form>
  <form class="card mt" data-submit="saveGoals"><h3>Targets</h3>
    ${prefs.exams.map((e, i) => `<div class="form-row"><label>Milestone<input name="en${i}" value="${esc(e.name)}"></label><label>Date<input type="date" name="ed${i}" value="${e.date}"></label></div>`).join('')}
    <div class="form-row"><label>Daily question goal<input type="number" name="daily" min="5" max="500" value="${prefs.daily}"></label>
    <label>Biweekly test length<input type="number" name="bw" min="10" max="150" value="${prefs.biweeklyCount}"></label>
    <label>Study days per week<select name="sd">${[[7, '7 — no days off'], [6, '6 — Sundays off'], [5, '5 — weekends off']].map(([v, l]) => `<option value="${v}" ${(+prefs.studyDays || 6) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <p class="muted small">Per-system target dates are set on each system's page.</p>
    <button class="btn primary mt">Save</button></form>
  <form class="card mt" data-submit="saveSync"><h3>Sync across laptop, iPad and phone</h3>
    <p class="muted small">Free with a Supabase project (supabase.com → New project). In the project's SQL editor, paste the setup script below and run it once. Then copy the Project URL and the anon public key from Project settings → API, and enter the same two values on every device. Books never sync — only sheets, questions, images, notes and progress. Keep these two values private.</p>
    <div class="form-row"><label>Project URL<input name="url" value="${esc(localStorage.getItem('sb_url') || '')}" placeholder="https://xxxx.supabase.co"></label>
    <label>Anon key<input type="password" name="key" value="${esc(localStorage.getItem('sb_key') || '')}" placeholder="eyJ…"></label></div>
    <div class="row gap mt"><button class="btn primary">Save & sync now</button><button type="button" class="btn" data-act="copySql">Copy setup script</button></div>
    <p class="muted small">${Sync.on() ? `Status: ${esc(Sync.msg || Sync.state)}${last ? ' · last sync ' + new Date(last).toLocaleString() : ''}` : 'Sync is off.'}</p></form>
  <section class="card mt"><h3>Backup</h3><p class="muted small">Download everything except the books as one file, or load a backup (merges into what's here).</p>
    <div class="row gap wrap"><button class="btn" data-act="exportData">Download backup</button><label class="btn">Load backup<input type="file" accept=".json,application/json" hidden data-change="importData"></label></div></section>
  <section class="card mt"><h3>Test mode</h3><p class="muted small">When you start a topic test or practice set.</p>
    <select data-change="setModePref" class="select-sm">${[['ask', 'Ask me every time'], ...Object.entries(MODES).map(([k, m]) => [k, m.label])].map(([v, l]) => `<option value="${v}" ${(localStorage.getItem('modePref') || 'ask') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></section>
  <section class="card mt"><h3>Appearance</h3><div class="seg">${['auto', 'light', 'dark'].map(k => `<button class="${(localStorage.getItem('theme') || 'auto') === k ? 'on' : ''}" data-act="theme" data-k="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div></section>
  </div>`;
};
