// Small helpers shared across the app.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const inline = t => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]{1,60}?p\.?\s?\d+[^\]\n]{0,20})\]/g, '<span class="cite">$1</span>')
    .replace(/^\(general knowledge\)/i, '<span class="gk">general knowledge</span>');
  let out = '', list = false;
  for (const raw of s.split(/\r?\n/)) {
    const l = raw.trim();
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

function openModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-back" data-act="closeModal"></div><div class="modal-box">${html}</div>`;
  m.classList.add('open');
  return m;
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
