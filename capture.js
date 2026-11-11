// Photographing the board in class: a camera that stays open, then a look at what you got.
//
// The file picker closes after every shot, which is useless when a lecturer is moving through
// twenty X-rays. This keeps a live camera on screen, collects the shots, and only afterwards asks
// which to keep. Each shot is searched for the board — the projected slide, the screen, the film —
// and straightened into a flat rectangle the way a document scanner does, because a slide shot from
// the tenth row is a small, tilted trapezium in a large dark room.

// ---------- finding and straightening the board ----------

const Scan = {
  /**
   * Find the board in `src` (a video, image or canvas), looking only inside `region` (source pixels).
   * Returns its corners in source pixels as [tl, tr, br, bl], or null when nothing board-shaped is found.
   *
   * The board is the largest bright, solid, four-sided area. A lit screen in a lecture hall is
   * brighter than the room around it even when the slide itself is dark, so several brightness
   * cut-offs are tried, from strict to loose, and the first that gives a believable shape wins.
   */
  detect(src, region) {
    const fw = src.videoWidth || src.naturalWidth || src.width, fh = src.videoHeight || src.naturalHeight || src.height;
    const R = region || { x: 0, y: 0, w: fw, h: fh };
    if (!R.w || !R.h) return null;
    const k = 320 / Math.max(R.w, R.h);
    const w = Math.max(16, Math.round(R.w * k)), h = Math.max(16, Math.round(R.h * k)), n = w * h;
    const c = this._c || (this._c = document.createElement('canvas'));
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, R.x, R.y, R.w, R.h, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;

    let lum = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) lum[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    lum = this._blur(lum, w, h, 2);

    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[Math.min(255, lum[i] | 0)]++;
    const { t, lowMean, highMean } = this._otsu(hist, n);
    if (highMean - lowMean < 28) return null; // a flat, evenly lit picture: nothing stands out

    const cuts = [t, (t + lowMean) / 2, lowMean + (t - lowMean) * 0.3];
    for (const cut of cuts) {
      const q = this._shape(lum, w, h, cut);
      if (q) return q.map(p => ({ x: R.x + p.x / k, y: R.y + p.y / k }));
    }
    return null;
  },

  _blur(a, w, h, r) {
    const tmp = new Float32Array(a.length), out = new Float32Array(a.length), span = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / span;
        s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / span;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  },

  _otsu(hist, n) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let wB = 0, sumB = 0, best = -1, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = n - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; t = i; }
    }
    let a = 0, an = 0, b = 0, bn = 0;
    for (let i = 0; i < 256; i++) { if (i <= t) { a += i * hist[i]; an += hist[i]; } else { b += i * hist[i]; bn += hist[i]; } }
    return { t, lowMean: an ? a / an : 0, highMean: bn ? b / bn : 255 };
  },

  // The largest bright patch above `cut`, and whether it is shaped like a board.
  _shape(lum, w, h, cut) {
    const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n);
    let best = 0, bestSize = 0, id = 0;
    for (let s = 0; s < n; s++) {
      if (lab[s] || lum[s] <= cut) continue;
      id++; let top = 0, size = 0; stack[top++] = s; lab[s] = id;
      while (top) {
        const p = stack[--top]; size++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && !lab[p - 1] && lum[p - 1] > cut) { lab[p - 1] = id; stack[top++] = p - 1; }
        if (x < w - 1 && !lab[p + 1] && lum[p + 1] > cut) { lab[p + 1] = id; stack[top++] = p + 1; }
        if (y > 0 && !lab[p - w] && lum[p - w] > cut) { lab[p - w] = id; stack[top++] = p - w; }
        if (y < h - 1 && !lab[p + w] && lum[p + w] > cut) { lab[p + w] = id; stack[top++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; best = id; }
    }
    if (bestSize < n * 0.06) return null;

    // Its outline row by row. Counting from the leftmost to the rightmost pixel of each row treats
    // dark text, tables and X-ray films inside the slide as part of it rather than as holes.
    let solid = 0;
    const edge = [];
    let tl = null, tr = null, br = null, bl = null, sMin = 1e9, sMax = -1e9, dMin = 1e9, dMax = -1e9;
    const consider = (x, y) => {
      const s = x + y, df = x - y;
      if (s < sMin) { sMin = s; tl = { x, y }; }
      if (s > sMax) { sMax = s; br = { x, y }; }
      if (df > dMax) { dMax = df; tr = { x, y }; }
      if (df < dMin) { dMin = df; bl = { x, y }; }
    };
    for (let y = 0; y < h; y++) {
      let lo = -1, hi = -1;
      for (let x = 0; x < w; x++) if (lab[y * w + x] === best) { if (lo < 0) lo = x; hi = x; }
      if (lo < 0) continue;
      solid += hi - lo + 1;
      consider(lo, y); consider(hi + 1, y);
      edge.push({ x: lo, y }, { x: hi + 1, y });
    }
    if (!tl || !tr || !br || !bl) return null;
    // The bottom edge sits one pixel past the last row.
    br = { x: br.x, y: br.y + 1 }; bl = { x: bl.x, y: bl.y + 1 };
    const q = [tl, tr, br, bl];

    const area = Math.abs(q.reduce((a, p, i) => { const r = q[(i + 1) % 4]; return a + p.x * r.y - r.x * p.y; }, 0)) / 2;
    if (area < n * 0.08) return null;     // too small to be the board
    if (area > n * 0.97) return null;     // the board already fills the photo: nothing to cut
    // Corners sitting on the photo's edge mean the board runs out of the picture. What is visible
    // is not the board's shape, and straightening it would cut off the part that is there.
    const m = Math.min(w, h) * 0.02;
    if (q.filter(p => p.x <= m || p.y <= m || p.x >= w - m || p.y >= h - m).length >= 2) return null;
    const fill = solid / area;
    if (fill < 0.82 || fill > 1.12) return null; // not four-sided — a lamp, a window, a lit wall

    // Convex, with no corner squashed flat, and opposite sides of similar length.
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (!cr) return null;
      if (sign && Math.sign(cr) !== sign) return null;
      sign = Math.sign(cr);
    }
    const L = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const ratio = (a, b) => Math.min(a, b) / Math.max(a, b);
    if (ratio(L(tl, tr), L(bl, br)) < 0.55 || ratio(L(tl, bl), L(tr, br)) < 0.55) return null;
    if (Math.min(L(tl, tr), L(tl, bl)) < Math.min(w, h) * 0.15) return null;

    // A board has straight edges: its outline lies along the four sides. A round lamp, a face or a
    // curved patch of light can pass every test above, but its outline bows away from them.
    const segDist = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    let off = 0;
    for (const p of edge) off += Math.min(segDist(p, tl, tr), segDist(p, tr, br), segDist(p, br, bl), segDist(p, bl, tl));
    if (off / edge.length > Math.min(w, h) * 0.025) return null;
    return q;
  },

  // Maps the output rectangle onto the four corners in the photo.
  _homography(from, to) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        B[r] -= f * B[c];
      }
    }
    return B.map((b, i) => b / A[i][i]);
  },

  /** Cut the board out along its four corners, flatten it, and lift washed-out contrast. */
  warp(img, q, maxSide = 2000) {
    const [tl, tr, br, bl] = q;
    const L = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let W = Math.max(L(tl, tr), L(bl, br)), H = Math.max(L(tl, bl), L(tr, br));
    const s = Math.min(1, maxSide / Math.max(W, H));
    W = Math.max(40, Math.round(W * s)); H = Math.max(40, Math.round(H * s));
    const m = this._homography([[0, 0], [W, 0], [W, H], [0, H]], q.map(p => [p.x, p.y]));
    if (!m) return null;

    const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
    const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
    const sg = sc.getContext('2d', { willReadFrequently: true }); sg.drawImage(img, 0, 0);
    const S = sg.getImageData(0, 0, sw, sh).data;
    const oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    const og = oc.getContext('2d'); const out = og.createImageData(W, H), O = out.data;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const den = m[6] * x + m[7] * y + 1;
        let fx = (m[0] * x + m[1] * y + m[2]) / den, fy = (m[3] * x + m[4] * y + m[5]) / den;
        fx = Math.min(sw - 1.001, Math.max(0, fx)); fy = Math.min(sh - 1.001, Math.max(0, fy));
        const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const o = (y * W + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = S[i00 + ch] + (S[i10 + ch] - S[i00 + ch]) * ax;
          const bot = S[i01 + ch] + (S[i11 + ch] - S[i01 + ch]) * ax;
          O[o + ch] = top + (bot - top) * ay;
        }
        O[o + 3] = 255;
      }
    }
    this._levels(O);
    og.putImageData(out, 0, 0);
    return oc.toDataURL('image/jpeg', 0.9);
  },

  // A projected slide photographed in a lit room comes out grey on grey. Stretch each colour so the
  // darkest ink is near black and the brightest paper near white, ignoring the odd stray pixel.
  _levels(O) {
    const n = O.length / 4, step = Math.max(1, Math.floor(n / 60000));
    for (let ch = 0; ch < 3; ch++) {
      const hist = new Uint32Array(256); let cnt = 0;
      for (let i = 0; i < n; i += step) { hist[O[i * 4 + ch]]++; cnt++; }
      let lo = 0, hi = 255, acc = 0;
      for (; lo < 255; lo++) { acc += hist[lo]; if (acc > cnt * 0.005) break; }
      acc = 0;
      for (; hi > 0; hi--) { acc += hist[hi]; if (acc > cnt * 0.005) break; }
      if (hi - lo < 40) continue;
      const f = 255 / (hi - lo);
      for (let i = 0; i < n; i++) { const p = i * 4 + ch, v = (O[p] - lo) * f; O[p] = v < 0 ? 0 : v > 255 ? 255 : v; }
    }
  }
};

const loadImage = src => new Promise((res, rej) => { const x = new Image(); x.onload = () => res(x); x.onerror = rej; x.src = src; });

// ---------- the camera ----------

const Capture = {
  stream: null, shots: [], _done: null, _video: null, _zoom: 1,

  supported() { return !!(navigator.mediaDevices?.getUserMedia); },

  /**
   * Open the camera and keep it open. `onDone(dataUrls)` gets whatever was kept.
   */
  async open(onDone) {
    this._done = onDone;
    this.shots = [];

    if (!this.supported()) { this.pick(onDone); return; }

    openModal(`<div class="cap">
      <div class="cap-head"><b>Camera</b><span class="muted small" id="cap-n">no photos yet</span></div>
      <div class="cap-stage" id="cap-stage"><video id="cap-video" playsinline muted autoplay></video>
        <canvas id="cap-ov" class="cap-ov"></canvas><span class="cap-hint" id="cap-hint">Looking for the board</span></div>
      <div class="cap-zoom"><span class="muted small">Zoom</span>
        <input type="range" id="cap-zoom" min="1" max="4" step="0.1" value="1"><span class="small" id="cap-zv">1.0×</span></div>
      <div class="cap-roll" id="cap-roll"></div>
      <div class="row gap mt">
        <button class="btn primary big" data-act="capShoot">Take photo</button>
        <button class="btn" data-act="capFlip" title="Front / back camera">Flip</button>
        <button class="btn ghost" data-act="capFinish">Done</button>
      </div>
    </div>`);

    // Tapping outside means "done", not "throw it away" — nothing is saved until Done, and losing
    // twenty photographs of a practical class to a stray tap would be unforgivable. The same
    // reasoning makes the review sheet's backdrop do nothing at all.
    const back = document.querySelector('#modal .modal-back');
    if (back) back.dataset.act = 'capFinish';

    try {
      await this._start('environment');
    } catch (e) {
      closeModal();
      const why = e?.name === 'NotAllowedError' ? 'camera permission was refused'
        : e?.name === 'NotFoundError' ? 'no camera was found'
        : e?.name === 'NotReadableError' ? 'another app is using the camera' : 'the camera would not start';
      toast(`Could not open the camera (${why}) — using the photo picker instead.`, 6000);
      this.pick(onDone);
      return;
    }
    this._wireZoom();
    this._watch();
  },

  async _start(facing) {
    this.stop();
    const want = { facingMode: facing, width: { ideal: 2200 }, height: { ideal: 2200 } };
    // Asking for zoom lets phones that support it use the real lens zoom; if the request is
    // refused for that reason alone, ask again without it and zoom digitally instead.
    try { this.stream = await navigator.mediaDevices.getUserMedia({ video: { ...want, zoom: true }, audio: false }); }
    catch (e) {
      if (e?.name === 'NotAllowedError' || e?.name === 'NotFoundError') throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false });
    }
    this._facing = facing;
    const v = document.getElementById('cap-video');
    if (!v) { this.stop(); return; }
    this._video = v;
    v.srcObject = this.stream;
    await v.play().catch(() => {});

    const track = this.stream.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() || {};
    this._hwZoom = caps.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: Math.min(caps.zoom.max, 10), step: caps.zoom.step || 0.1 } : null;
    this._track = track;
    const r = document.getElementById('cap-zoom');
    if (r) {
      const z = this._hwZoom || { min: 1, max: 4, step: 0.1 };
      r.min = z.min; r.max = z.max; r.step = z.step; r.value = z.min;
    }
    this.setZoom(this._hwZoom ? this._hwZoom.min : 1);
  },

  setZoom(z) {
    const lim = this._hwZoom || { min: 1, max: 4 };
    z = Math.min(lim.max, Math.max(lim.min, +z || 1));
    this._zoom = z;
    const v = this._video;
    if (this._hwZoom) {
      this._track?.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
      if (v) v.style.transform = '';
    } else if (v) v.style.transform = z > 1 ? `scale(${z})` : '';
    const r = document.getElementById('cap-zoom'), lab = document.getElementById('cap-zv');
    if (r && +r.value !== z) r.value = z;
    if (lab) lab.textContent = (this._hwZoom ? z / (this._hwZoom.min || 1) : z).toFixed(1) + '×';
  },

  _wireZoom() {
    const r = document.getElementById('cap-zoom'), st = document.getElementById('cap-stage');
    if (r) r.addEventListener('input', () => this.setZoom(r.value));
    if (!st) return;
    // Two fingers on the picture zoom it, the way the phone's own camera does.
    let pinch = null;
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    st.addEventListener('touchstart', e => { if (e.touches.length === 2) { pinch = { d: dist(e.touches), z: this._zoom }; e.preventDefault(); } }, { passive: false });
    st.addEventListener('touchmove', e => { if (pinch && e.touches.length === 2) { this.setZoom(pinch.z * dist(e.touches) / pinch.d); e.preventDefault(); } }, { passive: false });
    st.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });
  },

  // The part of the camera frame a photo will contain. Digital zoom keeps the middle.
  _region() {
    const v = this._video;
    const fw = v.videoWidth, fh = v.videoHeight, z = this._hwZoom ? 1 : this._zoom;
    const w = fw / z, h = fh / z;
    return { x: (fw - w) / 2, y: (fh - h) / 2, w, h };
  },

  // While the camera is open, keep looking for the board and outline it on the picture.
  _watch() {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      const v = this._video, ov = document.getElementById('cap-ov'), hint = document.getElementById('cap-hint');
      if (!v || !ov || !v.videoWidth) { if (!document.getElementById('cap-video')) this.stop(); return; }
      let q = null;
      try { q = Scan.detect(v, this._region()); } catch (e) {}
      this._liveQuad = q;
      const W = ov.clientWidth, H = ov.clientHeight, dpr = window.devicePixelRatio || 1;
      if (ov.width !== Math.round(W * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); }
      const g = ov.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      if (hint) { hint.textContent = q ? 'Board found' : 'Looking for the board'; hint.classList.toggle('on', !!q); }
      if (!q) return;
      // The video fills the frame (cover) and digital zoom scales it about the middle.
      const s = Math.max(W / v.videoWidth, H / v.videoHeight) * (this._hwZoom ? 1 : this._zoom);
      const ox = W / 2 - v.videoWidth / 2 * s, oy = H / 2 - v.videoHeight / 2 * s;
      g.beginPath();
      q.forEach((p, i) => { const x = ox + p.x * s, y = oy + p.y * s; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath();
      g.lineWidth = 3; g.strokeStyle = '#7dd3a8'; g.fillStyle = 'rgba(125, 211, 168, .12)';
      g.fill(); g.stroke();
    }, 350);
  },

  async flip() {
    try { await this._start(this._facing === 'environment' ? 'user' : 'environment'); this._watch(); }
    catch (e) { toast('No other camera on this device'); }
  },

  /** Grab the current frame — the zoomed part, at full sensor size — and look for the board in it. */
  shoot() {
    const v = this._video;
    if (!v || !v.videoWidth) return;
    const R = this._region();
    const c = document.createElement('canvas');
    c.width = Math.round(R.w); c.height = Math.round(R.h);
    c.getContext('2d').drawImage(v, R.x, R.y, R.w, R.h, 0, 0, c.width, c.height);
    let quad = null;
    try { quad = Scan.detect(c); } catch (e) {}
    this.shots.push({ src: c.toDataURL('image/jpeg', 0.9), quad });
    this._paintRoll();
    // A small flash so it is obvious the shot was taken, since the preview never pauses.
    const st = document.querySelector('.cap-stage');
    if (st) { st.classList.add('flash'); setTimeout(() => st.classList.remove('flash'), 140); }
  },

  _paintRoll() {
    const roll = document.getElementById('cap-roll');
    const n = document.getElementById('cap-n');
    if (n) n.textContent = this.shots.length ? `${this.shots.length} photo${this.shots.length === 1 ? '' : 's'}` : 'no photos yet';
    if (!roll) return;
    roll.innerHTML = this.shots.map((s, i) => `<img src="${s.src}" alt="" data-act="capDrop" data-i="${i}" title="Tap to remove">`).join('');
    roll.scrollLeft = roll.scrollWidth;
  },

  drop(i) { this.shots.splice(i, 1); this._paintRoll(); },

  stop() {
    clearInterval(this._timer); this._timer = null;
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch (e) {}
    this.stream = null; this._video = null; this._track = null;
  },

  finish() {
    this.stop();
    const shots = this.shots.slice();
    this.shots = [];
    closeModal();
    if (!shots.length) return;
    this.review(shots, this._done);
  },

  /** Fallback, and the way to bring in photos taken with the normal camera app. */
  pick(onDone) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = async () => {
      const files = [...(inp.files || [])];
      if (!files.length) return;
      const shots = [];
      for (const f of files) {
        try {
          const src = await compressImage(f, 2200, 0.9);
          let quad = null;
          try { quad = Scan.detect(await loadImage(src)); } catch (e) {}
          shots.push({ src, quad });
        } catch (e) {}
      }
      if (shots.length) this.review(shots, onDone);
    };
    inp.click();
  },

  // ---------- deciding what to keep ----------

  async review(shots, onDone) {
    this._review = shots.map(s => typeof s === 'string' ? { src: s, quad: null } : s);
    this._done = onDone;
    const todo = this._review.filter(s => s.quad && !s.out);
    for (let k = 0; k < todo.length; k++) {
      openModal(`<div class="cap-rev"><p class="center"><span class="spin"></span>Straightening photos — ${k + 1} of ${todo.length}</p></div>`);
      await new Promise(r => setTimeout(r, 30));
      await this._straighten(todo[k]);
    }
    this._paintReview();
  },

  async _straighten(s) {
    try { s.out = Scan.warp(await loadImage(s.src), s.quad); } catch (e) { s.out = null; }
    s.mode = s.out ? 'scan' : 'orig';
  },

  _paintReview() {
    const s = this._review || [];
    if (!s.length) { closeModal(); return; }
    const found = s.filter(x => x.mode === 'scan').length;
    openModal(`<div class="cap-rev">
      <div class="card-head"><h3>Keep these?</h3><span class="muted small">${s.length} photo${s.length === 1 ? '' : 's'}${found ? ` · ${found} straightened` : ''}</span></div>
      <div class="rev-grid">${s.map((x, i) => `<figure class="rev">
        <img src="${x.mode === 'scan' ? x.out : x.src}" alt="">
        <span class="rev-tag">${x.mode === 'scan' ? 'Scanned' : x.quad ? 'Original' : 'Board not found'}</span>
        <figcaption>
          ${x.out ? `<button class="link" data-act="capMode" data-i="${i}">${x.mode === 'scan' ? 'Original' : 'Scanned'}</button>` : ''}
          <button class="link" data-act="capCrop" data-i="${i}">Corners</button>
          <button class="link danger" data-act="capRemove" data-i="${i}">Remove</button></figcaption>
      </figure>`).join('')}</div>
      <div class="row gap mt">
        <button class="btn primary" data-act="capSave">Keep ${s.length}</button>
        <button class="btn ghost" data-act="capCancel">Discard all</button>
      </div>
    </div>`);
    const back = document.querySelector('#modal .modal-back');
    if (back) delete back.dataset.act; // a stray tap must not bin the whole class
  },

  mode(i) {
    const x = this._review?.[i]; if (!x?.out) return;
    x.mode = x.mode === 'scan' ? 'orig' : 'scan';
    this._paintReview();
  },

  remove(i) { this._review.splice(i, 1); this._paintReview(); },

  save() {
    const out = (this._review || []).map(x => x.mode === 'scan' && x.out ? x.out : x.src);
    this._review = null;
    closeModal();
    if (out.length && this._done) this._done(out);
  },

  cancel() { this._review = null; closeModal(); },

  // ---------- setting the corners by hand ----------

  /**
   * The photo with the board's four corners, each draggable on its own. When the board was not
   * found, or the wrong thing was, this is how to say where it is; the result is straightened the
   * same way as a found one.
   */
  crop(i) {
    const x = this._review[i];
    this._cropI = i;
    openModal(`<div class="cap-crop">
      <div class="card-head"><h3>Corners</h3><span class="muted small">Drag the corners onto the board</span></div>
      <div class="crop-stage" id="crop-stage"><img id="crop-img" src="${x.src}" alt="">
        <svg class="crop-svg" id="crop-svg"><polygon id="crop-poly"></polygon></svg>
        ${[0, 1, 2, 3].map(k => `<span class="cq" data-k="${k}"></span>`).join('')}</div>
      <div class="row gap mt">
        <button class="btn primary" data-act="capCropOk">Straighten</button>
        <button class="btn ghost" data-act="capCropAll">Whole photo</button>
      </div>
    </div>`);
    const back = document.querySelector('#modal .modal-back');
    if (back) back.dataset.act = 'capCropAll';
    setTimeout(() => this._wireCrop(), 60);
  },

  _wireCrop() {
    const img = document.getElementById('crop-img'), stage = document.getElementById('crop-stage');
    const poly = document.getElementById('crop-poly'), svg = document.getElementById('crop-svg');
    if (!img || !stage) return;
    const handles = [...stage.querySelectorAll('.cq')];
    const x = this._review[this._cropI];

    const place = () => {
      const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
      this._imgBox = { left: r.left - s.left, top: r.top - s.top, w: r.width, h: r.height, nw: img.naturalWidth, nh: img.naturalHeight };
      if (!this._pts) {
        this._pts = x.quad ? x.quad.map(p => ({ x: p.x / img.naturalWidth, y: p.y / img.naturalHeight }))
          : [{ x: .08, y: .08 }, { x: .92, y: .08 }, { x: .92, y: .92 }, { x: .08, y: .92 }];
      }
      draw();
    };
    const draw = () => {
      const b = this._imgBox;
      svg.setAttribute('width', stage.clientWidth); svg.setAttribute('height', stage.clientHeight);
      const px = this._pts.map(p => [b.left + p.x * b.w, b.top + p.y * b.h]);
      poly.setAttribute('points', px.map(p => p.join(',')).join(' '));
      handles.forEach((h, k) => { h.style.left = px[k][0] + 'px'; h.style.top = px[k][1] + 'px'; });
    };
    this._pts = null;
    if (img.complete && img.naturalWidth) place(); else img.onload = place;
    window.addEventListener('resize', place);

    let grab = null;
    const at = e => { const p = e.touches ? e.touches[0] : e; return { x: p.clientX, y: p.clientY }; };
    const down = e => { grab = { k: +e.currentTarget.dataset.k, start: at(e), p: { ...this._pts[+e.currentTarget.dataset.k] } }; e.preventDefault(); };
    const move = e => {
      if (!grab) return;
      const p = at(e), b = this._imgBox;
      const lim = v => Math.max(0, Math.min(1, v));
      this._pts[grab.k] = { x: lim(grab.p.x + (p.x - grab.start.x) / b.w), y: lim(grab.p.y + (p.y - grab.start.y) / b.h) };
      draw();
      e.preventDefault();
    };
    const up = () => { grab = null; };
    handles.forEach(h => { h.addEventListener('mousedown', down); h.addEventListener('touchstart', down, { passive: false }); });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
  },

  async cropOk() {
    const x = this._review[this._cropI], b = this._imgBox;
    if (!x || !b || !this._pts) return this._paintReview();
    // Put the corners in order round the board, whichever way they were dragged.
    const pts = this._pts.map(p => ({ x: p.x * b.nw, y: p.y * b.nh }));
    const cx = pts.reduce((a, p) => a + p.x, 0) / 4, cy = pts.reduce((a, p) => a + p.y, 0) / 4;
    pts.sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
    let first = 0;
    pts.forEach((p, i) => { if (p.x + p.y < pts[first].x + pts[first].y) first = i; });
    x.quad = [0, 1, 2, 3].map(k => pts[(first + k) % 4]);
    openModal(`<div class="cap-rev"><p class="center"><span class="spin"></span>Straightening</p></div>`);
    await new Promise(r => setTimeout(r, 30));
    await this._straighten(x);
    if (!x.out) toast('Could not straighten that one');
    this._paintReview();
  },

  cropAll() {
    const x = this._review?.[this._cropI];
    if (x) x.mode = 'orig';
    this._paintReview();
  }
};
