// Handwriting pad (Apple Pencil / S Pen / mouse) with pressure, undo, eraser and palm rejection.
class Pad {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.strokes = []; this.cur = null; this.color = '#1d2125'; this.width = 2.2; this.eraser = false; this.penSeen = false;
    const on = (t, f) => canvas.addEventListener(t, f.bind(this), { passive: false });
    on('pointerdown', this.down); on('pointermove', this.move); on('pointerup', this.up); on('pointercancel', this.up); on('pointerleave', this.up);
    this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(canvas);
    this.resize();
  }
  resize() {
    const r = this.c.getBoundingClientRect(); if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }
  pos(e) { const r = this.c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pointerType === 'mouse' ? 0.5 : (e.pressure || 0.5) }; }
  down(e) {
    if (e.pointerType === 'pen') this.penSeen = true;
    if (this.penSeen && e.pointerType === 'touch') return; // palm rejection once a pen has been used
    e.preventDefault();
    try { this.c.setPointerCapture(e.pointerId); } catch (x) {}
    this.cur = { color: this.color, w: this.width, er: this.eraser, pts: [this.pos(e)] };
  }
  move(e) {
    if (!this.cur) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) this.cur.pts.push(this.pos(ev));
    this.draw(this.cur, Math.max(1, this.cur.pts.length - evs.length - 1));
  }
  up() { if (this.cur) { if (this.cur.pts.length > 1) this.strokes.push(this.cur); this.cur = null; } }
  draw(s, from = 1) {
    const x = this.ctx;
    x.globalCompositeOperation = s.er ? 'destination-out' : 'source-over';
    x.strokeStyle = s.color; x.lineCap = 'round'; x.lineJoin = 'round';
    for (let i = Math.max(1, from); i < s.pts.length; i++) {
      const a = s.pts[i - 1], b = s.pts[i];
      x.lineWidth = s.er ? s.w * 9 : s.w * (0.45 + b.p * 1.1);
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke();
    }
    x.globalCompositeOperation = 'source-over';
  }
  redraw() { const r = this.c.getBoundingClientRect(); this.ctx.clearRect(0, 0, r.width, r.height); this.strokes.forEach(s => this.draw(s, 1)); }
  undo() { this.strokes.pop(); this.redraw(); }
  clear() { this.strokes = []; this.redraw(); }
  isEmpty() { return !this.strokes.length; }
  async toImage() {
    const c = document.createElement('canvas'); c.width = this.c.width; c.height = this.c.height;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(this.c, 0, 0);
    return compressImage(c, 1800, 0.85);
  }
}

async function getNote(topicId) {
  return (await DB.get('notes', topicId)) || { id: topicId, topicId, text: '', items: [], doubts: [] };
}
