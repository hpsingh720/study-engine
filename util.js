const APP_VERSION = 'v98';
// A topic stops earning new questions at this many: beyond it the model repeats itself.
const MCQ_CAP = 60;
// Small helpers shared across the app.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// Timers run inside a small worker, because Chrome slows page timers to once a minute when the window is minimised.
const _tw = (() => {
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data[0]),e.data[1])'], { type: 'text/javascript' })));
    const cbs = new Map(); let n = 0;
    w.onmessage = e => { const f = cbs.get(e.data); cbs.delete(e.data); f && f(); };
    return (f, ms) => { const id = ++n; cbs.set(id, f); w.postMessage([id, ms]); };
  } catch (e) { return null; }
})();
const sleep = ms => new Promise(r => (_tw && ms > 50) ? _tw(r, ms) : setTimeout(r, ms));
// A tone too low for any speaker to play (8 Hz). Chrome treats the tab as "playing sound", so it keeps it running at full speed when minimised.
const KeepAlive = {
  ctx: null,
  wanted() { return localStorage.getItem('bgRun') !== '0'; },
  start() {
    if (!this.wanted()) return;
    try {
      if (!this.ctx) {
        const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
        const ctx = new C(), o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 8; g.gain.value = 0.02; o.connect(g).connect(ctx.destination); o.start();
        this.ctx = ctx;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) {}
  },
  stop() { try { if (this.ctx) { this.ctx.close(); this.ctx = null; } } catch (e) {} }
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => '- ' + String(x).replace(/^[-•*]\s*/, '')).join('\n');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `- **${k}:** ${asText(x)}`).join('\n');
  return String(v);
}

// Minimal, safe markdown: bullets, headings, bold, italics, page cites.
function md(src) {
  const s = asText(src);
  if (!s.trim()) return '';
  const inline = t => unshout(texify(esc(t)))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]{1,60}?p\.?\s?\d+[^\]\n]{0,20})\]/g, '<span class="cite">$1</span>')
    .replace(/^\(general knowledge\)/i, '<span class="gk">general knowledge</span>');
  const lines = s.split(/\r?\n/);
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const isRow = l => /^\s*\|.*\|\s*$/.test(l);
  const isRule = l => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');

  let out = '', list = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();

    // A table: a header row, a |---|---| rule under it, then rows until the pipes stop.
    // The books are full of classification, dosing and criteria tables, and a table copied out of
    // one is only worth having if it still reads as a table.
    if (isRow(l) && isRule(lines[i + 1] || '')) {
      if (list) { out += '</ul>'; list = false; }
      const head = cells(l);
      let body = '';
      i += 2;
      for (; i < lines.length && isRow(lines[i]); i++) {
        const c = cells(lines[i]);
        body += '<tr>' + c.map((x, n) => n === 0 ? `<th>${inline(x)}</th>` : `<td>${inline(x)}</td>`).join('') + '</tr>';
      }
      i--;
      out += `<div class="tscroll"><table class="mdt"><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }

    const b = l.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
    if (b) { if (!list) { out += '<ul>'; list = true; } out += '<li>' + inline(b[1]) + '</li>'; continue; }
    if (list) { out += '</ul>'; list = false; }
    if (!l) continue;
    const h = l.match(/^#{1,4}\s+(.*)/);
    out += h ? '<h4>' + inline(h[1]) + '</h4>' : '<p>' + inline(l) + '</p>';
  }
  if (list) out += '</ul>';
  return out;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms);
}

/**
 * opts.light  — no dimming, and the page behind stays usable: scroll it, select it, highlight it.
 * opts.drag   — a grab bar along the top, so a slow answer can be pushed aside and read later.
 */
function openModal(html, opts = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-back${opts.light ? ' light' : ''}"${opts.light ? '' : ' data-act="closeModal"'}></div>`
    + `<div class="modal-box${opts.light ? ' light' : ''}">${opts.drag ? '<div class="modal-grip" title="Drag me out of the way"></div>' : ''}${html}</div>`;
  m.classList.add('open');
  if (opts.light) m.classList.add('pass'); else m.classList.remove('pass');
  if (opts.drag) dragModal(m.querySelector('.modal-box'), m.querySelector('.modal-grip'));
  return m;
}

/** Move a dialog by its grip. Kept within the window so it can never be dragged out of reach. */
function dragModal(box, grip) {
  if (!box || !grip) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, on = false;

  const down = e => {
    const p = e.touches ? e.touches[0] : e;
    const r = box.getBoundingClientRect();
    // Switch from centred flex to absolute, at exactly where it already sits, so it does not jump.
    box.style.position = 'fixed';
    box.style.margin = '0';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    // Keep whatever size it has been pulled to; only pin where it sits.
    if (!box.style.width) box.style.width = r.width + 'px';
    ox = r.left; oy = r.top; sx = p.clientX; sy = p.clientY; on = true;
    box.classList.add('dragging');
    e.preventDefault();
  };
  const move = e => {
    if (!on) return;
    const p = e.touches ? e.touches[0] : e;
    const w = box.offsetWidth, h = box.offsetHeight;
    box.style.left = Math.max(8 - w + 60, Math.min(window.innerWidth - 60, ox + p.clientX - sx)) + 'px';
    box.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + p.clientY - sy)) + 'px';
    e.preventDefault();
  };
  const up = () => { on = false; box.classList.remove('dragging'); };

  grip.addEventListener('mousedown', down);
  grip.addEventListener('touchstart', down, { passive: false });
  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', up);
  document.addEventListener('touchend', up);
}
function closeModal() { const m = $('#modal'); m.classList.remove('open'); m.innerHTML = ''; }

function todayStr(d = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr + 'T00:00:00'); const n = new Date(todayStr() + 'T00:00:00');
  return Math.round((t - n) / 86400000);
}
function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s).padStart(2, '0')}`;
}
function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Resize/compress an image (File, Blob, dataURL or canvas) to a JPEG dataURL.
async function compressImage(src, max = 1600, q = 0.82) {
  let img;
  if (src instanceof HTMLCanvasElement) img = src;
  else {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  }
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Questions can have one answer, or several ("select all that apply", old AMC-style "could be due to").
function correctSet(m) {
  if (Array.isArray(m.multi) && m.multi.length > 1) return [...m.multi].sort();
  const mm = String(m.expl || '').match(/^\s*(?:\*\*)?Answer:?(?:\*\*)?\s*([A-E](?:\s*(?:,|and|&)\s*[A-E])+)(?![a-z])/i);
  if (mm) {
    const arr = [...new Set(mm[1].toUpperCase().match(/[A-E]/g).map(c => c.charCodeAt(0) - 65))].filter(i => i < (m.options || []).length);
    if (arr.length > 1) return arr.sort();
  }
  return [m.ans];
}
function isMulti(m) { return correctSet(m).length > 1; }
function isRight(m, choice) {
  const set = correctSet(m), ch = Array.isArray(choice) ? choice : [choice];
  return set.length === ch.length && set.every(x => ch.includes(x));
}
const letters = arr => (Array.isArray(arr) ? arr : [arr]).filter(x => x != null).map(i => String.fromCharCode(65 + i)).join(', ');

// Load a library from the first CDN that answers (a blocked or flaky network on one CDN no longer stops the app).
const _libLoads = {};
function loadScriptFrom(urls, test) {
  if (test()) return Promise.resolve();
  const key = urls[0];
  if (_libLoads[key]) return _libLoads[key];
  _libLoads[key] = (async () => {
    for (const u of urls) {
      try {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = u; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
        if (test()) return u;
      } catch (e) {}
    }
    const err = new QuotaError('Could not download the page reader — no internet? It will carry on by itself when the connection is back.', false, 60000);
    err.net = true; throw err;
  })().finally(() => { if (!test()) delete _libLoads[key]; });
  return _libLoads[key];
}
async function ensurePdfjs() {
  if (window.pdfjsLib) return;
  const bases = ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/', 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/', 'https://unpkg.com/pdfjs-dist@3.11.174/build/'];
  const used = await loadScriptFrom(bases.map(b => b + 'pdf.min.js'), () => !!window.pdfjsLib);
  const base = (used || bases[0]).replace(/pdf\.min\.js$/, '');
  pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
}
function ensureTesseract() {
  return loadScriptFrom(['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', 'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'], () => !!window.Tesseract);
}
