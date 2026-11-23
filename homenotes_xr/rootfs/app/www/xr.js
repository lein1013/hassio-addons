// Home Notes XR – Mixed-Reality-Modus (WebXR, Meta Quest)
//
// Ankerpunkt-Prinzip: Der Quest-Browser erlaubt nur 8 persistente Anker pro Website.
// Notizen hängen deshalb relativ an „Ankerpunkten“; ein neuer Ankerpunkt entsteht nur,
// wenn im Umkreis von 4 m noch keiner existiert. Der älteste Ankerpunkt ist der
// „Heimat-Anker“: Ursprung der Hauskarte, alle anderen werden relativ dazu eingemessen.
import * as THREE from './vendor/three.module.min.js';
import {
  api, json, remoteLog, setLogSink, newId, COLORS, SpeechRecorder, transcribe,
  pickVideoMime, uploadVideo, fmtDuration, openCamera,
} from './common.js';

const NOTE_SIZE = 0.16;
const VIDEO_W = 0.36;
const ANCHOR_RADIUS = 4.0;
const MAX_ANCHORS = 8;
const MAX_VIDEO_SECONDS = 180;
const MAX_DICTATION_SECONDS = 30;
const CONFIRM_MS = 2500;
const TOOLBAR_LINGER_MS = 2000;
const MAP_PX_PER_M = 28;
const IDENTITY = new THREE.Matrix4().toArray();

// ------------------------------------------------------------------ Zustand
const st = {
  session: null, refSpace: null, opts: {},
  db: { notes: [], anchors: [] },
  anchors: new Map(), // id → { rec, xr, matrix, tracked, failed, creating }
  items: new Map(), // noteId → item
  hitSources: new Map(), lastHit: new Map(), reticles: new Map(), padState: new Map(),
  planeObjs: new Map(), meshObjs: new Map(), vizOn: true,
  hover: new Map(), // XRInputSource → { item?, button? }
  active: null, activeUntil: 0, // Notiz mit sichtbarer Aktionsleiste
  confirm: null,
  grab: null, // { src, item, offset, viaIcon }
  distance: 0.7, colorIdx: 0,
  pendingText: '', pendingVideo: null, pendingNew: false,
  dictation: null, recording: null, recStarting: false, recStopRequested: false, uploads: 0,
  map: { track: [], walls: [], mode: 'follow', buffer: [], wallsBuffer: [], lastPos: null, lastFlush: 0, sentPlanes: new Map(), lastDraw: 0, lastLink: 0 },
  hud: { msg: 'bereit', dirty: true, last: 0 },
};

let renderer; let scene; let camera;
let hud; let ghost; let recPreview; let mapPanel;
const speech = new SpeechRecorder();
const raycaster = new THREE.Raycaster();

// ------------------------------------------------------------------ Start
export function primeAudio() { speech.prime(); }

export async function startXR(opts) {
  st.opts = opts;
  if (!renderer) initThree();
  // „unbounded“ = Bewegen in der ganzen Wohnung: Der Quest-Browser blendet dann keine
  // Begrenzung (Guardian) ein. Anker legen wir trotzdem im „local“-Raum an (robuster).
  const wanted = opts.space || 'unbounded';
  const optionalFeatures = ['anchors', 'hand-tracking'];
  if (wanted === 'unbounded') optionalFeatures.push('unbounded');
  if (opts.useScan) optionalFeatures.push('hit-test', 'plane-detection', 'mesh-detection');
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: wanted === 'local-floor' ? ['local-floor'] : [],
    optionalFeatures,
  });
  st.session = session;
  let refType = wanted;
  if (wanted === 'unbounded') {
    try { await session.requestReferenceSpace('unbounded'); } catch (e) {
      refType = 'local';
      remoteLog('warn', `Raum „unbounded“ nicht verfügbar (${e.message}) – nutze „local“`);
    }
  }
  renderer.xr.setReferenceSpaceType(refType);
  await renderer.xr.setSession(session);
  st.refSpace = renderer.xr.getReferenceSpace();
  st.refType = refType;
  st.anchorSpace = refType === 'unbounded'
    ? await session.requestReferenceSpace('local').catch(() => st.refSpace)
    : st.refSpace;
  setLogSink((level, msg) => { st.hud.msg = msg.slice(0, 120); st.hud.dirty = true; });

  const feats = session.enabledFeatures ? [...session.enabledFeatures] : [];
  remoteLog('info', `AR gestartet (Raum: ${refType}${st.anchorSpace !== st.refSpace ? ', Anker in local' : ''}, Scan ${opts.useScan ? 'an' : 'aus'}), Features: ${feats.join(', ') || '?'}`);
  for (const [ev, fn] of [['end', onEnd], ['select', onSelect], ['squeezestart', onSqueezeStart],
    ['squeezeend', onSqueezeEnd], ['inputsourceschange', setupHitTest]]) session.addEventListener(ev, fn);
  setupHitTest();
  renderer.setAnimationLoop(render);
  await loadAndRestore();
}

// ------------------------------------------------------------------ three.js-Grundgerüst
function canvasPlane(w, h, px, { transparent = true, depthTest = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = Math.round(px * (h / w));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent, depthTest }));
  return { mesh, canvas, tex, ctx: canvas.getContext('2d') };
}

// Knopf-Texturen werden pro (Symbol, Zustand, Hover) einmal gezeichnet und geteilt – spart GPU-Speicher
const buttonTextures = new Map();
const buttonGeo = new Map();
function buttonTexture(symbol, state, hover) {
  const key = `${symbol}|${state}|${hover}`;
  let tex = buttonTextures.get(key);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = state === 'confirm' ? '#e03131' : state === 'on' ? '#2f6fde' : hover ? '#ffffff' : 'rgba(25,28,34,0.88)';
  g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
  g.strokeStyle = hover ? '#4dabf7' : 'rgba(255,255,255,0.8)'; g.lineWidth = hover ? 9 : 5; g.stroke();
  g.fillStyle = hover && state === 'normal' ? '#111' : '#fff';
  g.font = '64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(state === 'confirm' ? '?' : symbol, 64, 68);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.shared = true;
  buttonTextures.set(key, tex);
  return tex;
}

// Runder 3D-Knopf mit Symbol; action wird beim Trigger auf den Knopf ausgeführt
function makeButton(symbol, action, { size = 0.036, item = null } = {}) {
  if (!buttonGeo.has(size)) { const geo = new THREE.PlaneGeometry(size, size); geo.userData.shared = true; buttonGeo.set(size, geo); }
  const mesh = new THREE.Mesh(buttonGeo.get(size), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, side: THREE.DoubleSide }));
  const btn = { mesh, symbol, action, item, state: 'normal', hover: false };
  mesh.renderOrder = 12;
  mesh.userData.button = btn;
  drawButton(btn);
  return btn;
}

function drawButton(btn, { hover = btn.hover } = {}) {
  btn.mesh.material.map = buttonTexture(btn.symbol, btn.state, hover);
  btn.mesh.material.needsUpdate = true;
  btn.hover = hover;
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('xr-canvas'), antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

  // Menü + Status am linken Controller (mit dem rechten Strahl bedienen)
  hud = new THREE.Group();
  hud.position.set(0, 0.075, -0.07);
  hud.rotation.x = -0.75;
  hud.panel = canvasPlane(0.2, 0.11, 512, { depthTest: false });
  hud.panel.mesh.renderOrder = 10;
  hud.add(hud.panel.mesh);
  hud.menu = [
    makeButton('＋', 'newNote'),
    makeButton('🎙', 'dictateMenu'),
    makeButton('●', 'video'),
    makeButton('🗺', 'map'),
    makeButton('▦', 'scanViz'),
  ];
  hud.menu.forEach((b, i) => { b.mesh.position.set(-0.08 + i * 0.04, -0.078, 0.001); hud.add(b.mesh); });

  let hudAttached = false;
  [0, 1].forEach((i) => {
    const c = renderer.xr.getController(i);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    ray.scale.z = 0.5;
    c.add(ray);
    c.addEventListener('connected', (e) => {
      c.userData.handedness = e.data.handedness;
      c.userData.isRight = e.data.handedness === 'right';
      if (!hudAttached && (e.data.handedness === 'left' || i === 1)) { c.add(hud); hudAttached = true; }
      if (e.data.handedness === 'left' && recPreview) c.add(recPreview);
    });
    scene.add(c);
  });

  ghost = new THREE.Group();
  ghost.visible = false;
  ghost.matrixAutoUpdate = false;
  scene.add(ghost);

  recPreview = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.09), new THREE.MeshBasicMaterial({ color: 0x222222 }));
  recPreview.position.set(0, 0.2, -0.06);
  recPreview.rotation.x = -0.5;
  recPreview.visible = false;

  mapPanel = canvasPlane(0.24, 0.24, 512, { depthTest: false });
  mapPanel.mesh.renderOrder = 11;
  mapPanel.mesh.visible = false;
  scene.add(mapPanel.mesh);
}

// ------------------------------------------------------------------ Laden & Anker wiederherstellen
async function loadAndRestore() {
  try {
    st.db = await api('state');
    const map = await api('map');
    st.map.track = map.track || [];
    st.map.walls = map.walls || [];
  } catch (e) { remoteLog('error', e); }
  const { session } = st;
  const handles = new Set(st.db.anchors.map((a) => a.handle));

  // verwaiste persistente Anker freigeben → 8er-Limit
  const known = Array.isArray(session.persistentAnchors) ? [...session.persistentAnchors] : [];
  for (const uuid of known) {
    if (!handles.has(uuid)) {
      try { await session.deletePersistentAnchor(uuid); remoteLog('info', `Verwaisten Anker entfernt (${uuid.slice(0, 8)})`); } catch { /* egal */ }
    }
  }

  let ok = 0; let failed = 0; let gone = 0;
  for (const rec of [...st.db.anchors]) {
    const entry = { rec, xr: null, matrix: null, tracked: false, failed: false };
    st.anchors.set(rec.id, entry);
    if (!session.restorePersistentAnchor) { entry.failed = true; failed += 1; continue; }
    if (Array.isArray(session.persistentAnchors) && !known.includes(rec.handle)) {
      await dropAnchor(rec.id, 'nicht mehr im Browser gespeichert'); gone += 1; continue;
    }
    try {
      entry.xr = await withTimeout(session.restorePersistentAnchor(rec.handle), 10000);
      ok += 1;
    } catch (e) {
      if (/no persistent anchor/i.test(e.message)) { await dropAnchor(rec.id, e.message); gone += 1; continue; }
      entry.failed = true; failed += 1;
      remoteLog('warn', `Ankerpunkt ${rec.id} nicht gefunden: ${e.message}`);
    }
  }
  for (const note of st.db.notes) {
    if (note.placement?.anchor && !st.anchors.has(note.placement.anchor)) {
      note.placement = null; // Ankerpunkt weg → zurück in die Warteschlange
      saveNote(note, ['placement']);
    }
    if (note.placement) addItem(note);
  }
  await ensureHome();
  await pruneAnchors();
  remoteLog('info', `Geladen: ${st.db.notes.length} Einträge · Ankerpunkte ${ok} ok, ${failed} nicht gefunden, ${gone} verloren · ${queue().length} zum Platzieren`);
  st.hud.dirty = true;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]);
}

// Ankerpunkt endgültig entfernen; seine Notizen landen wieder in der Warteschlange
async function dropAnchor(id, why) {
  st.anchors.delete(id);
  st.db.anchors = st.db.anchors.filter((a) => a.id !== id);
  for (const n of st.db.notes) if (n.placement?.anchor === id) n.placement = null;
  try { await api(`anchors/${id}`, { method: 'DELETE' }); } catch { /* egal */ }
  remoteLog('warn', `Ankerpunkt ${id} verloren (${why}) – Notizen wieder in der Warteschlange`);
}

// Heimat-Anker sicherstellen; fehlt er, wird ein anderer eingemessener Ankerpunkt zur neuen Heimat
async function ensureHome() {
  const home = st.db.anchors.find((a) => a.isHome);
  if (home && st.anchors.has(home.id)) return;
  const candidate = st.db.anchors.find((a) => Array.isArray(a.home));
  if (!candidate) {
    const first = st.db.anchors[0];
    if (first) { first.isHome = true; first.home = IDENTITY; await patchAnchor(first, ['isHome', 'home']); }
    return;
  }
  const inv = new THREE.Matrix4().fromArray(candidate.home).invert();
  for (const a of st.db.anchors) {
    if (Array.isArray(a.home)) a.home = new THREE.Matrix4().copy(inv).multiply(new THREE.Matrix4().fromArray(a.home)).toArray();
    a.isHome = a.id === candidate.id;
    await patchAnchor(a, ['home', 'isHome']);
  }
  try { await api('map/rebase', json('POST', { matrix: inv.toArray() })); } catch (e) { remoteLog('warn', e); }
  const map = await api('map').catch(() => null);
  if (map) { st.map.track = map.track; st.map.walls = map.walls; }
  remoteLog('info', 'Heimat-Ankerpunkt neu gesetzt, Karte umgerechnet');
}

async function patchAnchor(rec, keys) {
  const body = {};
  for (const k of keys) body[k] = rec[k];
  try { await api(`anchors/${rec.id}`, json('PATCH', body)); } catch (e) { remoteLog('warn', `Ankerpunkt speichern: ${e.message}`); }
}

async function pruneAnchors() {
  const used = new Set(st.db.notes.map((n) => n.placement?.anchor).filter(Boolean));
  for (const [id, entry] of st.anchors) {
    if (used.has(id) || entry.creating || entry.rec?.isHome || entry.isHome) continue; // Heimat bleibt für die Karte
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
    wrapText(g, `🎬 ${ghostText ?? note.text ?? 'Video-Anleitung'}`, W - 32).slice(0, 2).forEach((l, i) => g.fillText(l, 16, 40 + i * 34));
    return;
  }
  g.fillStyle = note.color || COLORS[0];
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.fillRect(0, 0, W, 34);
  g.fillStyle = note.done ? 'rgba(0,0,0,0.4)' : '#222';
  g.font = 'bold 30px sans-serif';
  const lines = wrapText(g, ghostText ?? (note.text || '(leer – 🎙 zum Diktieren)'), W - 36).slice(0, 7);
  lines.forEach((l, i) => {
    const y = 78 + i * 36;
    g.fillText(l, 18, y);
    if (note.done) g.fillRect(18, y - 10, g.measureText(l).width, 3);
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

function buildItemGroup(note, { asGhost = false, ghostText, blobUrl } = {}) {
  const group = new THREE.Group();
  const item = { note, group, card: null, video: null, frame: null, toolbar: null, buttons: [] };
  let bottom;
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
    video.addEventListener('play', () => { if (item.playBtn) { item.playBtn.symbol = '⏸'; drawButton(item.playBtn); } });
    video.addEventListener('pause', () => { if (item.playBtn) { item.playBtn.symbol = '▶'; drawButton(item.playBtn); } });
    const vtex = new THREE.VideoTexture(video);
    vtex.colorSpace = THREE.SRGBColorSpace;
    const h = VIDEO_W * 0.75;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(VIDEO_W, h), new THREE.MeshBasicMaterial({ map: vtex, side: THREE.DoubleSide }));
    group.add(screen);
    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth && video.videoHeight) screen.scale.y = (video.videoWidth / video.videoHeight) / (4 / 3);
    });
    const cap = canvasPlane(VIDEO_W, 0.06, 512);
    cap.mesh.position.y = -h / 2 - 0.035;
    group.add(cap.mesh);
    drawCard(cap.canvas, note, { ghostText });
    cap.tex.needsUpdate = true;
    item.video = video; item.card = cap; item.hitMeshes = [screen, cap.mesh];
    item.frame = makeFrame(VIDEO_W + 0.02, h + 0.1, -0.03);
    bottom = -h / 2 - 0.07;
  } else {
    const card = canvasPlane(NOTE_SIZE, NOTE_SIZE, 320);
    drawCard(card.canvas, note, { ghostText });
    card.tex.needsUpdate = true;
    group.add(card.mesh);
    item.card = card; item.hitMeshes = [card.mesh];
    item.frame = makeFrame(NOTE_SIZE + 0.014, NOTE_SIZE + 0.014, 0);
    bottom = -NOTE_SIZE / 2;
  }
  item.frame.visible = false;
  group.add(item.frame);
  if (asGhost) {
    group.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity = 0.55; } });
    return item;
  }
  // Aktionsleiste unter der Notiz
  const defs = note.type === 'video'
    ? [['▶', 'play'], ['🎙', 'dictate'], ['✥', 'move'], ['🗑', 'delete']]
    : [['✓', 'done'], ['🎙', 'dictate'], ['✥', 'move'], ['🎨', 'color'], ['🗑', 'delete']];
  item.toolbar = new THREE.Group();
  item.toolbar.position.set(0, bottom - 0.028, 0.004);
  defs.forEach(([sym, action], i) => {
    const btn = makeButton(sym, action, { item });
    btn.mesh.position.x = (i - (defs.length - 1) / 2) * 0.042;
    item.toolbar.add(btn.mesh);
    item.buttons.push(btn);
    if (action === 'play') item.playBtn = btn;
    if (action === 'done') item.doneBtn = btn;
  });
  if (item.doneBtn && note.done) { item.doneBtn.state = 'on'; drawButton(item.doneBtn); }
  item.toolbar.visible = false;
  group.add(item.toolbar);
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
  if (item.doneBtn) { item.doneBtn.state = item.note.done ? 'on' : 'normal'; drawButton(item.doneBtn); }
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
  if (st.active === item) st.active = null;
  st.items.delete(id);
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.material) { if (o.material.map && !o.material.map.userData.shared) o.material.map.dispose(); o.material.dispose(); }
  });
}

// ------------------------------------------------------------------ Warteschlange & Platzierung
function queue() {
  const items = [];
  if (st.pendingVideo) items.push({ kind: 'video', label: `Video (${fmtDuration(st.pendingVideo.seconds)})${st.pendingText ? `: ${st.pendingText}` : ''}` });
  else if (st.pendingText) items.push({ kind: 'text', label: st.pendingText });
  else if (st.pendingNew) items.push({ kind: 'new', label: 'Neue Notiz (danach sprechen)' });
  const unplaced = st.db.notes.filter((n) => !n.placement && !n.done && !(n.type === 'video' && !n.media?.file))
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  for (const n of unplaced) items.push({ kind: 'note', note: n, label: n.text || (n.type === 'video' ? 'Video' : 'Notiz') });
  return items;
}

function sourcePose(frame, src) {
  const rp = frame.getPose(src.targetRaySpace, st.refSpace);
  return rp ? new THREE.Matrix4().fromArray(rp.transform.matrix) : null;
}

function camForwardFlat() {
  const v = new THREE.Vector3();
  renderer.xr.getCamera().getWorldDirection(v);
  v.y = 0;
  return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3(0, 0, -1);
}

// Zielpose: auf erkannter Fläche (Scan) oder frei im Raum, aufrecht zum Nutzer gedreht
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

// Weltpose einem Ankerpunkt zuordnen (legt bei Bedarf synchron einen neuen an – nur im XR-Event möglich)
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
  if (!canCreate) return { anchor: null, rel: world.toArray() };
  const yaw = new THREE.Euler().setFromRotationMatrix(world, 'YXZ').y;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  const am = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
  const id = newId();
  const isHome = !st.db.anchors.some((a) => a.isHome) && ![...st.anchors.values()].some((a) => a.isHome);
  const entry = { rec: null, xr: null, matrix: am.clone(), tracked: false, failed: false, creating: true, isHome };
  st.anchors.set(id, entry);
  let promise;
  try {
    // Pose in den Anker-Raum umrechnen (bei „unbounded“ ist das der „local“-Raum)
    let ap = pos; let aq = q;
    if (st.anchorSpace !== st.refSpace) {
      const t = frame.getPose(st.refSpace, st.anchorSpace);
      if (!t) throw new Error('Anker-Raum nicht verfügbar');
      const m = new THREE.Matrix4().fromArray(t.transform.matrix).multiply(am);
      ap = new THREE.Vector3(); aq = new THREE.Quaternion();
      m.decompose(ap, aq, new THREE.Vector3());
    }
    promise = frame.createAnchor(new XRRigidTransform({ x: ap.x, y: ap.y, z: ap.z }, { x: aq.x, y: aq.y, z: aq.z, w: aq.w }), st.anchorSpace);
  } catch (e) {
    st.anchors.delete(id);
    remoteLog('warn', `createAnchor: ${e.message}`);
    return { anchor: null, rel: world.toArray() };
  }
  promise.then(async (xrAnchor) => {
    entry.xr = xrAnchor;
    let handle = null;
    try { handle = await xrAnchor.requestPersistentHandle?.(); } catch (e) { remoteLog('warn', `Persistenter Handle fehlgeschlagen: ${e.message}`); }
    if (handle) {
      // Einmessen relativ zur Heimat, falls diese gerade sichtbar ist
      const homeW = homeWorld();
      const home = isHome ? IDENTITY : (homeW ? homeW.clone().invert().multiply(am).toArray() : null);
      entry.rec = await api('anchors', json('POST', { id, handle, isHome, home }));
      st.db.anchors.push(entry.rec);
      remoteLog('info', `Neuer Ankerpunkt${isHome ? ' (Heimat der Karte)' : ''} (${st.anchors.size}/${MAX_ANCHORS})`);
    }
    entry.creating = false;
  }).catch((e) => { entry.creating = false; remoteLog('warn', `createAnchor: ${e.message}`); });
  return { anchor: id, rel: new THREE.Matrix4().copy(am).invert().multiply(world).toArray() };
}

function placeNext(frame, src) {
  const next = queue()[0];
  if (!next) {
    remoteLog('info', 'Nichts zu platzieren – Menü links: ＋ Notiz, 🎙 Diktat oder ● Video');
    return;
  }
  const world = targetMatrix(frame, src);
  if (!world) return;
  const placement = attachToAnchor(frame, world);
  if (next.kind === 'video') { placeVideo(placement, world); return; }
  let note;
  if (next.kind === 'note') note = next.note;
  else {
    note = {
      id: newId(), type: 'note', text: next.kind === 'text' ? st.pendingText : '', color: COLORS[st.colorIdx],
      done: false, location: '', media: null, created: Math.floor(Date.now() / 1000),
    };
    st.db.notes.push(note);
    st.pendingText = '';
    st.pendingNew = false;
  }
  note.placement = placement;
  const item = addItem(note);
  item.group.matrix.copy(world); item.group.visible = true;
  saveNote(note, ['type', 'text', 'color', 'done', 'location', 'media', 'placement']);
  remoteLog('info', `Notiz platziert${note.text ? `: „${note.text.slice(0, 40)}“` : ''}`);
  if (next.kind === 'new') dictationStart(src, item, 'toggle'); // gleich losreden
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
    note.media = { ...media, duration: pv.seconds, camera: pv.camera };
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

// ------------------------------------------------------------------ Trigger / Select
function onSelect(e) {
  const { frame, inputSource: src } = e;
  const hov = st.hover.get(src);
  if (hov?.button) { runButton(hov.button, frame, src); return; }
  if (st.grab?.viaIcon && st.grab.src === src) { finishGrab(frame); return; }
  if (st.dictation?.mode === 'toggle') { dictationStop(); return; }
  if (st.recording || st.recStarting) { remoteLog('info', 'Aufnahme läuft – mit ● im Menü oder X beenden'); return; }
  if (hov?.item) {
    if (hov.item.note.type === 'video') toggleVideo(hov.item);
    else activate(hov.item); // Aktionsleiste zeigen
    return;
  }
  placeNext(frame, src);
}

function needsConfirm(key) {
  const now = performance.now();
  if (st.confirm?.key === key && now - st.confirm.t < CONFIRM_MS) { st.confirm = null; return false; }
  st.confirm = { key, t: now };
  return true;
}

function runButton(btn, frame, src) {
  const { item } = btn;
  switch (btn.action) {
    case 'done': toggleDone(item); break;
    case 'play': toggleVideo(item); break;
    case 'dictate':
      if (st.dictation) dictationStop(); else dictationStart(src, item, 'toggle');
      break;
    case 'move': startGrab(frame, src, item, true); break;
    case 'color': recolor(item); break;
    case 'delete':
      if (needsConfirm(`del:${item.note.id}`)) {
        btn.state = 'confirm'; drawButton(btn);
        remoteLog('info', 'Nochmal 🗑 = löschen');
        setTimeout(() => { if (btn.state === 'confirm') { btn.state = 'normal'; drawButton(btn); } }, CONFIRM_MS);
      } else deleteItem(item);
      break;
    case 'newNote':
      st.pendingNew = !st.pendingNew; st.ghostKey = null;
      if (st.pendingNew) remoteLog('info', 'Neue Notiz: mit Trigger platzieren, danach sprechen');
      break;
    case 'dictateMenu':
      if (st.dictation) dictationStop(); else dictationStart(src, null, 'toggle');
      break;
    case 'video': toggleRecording(); break;
    case 'map': cycleMap(); break;
    case 'scanViz':
      st.vizOn = !st.vizOn;
      remoteLog('info', st.opts.useScan ? `Raum-Scan-Anzeige ${st.vizOn ? 'an' : 'aus'}` : 'Raum-Scan ist auf der Startseite ausgeschaltet');
      break;
    default: break;
  }
  st.hud.dirty = true;
}

function activate(item) {
  if (!item.toolbar) return;
  if (st.active && st.active !== item && st.active.toolbar) st.active.toolbar.visible = false;
  st.active = item;
  st.activeUntil = performance.now() + TOOLBAR_LINGER_MS;
  item.toolbar.visible = true;
}

function toggleDone(item) {
  item.note.done = !item.note.done;
  redraw(item);
  saveNote(item.note, ['done']);
  remoteLog('info', item.note.done ? 'Abgehakt ✓' : 'Wieder offen');
}

function recolor(item) {
  const idx = (COLORS.indexOf(item.note.color) + 1) % COLORS.length;
  item.note.color = COLORS[idx];
  redraw(item);
  saveNote(item.note, ['color']);
}

function toggleVideo(item) {
  const v = item.video;
  if (!v) return;
  if (v.paused) { v.muted = false; v.play().catch((err) => remoteLog('warn', `Wiedergabe: ${err.message}`)); } else v.pause();
}

// ------------------------------------------------------------------ Verschieben (Grip oder ✥)
function startGrab(frame, src, item, viaIcon) {
  if (st.grab) return;
  const ctrl = sourcePose(frame, src);
  if (!ctrl) return;
  st.grab = { src, item, viaIcon, offset: ctrl.clone().invert().multiply(item.group.matrix) };
  item.frame.visible = true;
  item.frame.material.color.set(0x4dabf7);
  if (item.toolbar) item.toolbar.visible = false;
  if (viaIcon) remoteLog('info', 'Verschieben – Trigger zum Absetzen (Stick: näher/weiter)');
}

function finishGrab(frame) {
  const { item } = st.grab;
  st.grab = null;
  item.frame.material.color.set(0xffffff);
  item.note.placement = attachToAnchor(frame, item.group.matrix.clone());
  saveNote(item.note, ['placement']);
  remoteLog('info', 'Notiz verschoben');
  pruneAnchors();
}

function onSqueezeStart(e) {
  const hov = st.hover.get(e.inputSource);
  if (hov?.item && !hov.button) startGrab(e.frame, e.inputSource, hov.item, false);
}

function onSqueezeEnd(e) {
  if (st.grab && !st.grab.viaIcon && st.grab.src === e.inputSource) finishGrab(e.frame);
}

async function deleteItem(item) {
  const { note } = item;
  removeItem(note.id);
  st.db.notes = st.db.notes.filter((n) => n.id !== note.id);
  try { await api(`notes/${note.id}`, { method: 'DELETE' }); } catch (err) { remoteLog('error', err); }
  remoteLog('info', `Gelöscht: ${(note.text || note.type).slice(0, 40)}`);
  pruneAnchors();
}

// ------------------------------------------------------------------ Diktat
async function dictationStart(src, item, mode) {
  if (st.dictation) return;
  st.dictation = { target: item ?? null, mode, starting: true };
  try {
    await speech.start();
    st.dictation.starting = false;
    st.dictation.timer = setTimeout(() => dictationStop(), MAX_DICTATION_SECONDS * 1000);
    const how = mode === 'toggle' ? 'Trigger zum Beenden' : 'A loslassen';
    remoteLog('info', item ? `🎙 Sprich jetzt… (${how})` : `🎙 Text für nächste Notiz… (${how})`);
  } catch (err) {
    st.dictation = null;
    remoteLog('error', `Mikrofon: ${err.message}`);
  }
}

async function dictationStop() {
  const d = st.dictation;
  if (!d) return;
  if (d.starting) { setTimeout(dictationStop, 150); return; }
  clearTimeout(d.timer);
  st.dictation = null;
  const { wav, seconds } = speech.stop();
  if (seconds < 0.4) { remoteLog('info', 'Zu kurz – länger sprechen'); return; }
  st.hud.msg = '⏳ Erkenne Sprache…'; st.hud.dirty = true;
  try {
    const text = await transcribe(wav);
    if (!text) { remoteLog('info', 'Nichts erkannt'); return; }
    if (d.target && st.items.get(d.target.note.id)) {
      d.target.note.text = text;
      redraw(d.target);
      saveNote(d.target.note, ['text']);
      remoteLog('info', `Text: „${text.slice(0, 60)}“`);
    } else {
      st.pendingText = text;
      remoteLog('info', `Erkannt: „${text.slice(0, 60)}“ – Trigger zum Platzieren`);
    }
  } catch (err) {
    remoteLog('error', `Spracherkennung: ${err.message}`);
  }
  st.hud.dirty = true;
}

// ------------------------------------------------------------------ Video-Aufnahme
async function toggleRecording() {
  if (st.recStarting) { st.recStopRequested = true; return; }
  if (st.recording) { if (st.recording.recorder.state === 'recording') st.recording.recorder.stop(); return; }
  st.recStarting = true;
  st.recStopRequested = false;
  try {
    const { stream, label, how, cams } = await openCamera(true);
    remoteLog('info', `Kameras: ${cams.map((c) => c.label || '(ohne Name)').join(' | ')} → nutze „${label}“ (${how})`);
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
      st.pendingVideo = { blob, ext, seconds, url: URL.createObjectURL(blob), camera: label };
      clearTimeout(st.recording?.timer);
      st.recording = null;
      setPreview(null);
      st.ghostKey = null;
      remoteLog('info', `Video aufgenommen (${fmtDuration(seconds)}, ${Math.round(blob.size / 1024)} KB, ${Math.round((blob.size * 8) / 1000 / Math.max(1, seconds))} kbit/s) – Trigger zum Platzieren`);
    };
    recorder.start(1000);
    st.recording = { recorder, started, timer: setTimeout(() => recorder.state === 'recording' && recorder.stop(), MAX_VIDEO_SECONDS * 1000) };
    setPreview(stream);
    const s = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    remoteLog('info', `● Aufnahme (${s.width ?? '?'}×${s.height ?? '?'}, ${mime || 'Standard'}) – ● oder X zum Beenden`);
    if (st.recStopRequested) setTimeout(() => recorder.state === 'recording' && recorder.stop(), 1000);
  } catch (err) {
    remoteLog('error', `Kamera: ${err.message} – Kamera auf der Startseite wählen und freigeben`);
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

// ------------------------------------------------------------------ Eingaben pro Frame (physische Tasten als Abkürzung)
function pollInput(frame, dt) {
  for (const src of st.session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const right = src.handedness !== 'left';
    const b4 = Boolean(gp.buttons[4]?.pressed);
    const b5 = Boolean(gp.buttons[5]?.pressed);
    const b3 = Boolean(gp.buttons[3]?.pressed);
    const prev = st.padState.get(src) ?? { b4: false, b5: false, b3: false };
    if (right) {
      if (b4 && !prev.b4 && !st.dictation) dictationStart(src, st.hover.get(src)?.item ?? null, 'hold');
      if (!b4 && prev.b4 && st.dictation?.mode === 'hold') dictationStop();
      if (b5 && !prev.b5) {
        const h = st.hover.get(src)?.item;
        if (h) { if (needsConfirm(`del:${h.note.id}`)) remoteLog('info', 'Nochmal B = löschen'); else deleteItem(h); }
      }
      const y = gp.axes[3] ?? 0;
      if (Math.abs(y) > 0.2) {
        if (st.grab && st.grab.src === src) st.grab.offset.premultiply(new THREE.Matrix4().makeTranslation(0, 0, y * dt * 1.2));
        else { st.distance = THREE.MathUtils.clamp(st.distance - y * dt * 1.2, 0.25, 4); st.hud.dirty = true; }
      }
    } else {
      if (b4 && !prev.b4) toggleRecording(); // X
      if (b5 && !prev.b5) { // Y
        const h = [...st.hover.values()].find((x) => x.item)?.item;
        if (h?.note.type === 'note') recolor(h); else st.colorIdx = (st.colorIdx + 1) % COLORS.length;
        st.hud.dirty = true;
      }
      if (b3 && !prev.b3) cycleMap();
    }
    st.padState.set(src, { b4, b5, b3 });
  }
}

function isOnController(obj, src) {
  let p = obj.parent;
  while (p && !p.userData?.handedness) p = p.parent;
  return p?.userData?.handedness === src.handedness;
}

function updateHover(frame) {
  const targets = [];
  for (const item of st.items.values()) {
    if (!item.group.visible || st.grab?.item === item) continue;
    for (const m of item.hitMeshes) { m.userData.item = item; targets.push(m); }
    if (item.toolbar?.visible) for (const b of item.buttons) targets.push(b.mesh);
  }
  if (hud.parent) for (const b of hud.menu) targets.push(b.mesh);

  const hoveredButtons = new Set();
  for (const src of st.session.inputSources) {
    if (src.targetRayMode !== 'tracked-pointer') continue;
    const m = sourcePose(frame, src);
    let found = null;
    if (m && !(st.grab && st.grab.src === src)) {
      raycaster.ray.origin.setFromMatrixPosition(m);
      raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
      raycaster.far = 6;
      const own = (o) => o.userData.button && !o.userData.button.item && isOnController(hud, src);
      const hit = raycaster.intersectObjects(targets, false).find((h) => !own(h.object)); // eigenes Menü nicht anpeilen
      if (hit) {
        const btn = hit.object.userData.button;
        found = btn ? { button: btn, item: btn.item } : { item: hit.object.userData.item };
      }
    }
    if (found) st.hover.set(src, found); else st.hover.delete(src);
    if (found?.button) hoveredButtons.add(found.button);
    if (found?.item) activate(found.item);
  }
  for (const b of [...hud.menu, ...(st.active?.buttons ?? [])]) {
    const h = hoveredButtons.has(b);
    if (h !== b.hover) drawButton(b, { hover: h });
  }
  const now = performance.now();
  if (st.active && now > st.activeUntil && !st.grab) { st.active.toolbar.visible = false; st.active = null; }
  for (const item of st.items.values()) {
    if (st.grab?.item === item) continue;
    item.frame.visible = st.active === item;
  }
  setMenuState('dictateMenu', Boolean(st.dictation));
  setMenuState('video', Boolean(st.recording));
  setMenuState('newNote', st.pendingNew);
  setMenuState('map', st.map.mode !== 'off');
}

function setMenuState(action, on) {
  const b = hud.menu.find((x) => x.action === action);
  const state = on ? 'on' : 'normal';
  if (b && b.state !== state) { b.state = state; drawButton(b); }
}

// Vorschau („Geist“) der nächsten Platzierung – nur wenn etwas in der Warteschlange ist
function updateGhost(frame) {
  const sources = [...st.session.inputSources].filter((s) => s.targetRayMode === 'tracked-pointer');
  const src = sources.find((s) => s.handedness === 'right') ?? sources[0];
  const next = queue()[0];
  const show = src && next && !st.hover.get(src) && !st.grab && !st.recording;
  if (!show) { ghost.visible = false; return; }
  const key = `${next.kind}:${next.label}:${st.colorIdx}`;
  if (st.ghostKey !== key) {
    st.ghostKey = key;
    ghost.children.slice().forEach((c) => { ghost.remove(c); disposeTree(c); });
    if (st.ghostItem?.video) st.ghostItem.video.pause();
    let note;
    let opts = { asGhost: true };
    if (next.kind === 'video') {
      note = { type: 'video', text: st.pendingText || 'Video-Anleitung' };
      opts = { ...opts, blobUrl: st.pendingVideo.url };
    } else if (next.kind === 'note') note = next.note;
    else note = { type: 'note', color: COLORS[st.colorIdx], text: next.kind === 'text' ? st.pendingText : '' };
    st.ghostItem = buildItemGroup(note, { ...opts, ghostText: next.kind === 'new' ? 'Neue Notiz' : undefined });
    ghost.add(st.ghostItem.group);
  }
  const m = targetMatrix(frame, src);
  if (!m) { ghost.visible = false; return; }
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
  ), (p) => p.planeSpace, collectWall);
  syncScene(frame.detectedMeshes, st.meshObjs, frame, (mesh) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.vertices), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.12 }));
  }, (m) => m.meshSpace);
}

function syncScene(set, map, frame, build, spaceOf, onPose) {
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
    if (pose) { obj.matrix.fromArray(pose.transform.matrix); onPose?.(k, obj.matrix); }
    obj.visible = st.vizOn && Boolean(pose);
  }
}

// ------------------------------------------------------------------ Hauskarte
// Weltpose des Heimat-Ankers – direkt oder über einen anderen eingemessenen, sichtbaren Ankerpunkt
function homeWorld() {
  let fallback = null;
  for (const a of st.anchors.values()) {
    const rec = a.rec;
    if (!a.matrix || !a.tracked || !Array.isArray(rec?.home)) continue;
    const hw = a.matrix.clone().multiply(new THREE.Matrix4().fromArray(rec.home).invert());
    if (rec.isHome) return hw;
    fallback ??= hw;
  }
  return fallback;
}

function linkAnchors() {
  const hw = homeWorld();
  if (!hw) return;
  const inv = hw.clone().invert();
  for (const a of st.anchors.values()) {
    if (!a.rec || Array.isArray(a.rec.home) || !a.tracked || !a.matrix) continue;
    a.rec.home = inv.clone().multiply(a.matrix).toArray();
    patchAnchor(a.rec, ['home']);
    remoteLog('info', `Ankerpunkt ${a.rec.id} in die Karte eingemessen`);
  }
}

function recordTrack(now) {
  const hw = homeWorld();
  if (!hw) return;
  const head = new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
  if (st.map.lastPos && st.map.lastPos.distanceTo(head) < 0.3) return;
  st.map.lastPos = head.clone();
  const p = head.applyMatrix4(hw.clone().invert());
  const pt = [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10];
  st.map.track.push(pt);
  st.map.buffer.push(pt);
  if (st.map.buffer.length >= 25 || now - st.map.lastFlush > 5000) flushMap(now);
}

function collectWall(plane, matrix) {
  if (plane.orientation !== 'vertical' || st.map.sentPlanes.get(plane) === plane.lastChangedTime) return;
  const hw = homeWorld();
  if (!hw) return;
  st.map.sentPlanes.set(plane, plane.lastChangedTime);
  const toHome = hw.clone().invert().multiply(matrix);
  const pts = plane.polygon.map((p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(toHome));
  let a = null; let b = null; let best = 0;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
      if (d > best) { best = d; a = pts[i]; b = pts[j]; }
    }
  }
  if (!a || best < 0.3) return;
  const w = [a.x, a.z, b.x, b.z].map((v) => Math.round(v * 20) / 20);
  st.map.walls.push(w);
  st.map.wallsBuffer.push(w);
}

function flushMap(now, { beacon = false } = {}) {
  st.map.lastFlush = now;
  if (!st.map.buffer.length && !st.map.wallsBuffer.length) return;
  const body = { track: st.map.buffer.splice(0), walls: st.map.wallsBuffer.splice(0) };
  if (beacon && navigator.sendBeacon) { navigator.sendBeacon('api/map', JSON.stringify(body)); return; }
  api('map', json('POST', body)).catch((e) => remoteLog('warn', `Karte speichern: ${e.message}`));
}
// Tab wird geschlossen/verlassen, ohne dass die AR-Sitzung sauber endet → Wegpunkte trotzdem sichern
window.addEventListener('pagehide', () => flushMap(performance.now(), { beacon: true }));

function rightController() {
  const c0 = renderer.xr.getController(0);
  return c0.userData.isRight ? c0 : renderer.xr.getController(1);
}

function cycleMap() {
  const order = ['follow', 'hand', 'off'];
  st.map.mode = order[(order.indexOf(st.map.mode) + 1) % order.length];
  remoteLog('info', { follow: 'Karte oben rechts', hand: 'Karte am rechten Controller', off: 'Karte aus' }[st.map.mode]);
  if (st.map.mode === 'hand') {
    rightController().add(mapPanel.mesh);
    mapPanel.mesh.position.set(0, 0.07, -0.1);
    mapPanel.mesh.rotation.set(-0.9, 0, 0);
    mapPanel.mesh.scale.setScalar(0.7);
  } else {
    scene.add(mapPanel.mesh);
    mapPanel.mesh.scale.setScalar(1);
  }
  mapPanel.mesh.visible = st.map.mode !== 'off';
}

const followTarget = new THREE.Vector3();
function updateMapPanel(now) {
  if (st.map.mode === 'off') { mapPanel.mesh.visible = false; return; }
  mapPanel.mesh.visible = true;
  if (st.map.mode === 'follow') {
    // „Lazy follow“: rechts oben im Blickfeld, folgt dem Kopf weich
    const m = renderer.xr.getCamera().matrixWorld;
    const right = new THREE.Vector3(1, 0, 0).transformDirection(m);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(m);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m);
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    followTarget.copy(pos).addScaledVector(fwd, 0.8).addScaledVector(right, 0.33).addScaledVector(up, 0.2);
    if (mapPanel.mesh.position.lengthSq() === 0) mapPanel.mesh.position.copy(followTarget);
    mapPanel.mesh.position.lerp(followTarget, 0.08);
    mapPanel.mesh.lookAt(pos);
  }
  if (now - st.map.lastDraw > 250) { drawMap(); st.map.lastDraw = now; }
}

function drawMap() {
  const g = mapPanel.ctx;
  const S = 512; const C = S / 2;
  g.clearRect(0, 0, S, S);
  g.fillStyle = 'rgba(12,15,20,0.82)';
  g.beginPath(); g.arc(C, C, C - 4, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 4; g.stroke();
  const hw = homeWorld();
  const cam = renderer.xr.getCamera();
  g.textAlign = 'center';
  if (!hw) {
    g.fillStyle = '#fff'; g.font = '28px sans-serif';
    if (st.db.anchors.length) g.fillText('Suche Ankerpunkt…', C, C);
    else { g.fillText('Karte startet mit', C, C - 14); g.fillText('der ersten Notiz', C, C + 22); }
    mapPanel.tex.needsUpdate = true;
    return;
  }
  const inv = hw.clone().invert();
  const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).applyMatrix4(inv);
  const dir = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld).transformDirection(inv);
  const yaw = Math.atan2(dir.x, -dir.z); // Blickrichtung zeigt auf der Karte nach oben
  const cos = Math.cos(-yaw); const sin = Math.sin(-yaw);
  const toPx = (x, z) => {
    const dx = x - head.x; const dz = z - head.z;
    return [C + (dx * cos - dz * sin) * MAP_PX_PER_M, C + (dx * sin + dz * cos) * MAP_PX_PER_M];
  };
  g.save();
  g.beginPath(); g.arc(C, C, C - 8, 0, Math.PI * 2); g.clip();
  g.fillStyle = 'rgba(140,160,190,0.35)';
  for (const [x, z] of st.map.track) {
    const [px, py] = toPx(x, z);
    if (px > -10 && px < S + 10 && py > -10 && py < S + 10) g.fillRect(px - 4, py - 4, 8, 8);
  }
  g.strokeStyle = '#fff'; g.lineWidth = 4;
  for (const [x1, z1, x2, z2] of st.map.walls) {
    const [a1, b1] = toPx(x1, z1); const [a2, b2] = toPx(x2, z2);
    g.beginPath(); g.moveTo(a1, b1); g.lineTo(a2, b2); g.stroke();
  }
  for (const n of st.db.notes) {
    const pl = n.placement;
    if (!pl?.anchor) continue;
    const rec = st.db.anchors.find((a) => a.id === pl.anchor);
    if (!Array.isArray(rec?.home)) continue;
    const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(rec.home).multiply(new THREE.Matrix4().fromArray(pl.rel)));
    const [px, py] = toPx(p.x, p.z);
    g.fillStyle = n.type === 'video' ? '#ff6b6b' : (n.done ? 'rgba(180,180,180,0.7)' : n.color || COLORS[0]);
    if (n.type === 'video') { g.beginPath(); g.moveTo(px - 9, py - 11); g.lineTo(px + 12, py); g.lineTo(px - 9, py + 11); g.fill(); } else g.fillRect(px - 9, py - 9, 18, 18);
  }
  g.restore();
  g.fillStyle = '#4dabf7';
  g.beginPath(); g.moveTo(C, C - 18); g.lineTo(C + 12, C + 12); g.lineTo(C, C + 5); g.lineTo(C - 12, C + 12); g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = '20px sans-serif';
  g.fillText(`Ø ${Math.round((2 * C) / MAP_PX_PER_M)} m`, C, S - 22);
  mapPanel.tex.needsUpdate = true;
}

// ------------------------------------------------------------------ HUD
function drawHud() {
  const g = hud.panel.ctx;
  const W = hud.panel.canvas.width; const H = hud.panel.canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(15,18,24,0.86)';
  g.beginPath(); g.roundRect(0, 0, W, H, 22); g.fill();
  g.fillStyle = COLORS[st.colorIdx];
  g.fillRect(W - 50, 16, 30, 30);
  g.fillStyle = '#fff';
  g.font = 'bold 24px sans-serif';
  g.fillText('Home Notes XR', 18, 38);
  g.font = '19px sans-serif';
  const next = queue()[0];
  const lines = [];
  if (st.recording) lines.push(`● REC ${fmtDuration((performance.now() - st.recording.started) / 1000)}`);
  if (st.dictation) lines.push('🎙 Höre zu…');
  if (st.uploads) lines.push(`⏫ Lade ${st.uploads} Video(s) hoch…`);
  lines.push(next ? `Nächstes: ${next.label.slice(0, 50)}` : `Warteschlange leer · Raum: ${st.refType}`);
  lines.push(`› ${st.hud.msg}`);
  let y = 70;
  for (const l of lines) for (const part of wrapText(g, l, W - 36).slice(0, 3)) { if (y < H - 8) { g.fillText(part, 18, y); y += 24; } }
  hud.panel.tex.needsUpdate = true;
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
    if (t - st.map.lastLink > 1000) { linkAnchors(); st.map.lastLink = t; }
    recordTrack(t);
    updateMapPanel(t);
    if (st.recording || st.dictation) st.hud.dirty = true;
  }
  if (st.hud.dirty && t - st.hud.last > 250) { drawHud(); st.hud.last = t; }
  renderer.render(scene, camera);
}

function onEnd() {
  renderer.setAnimationLoop(null);
  if (st.recording) st.recording.recorder.stop();
  if (st.dictation) { clearTimeout(st.dictation.timer); speech.stop(); st.dictation = null; }
  speech.release();
  flushMap(performance.now());
  for (const id of [...st.items.keys()]) removeItem(id);
  ghost.children.slice().forEach((c) => { ghost.remove(c); disposeTree(c); });
  for (const obj of [...st.planeObjs.values(), ...st.meshObjs.values(), ...st.reticles.values()]) { scene.remove(obj); disposeTree(obj); }
  for (const m of [st.anchors, st.hitSources, st.lastHit, st.reticles, st.padState, st.planeObjs, st.meshObjs, st.hover, st.map.sentPlanes]) m.clear();
  Object.assign(st, { session: null, grab: null, confirm: null, active: null, ghostKey: null, ghostItem: null, pendingNew: false });
  st.map.lastPos = null;
  setLogSink(null);
  remoteLog('info', 'AR beendet');
  st.opts.onEnd?.();
}
