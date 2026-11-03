// Photographing the board in class: a camera that stays open, then a look at what you got.
//
// The file picker closes after every shot, which is useless when a lecturer is moving through
// twenty X-rays. This keeps a live camera on screen, collects the shots, and only afterwards asks
// which to keep and whether to trim them.

const Capture = {
  stream: null, shots: [], _done: null, _video: null,

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
      <div class="cap-stage"><video id="cap-video" playsinline muted autoplay></video></div>
      <div class="cap-roll" id="cap-roll"></div>
      <div class="row gap mt">
        <button class="btn primary big" data-act="capShoot">Take photo</button>
        <button class="btn" data-act="capFlip" title="Front / back camera">Flip</button>
        <button class="btn ghost" data-act="capFinish">Done</button>
      </div>
      <p class="muted small">Keep tapping for each slide. Nothing is saved until you press Done, and you can drop or trim any of them then.</p>
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
      toast('Could not open the camera — using the photo picker instead.', 5000);
      this.pick(onDone);
    }
  },

  async _start(facing) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 2200 }, height: { ideal: 2200 } }, audio: false
    });
    this._facing = facing;
    const v = document.getElementById('cap-video');
    if (!v) { this.stop(); return; }
    this._video = v;
    v.srcObject = this.stream;
    await v.play().catch(() => {});
  },

  async flip() {
    try { await this._start(this._facing === 'environment' ? 'user' : 'environment'); }
    catch (e) { toast('No other camera on this device'); }
  },

  /** Grab the current frame at full sensor size. */
  shoot() {
    const v = this._video;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    this.shots.push(c.toDataURL('image/jpeg', 0.88));
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
    roll.innerHTML = this.shots.map((s, i) => `<img src="${s}" alt="" data-act="capDrop" data-i="${i}" title="Tap to remove">`).join('');
    roll.scrollLeft = roll.scrollWidth;
  },

  drop(i) { this.shots.splice(i, 1); this._paintRoll(); },

  stop() {
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch (e) {}
    this.stream = null; this._video = null;
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
      const urls = [];
      for (const f of files) { try { urls.push(await compressImage(f, 2000, 0.9)); } catch (e) {} }
      if (urls.length) this.review(urls, onDone);
    };
    inp.click();
  },

  // ---------- deciding what to keep ----------

  review(shots, onDone) {
    this._review = shots;
    this._done = onDone;
    this._paintReview();
  },

  _paintReview() {
    const s = this._review || [];
    if (!s.length) { closeModal(); return; }
    openModal(`<div class="cap-rev">
      <div class="card-head"><h3>Keep these?</h3><span class="muted small">${s.length} photo${s.length === 1 ? '' : 's'}</span></div>
      <div class="rev-grid">${s.map((u, i) => `<figure class="rev">
        <img src="${u}" alt="">
        <figcaption><button class="link" data-act="capCrop" data-i="${i}">Trim</button>
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

  remove(i) { this._review.splice(i, 1); this._paintReview(); },

  save() {
    const out = (this._review || []).slice();
    this._review = null;
    closeModal();
    if (out.length && this._done) this._done(out);
  },

  cancel() { this._review = null; closeModal(); },

  // ---------- trimming ----------

  /**
   * A rectangle with four draggable corners.
   *
   * A board photographed from a desk has the slide in the middle and a room around it; cutting
   * that away is most of the difference between a question that reads the image and one that
   * cannot. Deliberately a rectangle rather than a full four-point perspective fix — the corners
   * of a projected slide are rarely the problem, the surrounding room is.
   */
  crop(i) {
    const src = this._review[i];
    this._cropI = i;
    openModal(`<div class="cap-crop">
      <div class="card-head"><h3>Trim</h3><span class="muted small">Drag the corners</span></div>
      <div class="crop-stage" id="crop-stage"><img id="crop-img" src="${src}" alt=""><div class="crop-box" id="crop-box">
        ${['tl', 'tr', 'bl', 'br'].map(k => `<span class="ch ${k}" data-h="${k}"></span>`).join('')}
      </div></div>
      <div class="row gap mt">
        <button class="btn primary" data-act="capCropOk">Trim it</button>
        <button class="btn ghost" data-act="capCropAll">Whole photo</button>
      </div>
    </div>`);
    const back = document.querySelector('#modal .modal-back');
    if (back) back.dataset.act = 'capCropAll'; // tapping out goes back to the review, untrimmed
    setTimeout(() => this._wireCrop(), 60);
  },

  _wireCrop() {
    const img = document.getElementById('crop-img'), box = document.getElementById('crop-box');
    const stage = document.getElementById('crop-stage');
    if (!img || !box || !stage) return;

    const place = () => {
      const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
      // Start just inside the photo, which is usually about where the slide sits.
      this._rect = { x: 0.06, y: 0.06, w: 0.88, h: 0.88 };
      this._imgBox = { left: r.left - s.left, top: r.top - s.top, w: r.width, h: r.height };
      draw();
    };
    const draw = () => {
      const b = this._imgBox, r = this._rect;
      box.style.left = (b.left + r.x * b.w) + 'px';
      box.style.top = (b.top + r.y * b.h) + 'px';
      box.style.width = (r.w * b.w) + 'px';
      box.style.height = (r.h * b.h) + 'px';
    };

    if (img.complete) place(); else img.onload = place;
    window.addEventListener('resize', place);

    let grab = null;
    const at = e => { const p = e.touches ? e.touches[0] : e; return { x: p.clientX, y: p.clientY }; };

    const down = e => {
      const h = e.target.closest('[data-h]');
      grab = { k: h ? h.dataset.h : 'move', start: at(e), rect: { ...this._rect } };
      e.preventDefault();
    };
    const move = e => {
      if (!grab) return;
      const p = at(e), b = this._imgBox;
      const dx = (p.x - grab.start.x) / b.w, dy = (p.y - grab.start.y) / b.h;
      const r = { ...grab.rect };
      const lim = v => Math.max(0, Math.min(1, v));

      if (grab.k === 'move') { r.x = lim(r.x + dx); r.y = lim(r.y + dy); }
      else {
        if (grab.k.includes('l')) { const nx = lim(r.x + dx); r.w = r.w + (r.x - nx); r.x = nx; }
        if (grab.k.includes('r')) r.w = r.w + dx;
        if (grab.k.includes('t')) { const ny = lim(r.y + dy); r.h = r.h + (r.y - ny); r.y = ny; }
        if (grab.k.includes('b')) r.h = r.h + dy;
      }
      r.w = Math.max(0.08, Math.min(1 - r.x, r.w));
      r.h = Math.max(0.08, Math.min(1 - r.y, r.h));
      this._rect = r;
      draw();
      e.preventDefault();
    };
    const up = () => { grab = null; };

    box.addEventListener('mousedown', down);
    box.addEventListener('touchstart', down, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
  },

  async cropOk() {
    const i = this._cropI, r = this._rect;
    const src = this._review[i];
    try {
      const img = await new Promise((res, rej) => { const x = new Image(); x.onload = () => res(x); x.onerror = rej; x.src = src; });
      const c = document.createElement('canvas');
      c.width = Math.max(40, Math.round(img.naturalWidth * r.w));
      c.height = Math.max(40, Math.round(img.naturalHeight * r.h));
      c.getContext('2d').drawImage(img,
        Math.round(img.naturalWidth * r.x), Math.round(img.naturalHeight * r.y),
        c.width, c.height, 0, 0, c.width, c.height);
      this._review[i] = c.toDataURL('image/jpeg', 0.88);
    } catch (e) { toast('Could not trim that one'); }
    this._paintReview();
  },

  cropAll() { this._paintReview(); }
};
