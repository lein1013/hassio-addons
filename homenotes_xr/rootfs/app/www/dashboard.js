// Home Notes XR – Übersicht (Desktop in der HA-Seitenleiste und 2D-Seite auf der Quest)
import {
  api, json, remoteLog, escapeHtml, COLORS, SpeechRecorder, transcribe, fmtDuration,
  listCameras, cameraScore, savedCameraId, saveCameraId,
} from './common.js';

const $ = (id) => document.getElementById(id);
const view = { type: 'all', status: 'open', q: '' };
let notes = [];
let info = null;
let newColor = 0;
let xrModule = null;

// ------------------------------------------------------------------ Start
async function init() {
  try { info = await api('info'); } catch (e) { remoteLog('error', e); }
  renderChips();
  renderNewForm();
  setupFilters();
  await setupXR();
  await refresh();
  setInterval(() => { if (!editing()) refresh(); }, 15000);
  $('map-reset').onclick = async () => {
    if (!confirm('Gelaufene Wege und Wände der Karte löschen? Notizen bleiben erhalten.')) return;
    await api('map', { method: 'DELETE' });
    renderMap();
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !editing()) refresh(); });
}

function editing() {
  const el = document.activeElement;
  return el && $('grid').contains(el) && ['TEXTAREA', 'INPUT'].includes(el.tagName);
}

function renderChips() {
  const chips = [];
  chips.push(`<span class="chip">v${escapeHtml(info?.version ?? '?')}</span>`);
  chips.push(`<span class="chip">${info?.via === 'ingress' ? 'Home Assistant' : `Port ${location.port || 443}`}</span>`);
  if (info?.stt?.entity) chips.push(`<span class="chip ok" title="${escapeHtml(info.stt.entity)}">🎙 ${escapeHtml(info.stt.entity.replace('stt.', ''))} (${escapeHtml(info.stt.language)})</span>`);
  else chips.push(`<span class="chip bad" title="${escapeHtml(info?.stt?.error ?? '')}">🎙 keine Spracherkennung</span>`);
  $('chips').innerHTML = chips.join('');
}

// ------------------------------------------------------------------ XR-Bereich
async function setupXR() {
  let xrOk = false;
  if (navigator.xr && window.isSecureContext) {
    try { xrOk = await navigator.xr.isSessionSupported('immersive-ar'); } catch { /* nein */ }
  }
  const inFrame = window.self !== window.top;
  if (xrOk) {
    $('xr-status').textContent = 'Bereit. Notizen und Videos erscheinen dort, wo du sie platziert hast.';
    $('start-ar').hidden = false;
    $('xr-options').hidden = false;
    $('use-mapping').checked = localStorage.getItem('homenotes.mapping') !== '0';
    $('use-mapping').onchange = () => localStorage.setItem('homenotes.mapping', $('use-mapping').checked ? '1' : '0');
    $('use-scan').checked = localStorage.getItem('homenotes.useScan') === '1';
    $('use-scan').onchange = () => localStorage.setItem('homenotes.useScan', $('use-scan').checked ? '1' : '0');
    $('space-mode').value = localStorage.getItem('homenotes.space') || 'unbounded';
    $('space-mode').onchange = () => localStorage.setItem('homenotes.space', $('space-mode').value);
    $('grant').onclick = grantMedia;
    checkPermissions();
    $('start-ar').onclick = async () => {
      try {
        xrModule ??= await import('./xr.js');
        xrModule.primeAudio(); // in der Klick-Geste, sonst bleibt das Mikrofon stumm
        await xrModule.startXR({ useScan: $('use-scan').checked, space: $('space-mode').value, mapping: $('use-mapping').checked, onEnd: () => refresh() });
      } catch (err) {
        remoteLog('error', `AR-Start fehlgeschlagen: ${err.message}`);
        alert(`AR konnte nicht starten: ${err.message}`);
      }
    };
  } else {
    const httpsUrl = `https://${location.hostname}:${info?.https_port ?? 8443}/`;
    $('xr-status').textContent = navigator.xr
      ? (window.isSecureContext ? 'Dieses Gerät unterstützt kein Mixed Reality.' : 'Mixed Reality braucht HTTPS.')
      : 'Übersicht. Für Mixed Reality die Seite im Quest-Browser öffnen:';
    $('xr-links').hidden = false;
    $('xr-links').innerHTML = `<p class="row"><a class="btn primary" href="${httpsUrl}" target="_blank" rel="noopener">${httpsUrl}</a>
      ${inFrame ? `<a class="btn" href="${location.href}" target="_blank" rel="noopener">In neuem Tab öffnen</a>` : ''}</p>
      <p class="hint">Im Heimnetz z. B. https://10.0.0.100:8443/ – die Zertifikatswarnung einmal mit „Erweitert → Weiter“ bestätigen.</p>`;
  }
  remoteLog('info', `Übersicht geladen via=${info?.via} secure=${window.isSecureContext} xr=${xrOk} ua=${navigator.userAgent}`);
}

async function grantMedia() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const v = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    stream.getTracks().forEach((t) => t.stop());
    $('grant-status').textContent = '✓ freigegeben';
    remoteLog('info', `Kamera/Mikrofon freigegeben ${v.width}x${v.height}`);
    await setupCameraPicker();
  } catch (err) {
    $('grant-status').textContent = `✗ ${err.message}`;
    remoteLog('warn', `Freigabe: ${err.message}`);
  }
}

async function checkPermissions() {
  try {
    const [cam, mic] = await Promise.all(['camera', 'microphone'].map((n) => navigator.permissions.query({ name: n })));
    if (cam.state === 'granted' && mic.state === 'granted') {
      $('grant-status').textContent = '✓ bereits freigegeben';
      await setupCameraPicker();
    }
  } catch { /* Permissions-API nicht verfügbar */ }
}

// Kamera-Auswahl mit Live-Vorschau – die Quest bietet Passthrough- und virtuelle Kameras an
let previewStream = null;
async function setupCameraPicker() {
  const cams = await listCameras();
  if (!cams.length) return;
  const sel = $('camera-select');
  const saved = savedCameraId();
  const best = [...cams].sort((a, b) => cameraScore(b.label) - cameraScore(a.label))[0];
  sel.innerHTML = cams.map((c, i) => `<option value="${escapeHtml(c.deviceId)}">${escapeHtml(c.label || `Kamera ${i + 1}`)}${c === best ? ' (empfohlen)' : ''}</option>`).join('');
  sel.value = cams.some((c) => c.deviceId === saved) ? saved : best.deviceId;
  $('cam-box').hidden = false;
  remoteLog('info', `Kameras: ${cams.map((c) => `${c.label || '?'}`).join(' | ')}`);
  const show = async () => {
    saveCameraId(sel.value);
    previewStream?.getTracks().forEach((t) => t.stop());
    try {
      previewStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: sel.value } } });
      $('cam-preview').srcObject = previewStream;
      await $('cam-preview').play().catch(() => {});
      const s = previewStream.getVideoTracks()[0]?.getSettings?.() ?? {};
      remoteLog('info', `Kamera-Vorschau: ${sel.selectedOptions[0]?.textContent} ${s.width}x${s.height}`);
    } catch (err) { remoteLog('warn', `Kamera-Vorschau: ${err.message}`); }
  };
  sel.onchange = show;
  await show();
  // Vorschau stoppen, sobald AR startet (Kamera wird dort neu geöffnet)
  $('start-ar').addEventListener('click', () => { previewStream?.getTracks().forEach((t) => t.stop()); previewStream = null; }, { once: true });
}

// ------------------------------------------------------------------ Neue Notiz
function renderNewForm() {
  const box = $('new-colors');
  box.innerHTML = '';
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch${i === newColor ? ' on' : ''}`;
    b.style.background = c;
    b.onclick = () => { newColor = i; renderNewForm(); };
    box.appendChild(b);
  });
  $('new-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('new-text').value.trim();
    if (!text) return;
    await api('notes', json('POST', { type: 'note', text, location: $('new-location').value.trim(), color: COLORS[newColor] }));
    $('new-text').value = '';
    refresh();
  };
  if (window.isSecureContext && navigator.mediaDevices && info?.stt?.entity) setupMic($('new-mic'), $('new-text'));
}

function setupMic(btn, target) {
  btn.hidden = false;
  const rec = new SpeechRecorder();
  let busy = false;
  const start = async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    rec.prime();
    try { await rec.start(); btn.classList.add('rec'); } catch (err) { busy = false; alert(`Mikrofon: ${err.message}`); }
  };
  const stop = async () => {
    if (!busy || !rec.active) return;
    btn.classList.remove('rec');
    const { wav, seconds } = rec.stop();
    rec.release();
    try {
      if (seconds > 0.4) {
        btn.textContent = '⏳';
        const text = await transcribe(wav);
        if (text) target.value = target.value ? `${target.value} ${text}` : text;
      }
    } catch (err) { alert(err.message); }
    btn.textContent = '🎙';
    busy = false;
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
}

// ------------------------------------------------------------------ Liste
function setupFilters() {
  for (const [boxId, key] of [['type-tabs', 'type'], ['status-tabs', 'status']]) {
    $(boxId).querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        view[key] = b.dataset[key];
        $(boxId).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        render();
      };
    });
  }
  $('search').oninput = () => { view.q = $('search').value.trim().toLowerCase(); render(); };
}

async function refresh() {
  try {
    const db = await api('state');
    notes = db.notes || [];
  } catch (e) { remoteLog('error', e); }
  render();
  renderMap();
}

// ------------------------------------------------------------------ Hauskarte (Draufsicht)
function notePos(n, anchors) {
  const pl = n.placement;
  const a = anchors.find((x) => x.id === pl?.anchor);
  if (!Array.isArray(a?.home)) return null;
  const H = a.home; const [tx, ty, tz] = [pl.rel[12], pl.rel[13], pl.rel[14]];
  return [H[0] * tx + H[4] * ty + H[8] * tz + H[12], H[2] * tx + H[6] * ty + H[10] * tz + H[14]];
}

let mapPins = [];
async function renderMap() {
  let map;
  try { map = await api('map'); } catch (e) { remoteLog('error', e); return; }
  const pins = map.notes.map((n) => ({ n, p: notePos(n, map.anchors) })).filter((x) => x.p);
  const anchors = map.anchors.filter((a) => Array.isArray(a.home)).map((a) => ({ a, p: [a.home[12], a.home[14]] }));
  const grid = map.grid || [];
  const walls = grid.filter(([, , o, f]) => o >= 2 && o / (o + f) > 0.45).length;
  $('map-stats').textContent = `${grid.length} Rasterzellen · ${walls} Wandzellen · ${pins.length} Einträge auf der Karte`;
  const xs = []; const zs = [];
  for (const [ix, iz] of grid) { xs.push(ix / 10); zs.push(iz / 10); }
  for (const [x, z] of map.track) { xs.push(x); zs.push(z); }
  for (const w of map.walls) { xs.push(w[0], w[2]); zs.push(w[1], w[3]); }
  for (const { p } of [...pins, ...anchors]) { xs.push(p[0]); zs.push(p[1]); }
  const box = $('map');
  if (!xs.length) {
    box.innerHTML = '<div class="empty">Noch keine Karte. Sie entsteht im Headset beim Herumgehen, sobald die erste Notiz platziert ist: Der Tiefensensor tastet Wände und freie Flächen ab, mit jedem Rundgang wird der Grundriss genauer.</div>';
    mapPins = [];
    return;
  }
  const lo = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
  const hi = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
  const pad = 0.8;
  const minX = lo(xs) - pad; const maxX = hi(xs) + pad; const minZ = lo(zs) - pad; const maxZ = hi(zs) + pad;
  const w = Math.max(maxX - minX, 4); const h = Math.max(maxZ - minZ, 3);
  let canvas = box.querySelector('canvas');
  if (!canvas) { box.innerHTML = '<canvas></canvas><p class="hint legend">■ Wand/Möbel · <span style="color:#4dabf7">■</span> frei · ◆ Ankerpunkt (blau = Heimat) · ● Notiz · ▶ Video – Klick auf ein Symbol zeigt den Eintrag</p>'; canvas = box.querySelector('canvas'); canvas.onclick = onMapClick; }
  const dpr = window.devicePixelRatio || 1;
  const cssW = box.clientWidth || 800;
  const cssH = Math.min(560, Math.max(240, cssW * (h / w)));
  canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  const s = Math.min(cssW / w, cssH / h);
  const ox = (cssW - w * s) / 2 - minX * s; const oz = (cssH - h * s) / 2 - minZ * s;
  const X = (x) => ox + x * s; const Z = (z) => oz + z * s;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  g.fillStyle = dark ? '#161a20' : '#f1f3f6'; g.fillRect(0, 0, cssW, cssH);
  g.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'; g.lineWidth = 1;
  for (let x = Math.ceil(minX); x <= maxX; x += 1) { g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), cssH); g.stroke(); }
  for (let z = Math.ceil(minZ); z <= maxZ; z += 1) { g.beginPath(); g.moveTo(0, Z(z)); g.lineTo(cssW, Z(z)); g.stroke(); }
  const cs = Math.max(1, 0.1 * s);
  if (!grid.length) { g.fillStyle = 'rgba(77,171,247,0.3)'; for (const [x, z] of map.track) g.fillRect(X(x) - 0.15 * s, Z(z) - 0.15 * s, 0.3 * s, 0.3 * s); }
  for (const [ix, iz, o, f] of grid) {
    const pOcc = o / (o + f);
    if (o >= 2 && pOcc > 0.45) g.fillStyle = dark ? '#e9ecef' : '#343a40';
    else if (f >= 1 && pOcc < 0.3) g.fillStyle = 'rgba(77,171,247,0.28)';
    else continue;
    g.fillRect(X(ix / 10) - cs / 2, Z(iz / 10) - cs / 2, cs, cs);
  }
  g.strokeStyle = '#f59f00'; g.lineWidth = Math.max(2, 0.06 * s); g.lineCap = 'round';
  for (const [x1, z1, x2, z2] of map.walls) { g.beginPath(); g.moveTo(X(x1), Z(z1)); g.lineTo(X(x2), Z(z2)); g.stroke(); }
  for (const { a, p } of anchors) {
    const r = 7; g.fillStyle = a.isHome ? '#2f6fde' : '#868e96';
    g.beginPath(); g.moveTo(X(p[0]), Z(p[1]) - r); g.lineTo(X(p[0]) + r, Z(p[1])); g.lineTo(X(p[0]), Z(p[1]) + r); g.lineTo(X(p[0]) - r, Z(p[1])); g.fill();
  }
  mapPins = [];
  for (const { n, p } of pins) {
    const px = X(p[0]); const pz = Z(p[1]);
    g.fillStyle = n.type === 'video' ? '#e8590c' : (n.done ? '#adb5bd' : (n.color || COLORS[0]));
    g.strokeStyle = '#222'; g.lineWidth = 1.5;
    g.beginPath();
    if (n.type === 'video') { g.moveTo(px - 8, pz - 10); g.lineTo(px + 11, pz); g.lineTo(px - 8, pz + 10); g.closePath(); } else g.arc(px, pz, 8, 0, Math.PI * 2);
    g.fill(); g.stroke();
    mapPins.push({ id: n.id, x: px, z: pz, text: n.text });
  }
  canvas.title = '';
}

function onMapClick(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - r.left; const z = e.clientY - r.top;
  const pin = mapPins.map((p) => ({ ...p, d: Math.hypot(p.x - x, p.z - z) })).sort((a, b) => a.d - b.d)[0];
  if (!pin || pin.d > 16) return;
  const card = document.querySelector(`[data-note="${pin.id}"]`);
  if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600); }
}

function visible(n) {
  if (view.type !== 'all' && (n.type || 'note') !== view.type) return false;
  if (view.status === 'open' && n.done) return false;
  if (view.status === 'done' && !n.done) return false;
  if (view.q && !`${n.text} ${n.location}`.toLowerCase().includes(view.q)) return false;
  return true;
}

function render() {
  const list = notes.filter(visible).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const all = notes.length;
  const videos = notes.filter((n) => n.type === 'video').length;
  const open = notes.filter((n) => !n.done).length;
  const waiting = notes.filter((n) => !n.placement && !n.done).length;
  $('summary').textContent = `${all} Einträge · ${all - videos} Post-its · ${videos} Videos · ${open} offen${waiting ? ` · ${waiting} warten auf Platzierung im Headset` : ''}`;
  const grid = $('grid');
  if (!list.length) { grid.innerHTML = '<div class="empty">Keine Einträge für diesen Filter.</div>'; return; }
  grid.replaceChildren(...list.map(card));
}

function card(n) {
  const el = document.createElement('article');
  el.className = `note${n.done ? ' done' : ''}`;
  el.dataset.note = n.id;
  const when = n.created ? new Date(n.created * 1000).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' }) : '';
  const placed = n.placement ? '⚓ im Raum platziert' : '⏳ wartet auf Platzierung';
  const video = n.type === 'video'
    ? (n.media?.file ? `<video controls preload="metadata" src="media/${escapeHtml(n.media.file)}"></video>` : '<p class="hint">Video wird noch hochgeladen…</p>')
    : '';
  el.innerHTML = `
    <div class="bar" style="background:${escapeHtml(n.color || COLORS[0])}"></div>
    <div class="body">
      ${video}
      <textarea rows="2" aria-label="Text">${escapeHtml(n.text)}</textarea>
      <input class="loc" placeholder="Ort" value="${escapeHtml(n.location || '')}">
      ${n.transcript ? `<details class="transcript"><summary>Transkript</summary><p>${escapeHtml(n.transcript)}</p></details>` : ''}
      <div class="meta"><span>${n.type === 'video' ? `🎬 Video ${fmtDuration(n.media?.duration)}` : '📝 Post-it'}</span><span>${placed}</span><span>${when}</span></div>
    </div>
    <div class="actions">
      <label class="check"><input type="checkbox" ${n.done ? 'checked' : ''}> erledigt</label>
      <span class="spacer"></span>
      <span class="swatches"></span>
      ${n.placement ? '<button data-act="replace" title="Im Headset neu platzieren">Neu platzieren</button>' : ''}
      <button data-act="delete" class="danger">Löschen</button>
    </div>`;

  const [textEl, locEl] = [el.querySelector('textarea'), el.querySelector('input.loc')];
  const save = async (patch) => {
    try {
      const updated = await api(`notes/${n.id}`, json('PATCH', patch));
      Object.assign(n, updated);
    } catch (err) { alert(err.message); }
  };
  textEl.onchange = () => save({ text: textEl.value.trim() });
  locEl.onchange = () => save({ location: locEl.value.trim() });
  el.querySelector('input[type=checkbox]').onchange = async (e) => { await save({ done: e.target.checked }); render(); };
  const sw = el.querySelector('.swatches');
  if (n.type !== 'video') {
    COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.className = `swatch${c === n.color ? ' on' : ''}`;
      b.style.background = c;
      b.title = 'Farbe';
      b.onclick = async () => { await save({ color: c }); render(); };
      sw.appendChild(b);
    });
  }
  el.querySelector('[data-act=delete]').onclick = async () => {
    if (!confirm(`„${(n.text || 'Eintrag').slice(0, 60)}“ löschen?${n.type === 'video' ? ' Das Video wird ebenfalls gelöscht.' : ''}`)) return;
    await api(`notes/${n.id}`, { method: 'DELETE' });
    refresh();
  };
  const rep = el.querySelector('[data-act=replace]');
  if (rep) rep.onclick = async () => { await save({ placement: null }); render(); };
  return el;
}

init();
