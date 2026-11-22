// Home Notes XR – Mixed-Reality-Modus (WebXR, Meta Quest)
//
// Ankerpunkt-Prinzip: Der Quest-Browser erlaubt nur 8 persistente Anker pro Website.
// Notizen hängen deshalb relativ an „Ankerpunkten“; ein neuer Ankerpunkt entsteht nur,
// wenn im Umkreis von 4 m noch keiner existiert. So sind beliebig viele Notizen möglich.
import * as THREE from './vendor/three.module.min.js';
import {
  api, json, remoteLog, setLogSink, newId, COLORS, SpeechRecorder, transcribe,
  pickVideoMime, uploadVideo, fmtDuration,
} from './common.js';

const NOTE_SIZE = 0.16;
const VIDEO_W = 0.36;
const ANCHOR_RADIUS = 4.0;
const MAX_ANCHORS = 8;
const MAX_VIDEO_SECONDS = 180;
const DELETE_CONFIRM_MS = 2500;

// ------------------------------------------------------------------ Zustand
const st = {
  session: null, refSpace: null, opts: {},
  db: { notes: [], anchors: [] },
  anchors: new Map(), // id → { rec, xr, matrix, tracked, failed }
  items: new Map(), // noteId → { note, group, card, frame, video, hidden }
  hitSources: new Map(), lastHit: new Map(), reticles: new Map(), buttons: new Map(),
  planeObjs: new Map(), meshObjs: new Map(), vizOn: true,
  hover: new Map(), // XRInputSource → item
  grab: null, deleteArm: null,
  distance: 0.7, colorIdx: 0,
  pendingText: '', pendingVideo: null,
  dictation: null, recording: null, uploads: 0,
  hud: { msg: 'bereit', dirty: true, last: 0 },
};

let renderer; let scene; let camera; let hudMesh; let hudCanvas; let hudTex; let ghost; let recPreview;
const speech = new SpeechRecorder();

// ------------------------------------------------------------------ Start
export function primeAudio() { speech.prime(); }

export async function startXR(opts) {
  st.opts = opts;
  if (!renderer) initThree();
  const optionalFeatures = ['anchors', 'hand-tracking'];
  if (opts.useScan) optionalFeatures.push('hit-test', 'plane-detection', 'mesh-detection');
  const session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['local-floor'], optionalFeatures });
  st.session = session;
  await renderer.xr.setSession(session);
  st.refSpace = renderer.xr.getReferenceSpace();
  setLogSink((level, msg) => { st.hud.msg = msg.slice(0, 110); st.hud.dirty = true; });

  const feats = session.enabledFeatures ? [...session.enabledFeatures] : [];
  remoteLog('info', `AR gestartet (Scan ${opts.useScan ? 'an' : 'aus'}), Features: ${feats.join(', ') || '?'}`);
  for (const [ev, fn] of [['end', onEnd], ['select', onSelect], ['squeezestart', onSqueezeStart],
    ['squeezeend', onSqueezeEnd], ['inputsourceschange', setupHitTest]]) session.addEventListener(ev, fn);
  setupHitTest();
  renderer.setAnimationLoop(render);
  await loadAndRestore();
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('xr-canvas'), antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

  hudCanvas = document.createElement('canvas');
  hudCanvas.width = 512; hudCanvas.height = 400;
  hudTex = new THREE.CanvasTexture(hudCanvas);
  hudTex.colorSpace = THREE.SRGBColorSpace;
  hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.156),
    new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false }));
  hudMesh.renderOrder = 10;
  hudMesh.position.set(0, 0.08, -0.08);
  hudMesh.rotation.x = -0.7;

  let hudAttached = false;
  [0, 1].forEach((i) => {
    const c = renderer.xr.getController(i);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    ray.scale.z = 0.5;
    c.add(ray);
    c.userData.ray = ray;
    c.addEventListener('connected', (e) => {
      c.userData.handedness = e.data.handedness;
      if (!hudAttached && (e.data.handedness === 'left' || i === 1)) { c.add(hudMesh); hudAttached = true; }
      if (e.data.handedness === 'left' && recPreview) c.add(recPreview);
    });
    scene.add(c);
  });

  ghost = new THREE.Group();
  ghost.visible = false;
  scene.add(ghost);

  recPreview = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.09), new THREE.MeshBasicMaterial({ color: 0x222222 }));
  recPreview.position.set(0, 0.2, -0.06);
  recPreview.rotation.x = -0.5;
  recPreview.visible = false;
}

// ------------------------------------------------------------------ Laden & Anker wiederherstellen
async function loadAndRestore() {
  try { st.db = await api('state'); } catch (e) { remoteLog('error', e); }
  const { session } = st;
  const handles = new Set(st.db.anchors.map((a) => a.handle));

  // verwaiste persistente Anker (z. B. aus v0.1 oder gelöschten Notizen) freigeben → 8er-Limit
  const known = Array.isArray(session.persistentAnchors) ? session.persistentAnchors : [];
  for (const uuid of known) {
    if (!handles.has(uuid)) {
      try { await session.deletePersistentAnchor(uuid); remoteLog('info', `Verwaisten Anker entfernt (${uuid.slice(0, 8)})`); } catch { /* egal */ }
    }
  }

  let ok = 0; let failed = 0;
  for (const rec of st.db.anchors) {
    const entry = { rec, xr: null, matrix: null, tracked: false, failed: false };
    st.anchors.set(rec.id, entry);
    if (!session.restorePersistentAnchor) { entry.failed = true; failed += 1; continue; }
    try {
      entry.xr = await withTimeout(session.restorePersistentAnchor(rec.handle), 10000);
      ok += 1;
    } catch (e) {
      entry.failed = true; failed += 1;
      remoteLog('warn', `Ankerpunkt ${rec.id} nicht gefunden: ${e.message}`);
    }
  }
  for (const note of st.db.notes) {
    // Platzierung mit unbekanntem Ankerpunkt → wieder in die Warteschlange
    if (note.placement && note.placement.anchor && !st.anchors.has(note.placement.anchor)) note.placement = null;
    if (note.placement) addItem(note);
  }
  await pruneAnchors();
  const unplaced = queue().length;
  remoteLog('info', `Geladen: ${st.db.notes.length} Notizen, Ankerpunkte ${ok} ok / ${failed} fehlgeschlagen, ${unplaced} zum Platzieren`);
  st.hud.dirty = true;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]);
}

async function pruneAnchors() {
  const used = new Set(st.db.notes.map((n) => n.placement?.anchor).filter(Boolean));
  for (const [id, entry] of st.anchors) {
    if (used.has(id) || entry.creating) continue;
    try { if (entry.rec?.handle) await st.session?.deletePersistentAnchor?.(entry.rec.handle); } catch { /* egal */ }
    try { entry.xr?.delete(); } catch { /* egal */ }
    st.anchors.delete(id);
    st.db.anchors = st.db.anchors.filter((a) => a.id !== id);
    api(`anchors/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}

// ------------------------------------------------------------------ Darstellung der Notizen
function wrapText(g, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      const test = line ? `${line} ${w}` : w;
      if (g.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function drawCard(canvas, note, { ghostText } = {}) {
  const g = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  g.clearRect(0, 0, W, H);
  if (note.type === 'video') {
    g.fillStyle = 'rgba(20,24,30,0.9)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.font = 'bold 30px sans-serif';
    const lines = wrapText(g, `▶ ${ghostText ?? note.text ?? 'Video-Anleitung'}`, W - 32).slice(0, 2);
    lines.forEach((l, i) => g.fillText(l, 16, 40 + i * 34));
    return;
  }
  g.fillStyle = note.color || COLORS[0];
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.fillRect(0, 0, W, 34);
  g.fillStyle = note.done ? 'rgba(0,0,0,0.4)' : '#222';
  g.font = 'bold 30px sans-serif';
  const lines = wrapText(g, ghostText ?? (note.text || '(leer – A halten zum Diktieren)'), W - 36).slice(0, 7);
  lines.forEach((l, i) => {
    const y = 78 + i * 36;
    g.fillText(l, 18, y);
    if (note.done) { g.fillRect(18, y - 10, g.measureText(l).width, 3); }
  });
  g.font = '18px sans-serif';
  g.fillStyle = 'rgba(0,0,0,0.55)';
  if (note.location) g.fillText(`📍 ${note.location}`.slice(0, 28), 18, H - 18);
  if (note.done) {
    g.fillStyle = '#2b8a3e';
    g.font = 'bold 64px sans-serif';
    g.fillText('✓', W - 64, 60);
  }
}

function makeCanvasMesh(w, h, px) {
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = Math.round(px * (h / w));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true }));
  return { mesh, canvas, tex };
}

function buildItemGroup(note, { asGhost = false, ghostText, blobUrl } = {}) {
  const group = new THREE.Group();
  const item = { note, group, card: null, video: null, frame: null };
  if (note.type === 'video') {
    const video = document.createElement('video');
    video.src = blobUrl || `media/${note.media?.file}`;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = Boolean(asGhost);
    video.muted = Boolean(asGhost);
    video.crossOrigin = 'anonymous';
    if (asGhost) video.play().catch(() => {});
    video.addEventListener('loadeddata', () => { if (!asGhost && video.paused) video.currentTime = Math.min(0.2, video.duration || 0); });
    const vtex = new THREE.VideoTexture(video);
    vtex.colorSpace = THREE.SRGBColorSpace;
    const h = VIDEO_W * 0.75;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(VIDEO_W, h), new THREE.MeshBasicMaterial({ map: vtex, side: THREE.DoubleSide }));
    group.add(screen);
    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth && video.videoHeight) screen.scale.y = (video.videoWidth / video.videoHeight) / (4 / 3);
    });
    const cap = makeCanvasMesh(VIDEO_W, 0.06, 512);
    cap.mesh.position.y = -h / 2 - 0.035;
    group.add(cap.mesh);
    drawCard(cap.canvas, note, { ghostText });
    cap.tex.needsUpdate = true;
    item.video = video; item.card = cap; item.hitMeshes = [screen, cap.mesh];
    item.frame = makeFrame(VIDEO_W + 0.02, h + 0.1, -0.03);
  } else {
    const card = makeCanvasMesh(NOTE_SIZE, NOTE_SIZE, 320);
    drawCard(card.canvas, note, { ghostText });
    card.tex.needsUpdate = true;
    group.add(card.mesh);
    item.card = card; item.hitMeshes = [card.mesh];
    item.frame = makeFrame(NOTE_SIZE + 0.014, NOTE_SIZE + 0.014, 0);
  }
  item.frame.visible = false;
  group.add(item.frame);
  if (asGhost) group.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity = 0.55; } });
  return item;
}

function makeFrame(w, h, yOff) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
  m.position.set(0, yOff, -0.002);
  return m;
}

function redraw(item) {
  drawCard(item.card.canvas, item.note);
  item.card.tex.needsUpdate = true;
}

function addItem(note) {
  removeItem(note.id);
  const item = buildItemGroup(note);
  item.group.matrixAutoUpdate = false;
  item.group.visible = false;
  scene.add(item.group);
  st.items.set(note.id, item);
  return item;
}

function removeItem(id) {
  const item = st.items.get(id);
  if (!item) return;
  scene.remove(item.group);
  disposeTree(item.group);
  if (item.video) { item.video.pause(); item.video.removeAttribute('src'); item.video.load(); }
  st.items.delete(id);
}

function disposeTree(obj) {
  obj.traverse((o) => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
}

// ------------------------------------------------------------------ Platzierung
function queue() {
  const items = [];
  if (st.pendingVideo) items.push({ kind: 'video', label: `Video (${fmtDuration(st.pendingVideo.seconds)})${st.pendingText ? `: ${st.pendingText}` : ''}` });
  else if (st.pendingText) items.push({ kind: 'text', label: st.pendingText });
  const unplaced = st.db.notes.filter((n) => !n.placement && !n.done && !(n.type === 'video' && !n.media?.file))
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  for (const n of unplaced) items.push({ kind: 'note', note: n, label: n.text || (n.type === 'video' ? 'Video' : 'Notiz') });
  return items;
}

function sourcePose(frame, src) {
  const rp = frame.getPose(src.targetRaySpace, st.refSpace);
  if (!rp) return null;
  return new THREE.Matrix4().fromArray(rp.transform.matrix);
}

function camForwardFlat() {
  const v = new THREE.Vector3();
  renderer.xr.getCamera().getWorldDirection(v);
  v.y = 0;
  return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3(0, 0, -1);
}

// Zielpose für eine neue Notiz: auf erkannter Fläche (Scan) oder frei im Raum, aufrecht zum Nutzer gedreht
function targetMatrix(frame, src) {
  const tmp = new THREE.Object3D();
  const hit = st.lastHit.get(src);
  if (hit) {
    const q = new THREE.Quaternion(hit.orientation.x, hit.orientation.y, hit.orientation.z, hit.orientation.w);
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    tmp.position.set(hit.position.x, hit.position.y, hit.position.z).addScaledVector(n, 0.004);
    tmp.up.copy(Math.abs(n.y) > 0.9 ? camForwardFlat() : new THREE.Vector3(0, 1, 0));
    tmp.lookAt(tmp.position.clone().add(n));
  } else {
    const m = sourcePose(frame, src);
    if (!m) return null;
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    tmp.position.copy(origin).addScaledVector(dir, st.distance);
    const facing = origin.clone().sub(tmp.position); facing.y = 0;
    if (facing.lengthSq() < 1e-6) facing.set(0, 0, 1);
    tmp.lookAt(tmp.position.clone().add(facing.normalize()));
  }
  tmp.updateMatrix();
  return tmp.matrix.clone();
}

// Ordnet eine Weltpose einem Ankerpunkt zu (legt bei Bedarf synchron einen neuen an – nur im XR-Event möglich)
function attachToAnchor(frame, world) {
  const pos = new THREE.Vector3().setFromMatrixPosition(world);
  let best = null; let bestD = Infinity;
  for (const [id, a] of st.anchors) {
    if (!a.matrix) continue;
    const d = new THREE.Vector3().setFromMatrixPosition(a.matrix).distanceTo(pos);
    if (d < bestD) { best = id; bestD = d; }
  }
  const canCreate = typeof frame.createAnchor === 'function' && st.anchors.size < MAX_ANCHORS;
  if (best && (bestD <= ANCHOR_RADIUS || !canCreate)) {
    return { anchor: best, rel: new THREE.Matrix4().copy(st.anchors.get(best).matrix).invert().multiply(world).toArray() };
  }
  if (!canCreate) {
    return { anchor: null, rel: world.toArray() }; // ohne Anker: nur für diese Sitzung stabil
  }
  // neuer Ankerpunkt: gleiche Position, nur um die Hochachse gedreht
  const yaw = new THREE.Euler().setFromRotationMatrix(world, 'YXZ').y;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  const am = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
  const id = newId();
  const entry = { rec: null, xr: null, matrix: am.clone(), tracked: false, failed: false, creating: true };
  st.anchors.set(id, entry);
  const promise = frame.createAnchor(new XRRigidTransform({ x: pos.x, y: pos.y, z: pos.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), st.refSpace);
  promise.then(async (xrAnchor) => {
    entry.xr = xrAnchor;
    let handle = null;
    try { handle = await xrAnchor.requestPersistentHandle?.(); } catch (e) { remoteLog('warn', `Persistenter Handle fehlgeschlagen: ${e.message}`); }
    if (handle) {
      entry.rec = await api('anchors', json('POST', { id, handle }));
      st.db.anchors.push(entry.rec);
      remoteLog('info', `Neuer Ankerpunkt (${st.anchors.size}/${MAX_ANCHORS})`);
    }
    entry.creating = false;
  }).catch((e) => { entry.creating = false; remoteLog('warn', `createAnchor: ${e.message}`); });
  return { anchor: id, rel: new THREE.Matrix4().copy(am).invert().multiply(world).toArray() };
}

function onSelect(e) {
  const { frame, inputSource: src } = e;
  if (st.recording || st.recStarting) { remoteLog('info', 'Aufnahme läuft – erst mit X beenden, dann platzieren'); return undefined; }
  const hovered = st.hover.get(src);
  if (hovered && !st.grab) {
    if (hovered.note.type === 'video') toggleVideo(hovered);
    else toggleDone(hovered);
    return;
  }
  const world = targetMatrix(frame, src);
  if (!world) return;
  const next = queue()[0];
  const placement = attachToAnchor(frame, world);

  if (next?.kind === 'video') return placeVideo(placement, world);
  let note;
  if (next?.kind === 'note') {
    note = next.note;
  } else {
    note = {
      id: newId(), type: 'note', text: next?.kind === 'text' ? st.pendingText : '', color: COLORS[st.colorIdx],
      done: false, location: '', media: null, created: Math.floor(Date.now() / 1000),
    };
    st.db.notes.push(note);
    st.pendingText = '';
  }
  note.placement = placement;
  const item = addItem(note);
  item.group.matrix.copy(world); item.group.visible = true;
  saveNote(note, ['type', 'text', 'color', 'done', 'location', 'media', 'placement']);
  remoteLog('info', `Notiz platziert${note.text ? `: „${note.text.slice(0, 40)}“` : ' (leer)'}`);
  return undefined;
}

async function placeVideo(placement, world) {
  const pv = st.pendingVideo;
  st.pendingVideo = null;
  const note = {
    id: newId(), type: 'video', text: st.pendingText || 'Video-Anleitung', color: COLORS[st.colorIdx], done: false,
    location: '', media: null, created: Math.floor(Date.now() / 1000), placement,
  };
  st.pendingText = '';
  st.db.notes.push(note);
  const item = buildItemGroup(note, { blobUrl: pv.url });
  item.group.matrixAutoUpdate = false;
  item.group.matrix.copy(world);
  item.group.visible = true;
  scene.add(item.group);
  st.items.set(note.id, item);
  st.uploads += 1; st.hud.dirty = true;
  remoteLog('info', `Video wird hochgeladen (${Math.round(pv.blob.size / 1024)} KB)…`);
  try {
    const media = await uploadVideo(pv.blob, pv.ext);
    note.media = { ...media, duration: pv.seconds };
    await saveNote(note, ['type', 'text', 'color', 'done', 'location', 'media', 'placement']);
    remoteLog('info', 'Video-Anleitung gespeichert');
  } catch (err) {
    remoteLog('error', `Video-Upload fehlgeschlagen: ${err.message}`);
  } finally {
    st.uploads -= 1; st.hud.dirty = true;
  }
}

async function saveNote(note, fields) {
  const body = { id: note.id };
  for (const f of fields) body[f] = note[f];
  try { await api('notes', json('POST', body)); } catch (err) { remoteLog('error', `Speichern: ${err.message}`); }
  st.hud.dirty = true;
}

function toggleDone(item) {
  item.note.done = !item.note.done;
  redraw(item);
  saveNote(item.note, ['done']);
  remoteLog('info', item.note.done ? 'Abgehakt ✓' : 'Wieder offen');
}

function toggleVideo(item) {
  const v = item.video;
  if (!v) return;
  if (v.paused) { v.muted = false; v.play().catch((err) => remoteLog('warn', `Wiedergabe: ${err.message}`)); } else v.pause();
}

// ------------------------------------------------------------------ Verschieben (Grip)
function onSqueezeStart(e) {
  const { frame, inputSource: src } = e;
  const item = st.hover.get(src);
  if (!item || st.grab) return;
  const ctrl = sourcePose(frame, src);
  if (!ctrl) return;
  st.grab = { src, item, offset: ctrl.clone().invert().multiply(item.group.matrix) };
  item.frame.visible = true;
  item.frame.material.color.set(0x4dabf7);
}

function onSqueezeEnd(e) {
  if (!st.grab || st.grab.src !== e.inputSource) return;
  const { item } = st.grab;
  st.grab = null;
  item.frame.material.color.set(0xffffff);
  item.note.placement = attachToAnchor(e.frame, item.group.matrix.clone());
  saveNote(item.note, ['placement']);
  remoteLog('info', 'Notiz verschoben');
  pruneAnchors();
}

// ------------------------------------------------------------------ Löschen, Farbe, Diktat, Video
async function deleteItem(item) {
  const { note } = item;
  removeItem(note.id);
  st.db.notes = st.db.notes.filter((n) => n.id !== note.id);
  try { await api(`notes/${note.id}`, { method: 'DELETE' }); } catch (err) { remoteLog('error', err); }
  remoteLog('info', `Gelöscht: ${(note.text || note.type).slice(0, 40)}`);
  pruneAnchors();
}

function onDeleteButton(src) {
  const item = st.hover.get(src);
  if (!item) { remoteLog('info', 'Zum Löschen auf eine Notiz zeigen'); return; }
  const now = performance.now();
  if (st.deleteArm?.item === item && now - st.deleteArm.t < DELETE_CONFIRM_MS) {
    st.deleteArm = null;
    deleteItem(item);
  } else {
    st.deleteArm = { item, t: now };
    remoteLog('info', 'Nochmal B drücken = löschen');
  }
}

function onColorButton(src) {
  const item = st.hover.get(src);
  if (item && item.note.type === 'note') {
    const idx = (COLORS.indexOf(item.note.color) + 1) % COLORS.length;
    item.note.color = COLORS[idx];
    redraw(item);
    saveNote(item.note, ['color']);
  } else {
    st.colorIdx = (st.colorIdx + 1) % COLORS.length;
  }
  st.hud.dirty = true;
}

async function dictationStart(src) {
  if (st.dictation) return;
  const target = st.hover.get(src);
  st.dictation = { target: target?.note.type === 'note' ? target : null, starting: true };
  try {
    await speech.start();
    st.dictation.starting = false;
    remoteLog('info', st.dictation.target ? '🎙 Diktat für diese Notiz… (A loslassen)' : '🎙 Diktat für neue Notiz… (A loslassen)');
  } catch (err) {
    st.dictation = null;
    remoteLog('error', `Mikrofon: ${err.message}`);
  }
}

async function dictationStop() {
  const d = st.dictation;
  if (!d) return;
  if (d.starting) { setTimeout(dictationStop, 150); return; }
  st.dictation = null;
  const { wav, seconds } = speech.stop();
  if (seconds < 0.4) { remoteLog('info', 'Zu kurz – A gedrückt halten und sprechen'); return; }
  st.hud.msg = '⏳ Erkenne Sprache…'; st.hud.dirty = true;
  try {
    const text = await transcribe(wav);
    if (!text) { remoteLog('info', 'Nichts erkannt'); return; }
    if (d.target && st.items.get(d.target.note.id)) {
      d.target.note.text = text;
      redraw(d.target);
      saveNote(d.target.note, ['text']);
      remoteLog('info', `Text geändert: „${text.slice(0, 60)}“`);
    } else {
      st.pendingText = text;
      remoteLog('info', `Erkannt: „${text.slice(0, 60)}“ – Trigger zum Platzieren`);
    }
  } catch (err) {
    remoteLog('error', `Spracherkennung: ${err.message}`);
  }
  st.hud.dirty = true;
}

async function toggleRecording() {
  if (st.recStarting) { st.recStopRequested = true; return; } // zweiter Druck, während die Kamera noch startet
  if (st.recording) { if (st.recording.recorder.state === 'recording') st.recording.recorder.stop(); return; }
  st.recStarting = true;
  st.recStopRequested = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const { mime, ext } = pickVideoMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    const chunks = [];
    const started = performance.now();
    recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const seconds = (performance.now() - started) / 1000;
      const blob = new Blob(chunks, { type: recorder.mimeType || `video/${ext}` });
      if (st.pendingVideo) URL.revokeObjectURL(st.pendingVideo.url);
      st.pendingVideo = { blob, ext, seconds, url: URL.createObjectURL(blob) };
      clearTimeout(st.recording?.timer);
      st.recording = null;
      setPreview(null);
      st.ghostKey = null;
      remoteLog('info', `Video aufgenommen (${fmtDuration(seconds)}, ${Math.round(blob.size / 1024)} KB) – Trigger zum Platzieren, A für Titel`);
    };
    recorder.start(1000);
    st.recording = { recorder, started, timer: setTimeout(() => recorder.state === 'recording' && recorder.stop(), MAX_VIDEO_SECONDS * 1000) };
    setPreview(stream);
    const track = stream.getVideoTracks()[0];
    const s = track?.getSettings?.() ?? {};
    remoteLog('info', `● Aufnahme läuft (${s.width ?? '?'}×${s.height ?? '?'}, ${mime || 'Standardformat'}) – X zum Beenden`);
    if (st.recStopRequested) setTimeout(() => recorder.state === 'recording' && recorder.stop(), 1000);
  } catch (err) {
    remoteLog('error', `Kamera: ${err.message} – Kamera-Freigabe auf der Startseite erteilen`);
  } finally {
    st.recStarting = false;
  }
}

function setPreview(stream) {
  if (recPreview.material.map) { recPreview.material.map.dispose(); recPreview.material.map = null; }
  if (stream) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream; v.play().catch(() => {});
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    recPreview.material.map = tex;
    recPreview.material.color.set(0xffffff);
    recPreview.visible = true;
  } else {
    recPreview.visible = false;
  }
  recPreview.material.needsUpdate = true;
}

// ------------------------------------------------------------------ Eingaben pro Frame
function pollInput(frame, dt) {
  for (const src of st.session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const right = src.handedness !== 'left';
    const b4 = Boolean(gp.buttons[4]?.pressed);
    const b5 = Boolean(gp.buttons[5]?.pressed);
    const b3 = Boolean(gp.buttons[3]?.pressed);
    const prev = st.buttons.get(src) ?? { b4: false, b5: false, b3: false };
    if (right) {
      if (b4 && !prev.b4) dictationStart(src); // A gedrückt
      if (!b4 && prev.b4) dictationStop(); // A losgelassen
      if (b5 && !prev.b5) onDeleteButton(src); // B
      const y = gp.axes[3] ?? 0;
      if (Math.abs(y) > 0.2) {
        if (st.grab && st.grab.src === src) {
          const m = new THREE.Matrix4().makeTranslation(0, 0, y * dt * 1.2);
          st.grab.offset.premultiply(m);
        } else {
          st.distance = THREE.MathUtils.clamp(st.distance - y * dt * 1.2, 0.25, 4); // Stick vor = weiter weg
        }
      }
    } else {
      if (b4 && !prev.b4) toggleRecording(); // X
      if (b5 && !prev.b5) onColorButton(src); // Y
      if (b3 && !prev.b3) { st.vizOn = !st.vizOn; remoteLog('info', `Raum-Scan-Anzeige ${st.vizOn ? 'an' : 'aus'}`); }
    }
    st.buttons.set(src, { b4, b5, b3 });
  }
}

const raycaster = new THREE.Raycaster();
function updateHover(frame) {
  const hitMeshes = [];
  for (const item of st.items.values()) if (item.group.visible) for (const m of item.hitMeshes) { m.userData.item = item; hitMeshes.push(m); }
  const hovered = new Set();
  for (const src of st.session.inputSources) {
    if (src.targetRayMode !== 'tracked-pointer') continue;
    const m = sourcePose(frame, src);
    let found = null;
    if (m && !(st.grab && st.grab.src === src)) {
      raycaster.ray.origin.setFromMatrixPosition(m);
      raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
      raycaster.far = 6;
      found = raycaster.intersectObjects(hitMeshes, false)[0]?.object.userData.item ?? null;
    }
    if (found) { st.hover.set(src, found); hovered.add(found); } else st.hover.delete(src);
  }
  const armed = st.deleteArm && performance.now() - st.deleteArm.t < DELETE_CONFIRM_MS ? st.deleteArm.item : null;
  for (const item of st.items.values()) {
    if (st.grab?.item === item) continue;
    item.frame.visible = hovered.has(item) || armed === item;
    item.frame.material.color.set(armed === item ? 0xff4d4d : 0xffffff);
  }
}

// Vorschau („Geist“) der nächsten Platzierung am rechten Controller
function updateGhost(frame) {
  const src = [...st.session.inputSources].find((s) => s.handedness === 'right' && s.targetRayMode === 'tracked-pointer')
    ?? [...st.session.inputSources].find((s) => s.targetRayMode === 'tracked-pointer');
  const show = src && !st.hover.get(src) && !st.grab && !st.recording;
  if (!show) { ghost.visible = false; return; }
  const next = queue()[0];
  const key = next ? `${next.kind}:${next.label}:${st.colorIdx}` : `new:${st.colorIdx}`;
  if (st.ghostKey !== key) {
    st.ghostKey = key;
    ghost.children.slice().forEach((c) => { ghost.remove(c); disposeTree(c); });
    if (st.ghostItem?.video) st.ghostItem.video.pause();
    let note;
    let opts = { asGhost: true };
    if (next?.kind === 'video') {
      note = { type: 'video', text: st.pendingText || 'Video-Anleitung' };
      opts = { ...opts, blobUrl: st.pendingVideo.url };
    } else if (next?.kind === 'note') note = next.note;
    else note = { type: 'note', color: COLORS[st.colorIdx], text: next?.kind === 'text' ? st.pendingText : '' };
    st.ghostItem = buildItemGroup(note, { ...opts, ghostText: next ? undefined : 'Neue Notiz' });
    ghost.add(st.ghostItem.group);
  }
  const m = targetMatrix(frame, src);
  if (!m) { ghost.visible = false; return; }
  ghost.matrixAutoUpdate = false;
  ghost.matrix.copy(m);
  ghost.visible = true;
}

// ------------------------------------------------------------------ Raum-Scan (optional)
function setupHitTest() {
  if (!st.session?.requestHitTestSource || !st.opts.useScan) return;
  for (const src of st.session.inputSources) {
    if (st.hitSources.has(src) || src.targetRayMode !== 'tracked-pointer') continue;
    st.hitSources.set(src, null);
    st.session.requestHitTestSource({ space: src.targetRaySpace })
      .then((h) => st.hitSources.set(src, h))
      .catch((err) => remoteLog('warn', `hit-test: ${err.message}`));
  }
}

function updateScan(frame) {
  for (const [src, hts] of st.hitSources) {
    let r = st.reticles.get(src);
    if (!r) {
      r = new THREE.Mesh(new THREE.RingGeometry(0.025, 0.035, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
      r.matrixAutoUpdate = false;
      scene.add(r);
      st.reticles.set(src, r);
    }
    const res = hts ? frame.getHitTestResults(hts) : [];
    const pose = res.length ? res[0].getPose(st.refSpace) : null;
    if (pose) { r.matrix.fromArray(pose.transform.matrix); r.visible = true; st.lastHit.set(src, pose.transform); } else { r.visible = false; st.lastHit.delete(src); }
  }
  syncScene(frame.detectedPlanes, st.planeObjs, frame, (plane) => new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(plane.polygon.map((p) => new THREE.Vector3(p.x, p.y, p.z))),
    new THREE.LineBasicMaterial({ color: plane.orientation === 'vertical' ? 0x4dabf7 : 0x69db7c }),
  ), (p) => p.planeSpace);
  syncScene(frame.detectedMeshes, st.meshObjs, frame, (mesh) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.vertices), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.12 }));
  }, (m) => m.meshSpace);
}

function syncScene(set, map, frame, build, spaceOf) {
  if (!set) return;
  for (const [k, obj] of map) if (!set.has(k)) { scene.remove(obj); disposeTree(obj); map.delete(k); }
  for (const k of set) {
    let obj = map.get(k);
    if (!obj || obj.userData.t !== k.lastChangedTime) {
      if (obj) { scene.remove(obj); disposeTree(obj); }
      obj = build(k);
      obj.matrixAutoUpdate = false;
      obj.userData.t = k.lastChangedTime;
      scene.add(obj);
      map.set(k, obj);
    }
    const pose = frame.getPose(spaceOf(k), st.refSpace);
    if (pose) obj.matrix.fromArray(pose.transform.matrix);
    obj.visible = st.vizOn && Boolean(pose);
  }
}

// ------------------------------------------------------------------ HUD
function drawHud() {
  const g = hudCanvas.getContext('2d');
  g.clearRect(0, 0, 512, 400);
  g.fillStyle = 'rgba(15,18,24,0.85)';
  g.beginPath(); g.roundRect(0, 0, 512, 400, 24); g.fill();
  g.fillStyle = COLORS[st.colorIdx];
  g.fillRect(456, 20, 34, 34);
  g.fillStyle = '#fff';
  g.font = 'bold 28px sans-serif';
  g.fillText('Home Notes XR', 22, 48);
  g.font = '21px sans-serif';
  const placed = [...st.items.values()].filter((i) => i.group.visible).length;
  const hidden = st.db.notes.filter((n) => n.placement && !st.items.get(n.id)?.group.visible).length;
  const next = queue()[0];
  const lines = [];
  if (st.recording) lines.push(`● REC ${fmtDuration((performance.now() - st.recording.started) / 1000)}  (X = Stopp)`);
  if (st.dictation) lines.push('🎙 Höre zu… (A loslassen)');
  if (st.uploads) lines.push(`⏫ Lade ${st.uploads} Video(s) hoch…`);
  lines.push(`Nächstes: ${next ? next.label.slice(0, 60) : 'neue leere Notiz'}`);
  lines.push(`Sichtbar ${placed} · nicht gefunden ${hidden} · Ankerpunkte ${st.anchors.size}/${MAX_ANCHORS}`);
  lines.push(`Abstand ${st.distance.toFixed(2)} m${st.opts.useScan ? ' · Scan an' : ''}`);
  lines.push(`› ${st.hud.msg}`);
  let y = 86;
  for (const l of lines) for (const part of wrapText(g, l, 470)) { g.fillText(part, 22, y); y += 28; }
  g.font = '17px sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.65)';
  const help = ['Trigger: setzen · auf Notiz: abhaken / Video ▶', 'Grip halten: verschieben · Stick: Abstand',
    'A halten: diktieren · B 2×: löschen', 'X: Video-Aufnahme · Y: Farbe · L-Stick: Scan'];
  y = Math.max(y + 6, 316);
  for (const h of help) { g.fillText(h, 22, y); y += 22; }
  hudTex.needsUpdate = true;
  st.hud.dirty = false;
}

// ------------------------------------------------------------------ Render-Loop
let lastT = 0;
function render(t, frame) {
  const dt = Math.min(0.1, (t - lastT) / 1000 || 0);
  lastT = t;
  if (frame && st.refSpace) {
    for (const a of st.anchors.values()) {
      if (!a.xr) continue;
      const pose = frame.getPose(a.xr.anchorSpace, st.refSpace);
      if (pose) { a.matrix = new THREE.Matrix4().fromArray(pose.transform.matrix); a.tracked = true; } else a.tracked = false;
    }
    for (const item of st.items.values()) {
      if (st.grab?.item === item) continue;
      const pl = item.note.placement;
      if (!pl) { item.group.visible = false; continue; }
      if (!pl.anchor) { item.group.matrix.fromArray(pl.rel); item.group.visible = true; continue; }
      const a = st.anchors.get(pl.anchor);
      if (a?.matrix && (a.tracked || a.creating || !a.xr)) {
        item.group.matrix.multiplyMatrices(a.matrix, new THREE.Matrix4().fromArray(pl.rel));
        item.group.visible = true;
      } else if (!a?.matrix) item.group.visible = false;
    }
    if (st.grab) {
      const m = sourcePose(frame, st.grab.src);
      if (m) st.grab.item.group.matrix.multiplyMatrices(m, st.grab.offset);
    }
    scene.updateMatrixWorld();
    if (st.opts.useScan) updateScan(frame);
    updateHover(frame);
    updateGhost(frame);
    pollInput(frame, dt);
    if (st.recording) st.hud.dirty = true;
  }
  if (st.hud.dirty && t - st.hud.last > 250) { drawHud(); st.hud.last = t; }
  renderer.render(scene, camera);
}

function onEnd() {
  renderer.setAnimationLoop(null);
  if (st.recording) st.recording.recorder.stop();
  speech.release();
  for (const id of [...st.items.keys()]) removeItem(id);
  ghost.children.slice().forEach((c) => { ghost.remove(c); disposeTree(c); });
  for (const obj of [...st.planeObjs.values(), ...st.meshObjs.values(), ...st.reticles.values()]) { scene.remove(obj); disposeTree(obj); }
  for (const m of [st.anchors, st.hitSources, st.lastHit, st.reticles, st.buttons, st.planeObjs, st.meshObjs, st.hover]) m.clear();
  Object.assign(st, { session: null, grab: null, deleteArm: null, dictation: null, ghostKey: null, ghostItem: null });
  setLogSink(null);
  remoteLog('info', 'AR beendet');
  st.opts.onEnd?.();
}
