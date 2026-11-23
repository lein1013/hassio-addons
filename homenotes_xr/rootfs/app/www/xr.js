// Home Notes XR – Mixed-Reality-Modus (WebXR, Meta Quest)
//
// Ankerpunkt-Prinzip: Der Quest-Browser erlaubt nur 8 persistente Anker pro Website.
// Notizen hängen deshalb relativ an „Ankerpunkten“; ein neuer Ankerpunkt entsteht nur,
// wenn im Umkreis von 4 m noch keiner existiert. Der älteste Ankerpunkt ist der
// „Heimat-Anker“: Ursprung der Hauskarte, alle anderen werden relativ dazu eingemessen.
//
// Grundriss: Ein Fächer aus Treffertest-Strahlen (Tiefensensor der Quest 3) tastet beim
// Herumgehen Wände und freie Flächen ab. Die Treffer landen in einem 10-cm-Belegungsraster,
// das mit jedem Rundgang genauer wird.
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
const CELL = 0.1; // Rasterweite des Grundrisses in Metern
const IDENTITY = new THREE.Matrix4().toArray();
const MAP_KEY = 'homenotes.mapPlacement';

// ------------------------------------------------------------------ Zustand
const st = {
  session: null, refSpace: null, anchorSpace: null, refType: '', opts: {},
  db: { notes: [], anchors: [] },
  anchors: new Map(), // id → { rec, xr, matrix, tracked, failed, creating }
  items: new Map(), // noteId → item
  hitSources: new Map(), lastHit: new Map(), reticles: new Map(), padState: new Map(),
  planeObjs: new Map(), meshObjs: new Map(), vizOn: true,
  hover: new Map(), // XRInputSource → { item?, button?, panel?, pbtn?, mesh? }
  active: null, activeUntil: 0,
  confirm: null,
  grab: null, // Notiz greifen: { src, item, offset, viaIcon }
  panelGrab: null, // Panel greifen: { src, panel, offset }
  distance: 0.7, colorIdx: 0,
  pendingText: '', pendingVideo: null, pendingNew: false, queueFront: null,
  dictation: null, uploads: 0,
  rec: { state: 'idle', recorder: null, started: 0, timer: null, audio: null, discard: false },
  ui: { menuVisible: true, view: 'main', ovFilter: 'open', ovPage: 0, ovConfirm: null },
  guide: null,
  map: {
    track: [], walls: [], grid: new Map(), delta: new Map(), gridDirty: true,
    buffer: [], wallsBuffer: [], lastPos: null, lastFlush: 0, sentPlanes: new Map(), lastDraw: 0, lastLink: 0,
    mode: 'follow', offset: null,
  },
  mapping: { sources: [], floorY: null, frame: 0, hits: 0 },
  hud: { msg: 'bereit', dirty: true, last: 0 },
};

let renderer; let scene; let camera;
let menu; let mapPanel; let overview; let ghost; let recPreview; let guideLine;
const speech = new SpeechRecorder();
const videoSpeech = new SpeechRecorder();
const raycaster = new THREE.Raycaster();

// ------------------------------------------------------------------ Start
export function primeAudio() { speech.prime(); videoSpeech.prime(); }

export async function startXR(opts) {
  st.opts = { mapping: true, ...opts };
  if (!renderer) initThree();
  // „unbounded“ = ganze Wohnung: Der Quest-Browser blendet dann keine Begrenzung ein.
  const wanted = opts.space || 'unbounded';
  const optionalFeatures = ['anchors', 'hand-tracking'];
  if (wanted === 'unbounded') optionalFeatures.push('unbounded');
  if (st.opts.mapping || opts.useScan) optionalFeatures.push('hit-test');
  if (opts.useScan) optionalFeatures.push('plane-detection', 'mesh-detection');
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
  setLogSink((level, msg) => { st.hud.msg = msg.slice(0, 140); st.hud.dirty = true; });
  loadMapPlacement();

  const feats = session.enabledFeatures ? [...session.enabledFeatures] : [];
  remoteLog('info', `AR gestartet (Raum: ${refType}${st.anchorSpace !== st.refSpace ? ', Anker in local' : ''}, Grundriss ${st.opts.mapping ? 'an' : 'aus'}, Scan ${opts.useScan ? 'an' : 'aus'}), Features: ${feats.join(', ') || '?'}`);
  for (const [ev, fn] of [['end', onEnd], ['select', onSelect], ['squeezestart', onSqueezeStart],
    ['squeezeend', onSqueezeEnd], ['inputsourceschange', setupHitTest]]) session.addEventListener(ev, fn);
  setupHitTest();
  renderer.setAnimationLoop(render);
  await loadAndRestore();
  await setupMapping(session);
}

// ------------------------------------------------------------------ Bausteine: Canvas-Flächen, runde Knöpfe, Panels
function canvasPlane(w, h, px, { transparent = true, depthTest = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = Math.round(px * (h / w));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent, depthTest }));
  return { mesh, canvas, tex, ctx: canvas.getContext('2d') };
}

// Runde Knöpfe (Aktionsleiste an Notizen): Texturen pro Symbol/Zustand einmal zeichnen und teilen
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

// Panel: eine Canvas-Fläche mit beschrifteten Knöpfen; Treffer über die UV-Koordinate des Strahls
class Panel {
  constructor(w, h, px) {
    Object.assign(this, canvasPlane(w, h, px, { depthTest: false }));
    this.W = this.canvas.width; this.H = this.canvas.height;
    this.mesh.renderOrder = 10;
    this.mesh.userData.panel = this;
    this.buttons = []; this.hoverId = null; this.drawFn = null;
  }

  render(drawFn = this.drawFn) {
    this.drawFn = drawFn;
    this.buttons = [];
    this.ctx.clearRect(0, 0, this.W, this.H);
    drawFn?.(this.ctx, this);
    this.tex.needsUpdate = true;
  }

  background(radius = 24) {
    const g = this.ctx;
    g.fillStyle = 'rgba(15,18,24,0.9)';
    g.beginPath(); g.roundRect(0, 0, this.W, this.H, radius); g.fill();
  }

  button(id, x, y, w, h, label, { action, data, fill, active = false, disabled = false, size = 24 } = {}) {
    this.buttons.push({ id, x, y, w, h, action, data, disabled });
    const g = this.ctx;
    const hover = this.hoverId === id && !disabled;
    g.fillStyle = fill ?? (active ? '#2f6fde' : hover ? 'rgba(77,171,247,0.55)' : 'rgba(255,255,255,0.12)');
    g.beginPath(); g.roundRect(x, y, w, h, 14); g.fill();
    if (hover) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke(); }
    g.fillStyle = disabled ? 'rgba(255,255,255,0.35)' : '#fff';
    g.font = `${size}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, x + w / 2, y + h / 2 + 1, w - 14);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }

  hit(uv) {
    const x = uv.x * this.W; const y = (1 - uv.y) * this.H;
    return this.buttons.find((b) => !b.disabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) ?? null;
  }

  setHover(id) { if (id !== this.hoverId) { this.hoverId = id; this.render(); } }
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('xr-canvas'), antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

  // Menü am linken Controller (mit dem rechten Strahl bedienen)
  menu = new Panel(0.2, 0.15, 512);
  menu.mesh.position.set(0, 0.085, -0.075);
  menu.mesh.rotation.x = -0.75;

  let menuAttached = false;
  [0, 1].forEach((i) => {
    const c = renderer.xr.getController(i);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    ray.scale.z = 0.5;
    c.add(ray);
    c.addEventListener('connected', (e) => {
      c.userData.handedness = e.data.handedness;
      c.userData.isRight = e.data.handedness === 'right';
      if (!menuAttached && (e.data.handedness === 'left' || i === 1)) { c.add(menu.mesh); menuAttached = true; }
      if (e.data.handedness === 'left' && recPreview) c.add(recPreview);
    });
    scene.add(c);
  });

  ghost = new THREE.Group();
  ghost.visible = false;
  ghost.matrixAutoUpdate = false;
  scene.add(ghost);

  recPreview = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.09), new THREE.MeshBasicMaterial({ color: 0x222222 }));
  recPreview.position.set(0, 0.22, -0.06);
  recPreview.rotation.x = -0.5;
  recPreview.visible = false;

  mapPanel = new Panel(0.24, 0.27, 512);
  mapPanel.mesh.renderOrder = 11;
  mapPanel.mesh.visible = false;
  scene.add(mapPanel.mesh);

  overview = new Panel(0.56, 0.48, 1024);
  overview.mesh.visible = false;
  scene.add(overview.mesh);

  guideLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0xffd43b, transparent: true, opacity: 0.9, depthTest: false }));
  guideLine.renderOrder = 13;
  guideLine.frustumCulled = false;
  guideLine.visible = false;
  scene.add(guideLine);
}

// ------------------------------------------------------------------ Laden & Anker wiederherstellen
async function loadAndRestore() {
  try {
    st.db = await api('state');
    const map = await api('map');
    st.map.track = map.track || [];
    st.map.walls = map.walls || [];
    st.map.grid = new Map((map.grid || []).map(([ix, iz, o, f]) => [`${ix},${iz}`, [o, f]]));
    st.map.gridDirty = true;
  } catch (e) { remoteLog('error', e); }
  const { session } = st;
  const handles = new Set(st.db.anchors.map((a) => a.handle));

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
      note.placement = null;
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

async function dropAnchor(id, why) {
  st.anchors.delete(id);
  st.db.anchors = st.db.anchors.filter((a) => a.id !== id);
  for (const n of st.db.notes) if (n.placement?.anchor === id) n.placement = null;
  try { await api(`anchors/${id}`, { method: 'DELETE' }); } catch { /* egal */ }
  remoteLog('warn', `Ankerpunkt ${id} verloren (${why}) – Notizen wieder in der Warteschlange`);
}

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
  if (map) {
    st.map.track = map.track; st.map.walls = map.walls;
    st.map.grid = new Map((map.grid || []).map(([ix, iz, o, f]) => [`${ix},${iz}`, [o, f]]));
    st.map.gridDirty = true;
  }
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
    if (used.has(id) || entry.creating || entry.rec?.isHome || entry.isHome) continue;
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
    g.fillStyle = 'rgba(20,24,30,0.92)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.font = 'bold 30px sans-serif';
    wrapText(g, `🎬 ${ghostText ?? (note.text || 'Video-Anleitung')}`, W - 90).slice(0, 2).forEach((l, i) => g.fillText(l, 16, 40 + i * 34));
    g.font = '26px sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillText('🎙', W - 56, 44);
    return;
  }
  g.fillStyle = note.color || COLORS[0];
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.fillRect(0, 0, W, 34);
  g.fillStyle = note.done ? 'rgba(0,0,0,0.4)' : '#222';
  g.font = 'bold 30px sans-serif';
  const lines = wrapText(g, ghostText ?? (note.text || '(leer – antippen und sprechen)'), W - 36).slice(0, 7);
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
  const item = { note, group, card: null, video: null, frame: null, toolbar: null, buttons: [], caption: null };
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
    item.video = video; item.card = cap; item.caption = cap.mesh; item.hitMeshes = [screen, cap.mesh];
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
  st.ui.dirtyOverview = true;
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
  const pv = st.pendingVideo;
  if (pv) items.push({ kind: 'video', label: `Video ${fmtDuration(pv.seconds)}: ${pv.title || st.pendingText || (pv.titling ? 'Titel wird erkannt…' : 'Video-Anleitung')}` });
  else if (st.pendingText) items.push({ kind: 'text', label: st.pendingText });
  else if (st.pendingNew) items.push({ kind: 'new', label: 'Neue Notiz (danach sprechen)' });
  const unplaced = st.db.notes.filter((n) => !n.placement && !n.done && !(n.type === 'video' && !n.media?.file))
    .sort((a, b) => (b.id === st.queueFront) - (a.id === st.queueFront) || (a.created ?? 0) - (b.created ?? 0));
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

// Zielpose: auf einer getroffenen Fläche (wenn sie näher als der Vorschau-Abstand ist), sonst frei im Raum
function targetMatrix(frame, src) {
  const tmp = new THREE.Object3D();
  const m = sourcePose(frame, src);
  if (!m) return null;
  const origin = new THREE.Vector3().setFromMatrixPosition(m);
  const hit = st.lastHit.get(src);
  const hitPos = hit ? new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z) : null;
  if (hitPos && hitPos.distanceTo(origin) <= st.distance + 0.05) {
    const q = new THREE.Quaternion(hit.orientation.x, hit.orientation.y, hit.orientation.z, hit.orientation.w);
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    tmp.position.copy(hitPos).addScaledVector(n, 0.004);
    tmp.up.copy(Math.abs(n.y) > 0.9 ? camForwardFlat() : new THREE.Vector3(0, 1, 0));
    tmp.lookAt(tmp.position.clone().add(n));
  } else {
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    tmp.position.copy(origin).addScaledVector(dir, st.distance);
    const facing = origin.clone().sub(tmp.position); facing.y = 0;
    if (facing.lengthSq() < 1e-6) facing.set(0, 0, 1);
    tmp.lookAt(tmp.position.clone().add(facing.normalize()));
  }
  tmp.updateMatrix();
  return tmp.matrix.clone();
}

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
    remoteLog('info', 'Nichts zu platzieren – im Menü links: ＋ Notiz, 🎙 Diktat oder 🎬 Video');
    return;
  }
  const world = targetMatrix(frame, src);
  if (!world) return;
  const placement = attachToAnchor(frame, world);
  if (next.kind === 'video') { placeVideo(placement, world); return; }
  let note;
  if (next.kind === 'note') { note = next.note; if (st.queueFront === note.id) st.queueFront = null; } else {
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
  if (next.kind === 'new') dictationStart(item, 'toggle');
}

async function placeVideo(placement, world) {
  const pv = st.pendingVideo;
  st.pendingVideo = null;
  setRecState('idle');
  st.ui.view = 'main';
  const note = {
    id: newId(), type: 'video', text: pv.title || st.pendingText || 'Video-Anleitung', transcript: pv.transcript || '',
    color: COLORS[st.colorIdx], done: false, location: '', media: null, created: Math.floor(Date.now() / 1000), placement,
  };
  pv.noteId = note.id; // ein später erkannter Titel landet noch an dieser Notiz
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
    await saveNote(note, ['type', 'text', 'transcript', 'color', 'done', 'location', 'media', 'placement']);
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
  st.ui.dirtyOverview = true;
}

// ------------------------------------------------------------------ Trigger / Select
function onSelect(e) {
  const { frame, inputSource: src } = e;
  const hov = st.hover.get(src);
  if (hov?.pbtn) { runPanelAction(hov.panel, hov.pbtn, frame, src); return; }
  if (hov?.button) { runButton(hov.button, frame, src); return; }
  if (st.grab?.viaIcon && st.grab.src === src) { finishGrab(frame); return; }
  if (st.dictation?.mode === 'toggle') { dictationStop(); return; }
  if (st.rec.state === 'recording' || st.rec.state === 'starting') { remoteLog('info', 'Aufnahme läuft – im Menü „■ Stopp“ oder „✕ Verwerfen“'); return; }
  if (hov?.panel) return; // Panel-Fläche ohne Knopf
  if (hov?.item) {
    const { item } = hov;
    if (item.note.type === 'video') {
      if (hov.mesh === item.caption) dictationStart(item, 'toggle', { title: true }); // Titel antippen = Titel sprechen
      else toggleVideo(item);
    } else dictationStart(item, 'toggle'); // Notiz antippen = Text sprechen
    activate(item);
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
      if (st.dictation) dictationStop(); else dictationStart(item, 'toggle', { title: item.note.type === 'video' });
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
    default: break;
  }
  st.hud.dirty = true;
}

// Aktionen der beschrifteten Panel-Knöpfe (Menü, Rekorder, Übersicht, Karte)
function runPanelAction(panel, b, frame, src) {
  const a = b.action;
  const d = b.data;
  switch (a) {
    case 'newNote': st.pendingNew = !st.pendingNew; st.ghostKey = null; if (st.pendingNew) remoteLog('info', 'Neue Notiz: mit Trigger platzieren, danach sprechen'); break;
    case 'dictate': if (st.dictation) dictationStop(); else dictationStart(null, 'toggle'); break;
    case 'videoMenu': st.ui.view = 'video'; break;
    case 'back': st.ui.view = 'main'; break;
    case 'overview': toggleOverview(); break;
    case 'map': setMapMode(st.map.mode === 'off' ? 'follow' : 'off'); break;
    case 'color': st.colorIdx = (st.colorIdx + 1) % COLORS.length; st.ghostKey = null; break;
    // Video-Rekorder
    case 'recStart': recStart(); break;
    case 'recStop': recStop(true); break;
    case 'recDiscard': recDiscard(); break;
    case 'recTitle': if (st.dictation) dictationStop(); else dictationStart(null, 'toggle', { pendingTitle: true }); break;
    case 'recPreview': previewPending(); break;
    // Übersicht
    case 'ovFilter': st.ui.ovFilter = d; st.ui.ovPage = 0; break;
    case 'ovPage': st.ui.ovPage += d; break;
    case 'ovClose': toggleOverview(false); break;
    case 'ovDone': { const n = st.db.notes.find((x) => x.id === d); if (n) { n.done = !n.done; const it = st.items.get(n.id); if (it) redraw(it); saveNote(n, ['done']); } break; }
    case 'ovShow': showGuide(d); break;
    case 'ovQueue': st.queueFront = d; st.ghostKey = null; remoteLog('info', 'Als Nächstes in der Warteschlange – Trigger ins Leere platziert'); break;
    case 'ovDelete':
      if (st.ui.ovConfirm === d) { st.ui.ovConfirm = null; const it = st.items.get(d); if (it) deleteItem(it); else deleteNoteById(d); } else {
        st.ui.ovConfirm = d;
        setTimeout(() => { if (st.ui.ovConfirm === d) { st.ui.ovConfirm = null; st.ui.dirtyOverview = true; } }, CONFIRM_MS);
      }
      break;
    // Karte
    case 'mapMode': setMapMode(d); break;
    default: break;
  }
  st.hud.dirty = true;
  st.ui.dirtyOverview = true;
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
  if (hov?.panel && (hov.panel === mapPanel || hov.panel === overview)) { startPanelGrab(e.frame, e.inputSource, hov.panel); return; }
  if (hov?.item && !hov.button) startGrab(e.frame, e.inputSource, hov.item, false);
}

function onSqueezeEnd(e) {
  if (st.panelGrab?.src === e.inputSource) { finishPanelGrab(e.frame); return; }
  if (st.grab && !st.grab.viaIcon && st.grab.src === e.inputSource) finishGrab(e.frame);
}

async function deleteItem(item) {
  const { note } = item;
  removeItem(note.id);
  await deleteNoteById(note.id);
}

async function deleteNoteById(id) {
  const note = st.db.notes.find((n) => n.id === id);
  st.db.notes = st.db.notes.filter((n) => n.id !== id);
  try { await api(`notes/${id}`, { method: 'DELETE' }); } catch (err) { remoteLog('error', err); }
  remoteLog('info', `Gelöscht: ${(note?.text || note?.type || '').slice(0, 40)}`);
  st.ui.dirtyOverview = true;
  pruneAnchors();
}

// ------------------------------------------------------------------ Diktat
// opts.title: Titel eines Videos · opts.pendingTitle: Titel der noch nicht platzierten Aufnahme
async function dictationStart(item, mode, opts = {}) {
  if (st.dictation) return;
  st.dictation = { target: item ?? null, mode, opts, starting: true };
  try {
    await speech.start();
    st.dictation.starting = false;
    st.dictation.timer = setTimeout(() => dictationStop(), MAX_DICTATION_SECONDS * 1000);
    const how = mode === 'toggle' ? 'Trigger beendet' : 'A loslassen';
    const what = opts.title || opts.pendingTitle ? 'Titel' : item ? 'Text' : 'Text für nächste Notiz';
    remoteLog('info', `🎙 ${what} sprechen… (${how})`);
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
    const short = d.opts.title || d.opts.pendingTitle ? text.replace(/[.!?]+$/, '').slice(0, 80) : text;
    if (d.opts.pendingTitle && st.pendingVideo) {
      st.pendingVideo.title = short;
      st.ghostKey = null;
      remoteLog('info', `Titel: „${short}“`);
    } else if (d.target && st.items.get(d.target.note.id)) {
      d.target.note.text = short;
      redraw(d.target);
      saveNote(d.target.note, ['text']);
      remoteLog('info', `${d.opts.title ? 'Titel' : 'Text'}: „${short.slice(0, 60)}“`);
    } else {
      st.pendingText = text;
      remoteLog('info', `Erkannt: „${text.slice(0, 60)}“ – Trigger zum Platzieren`);
    }
  } catch (err) {
    remoteLog('error', `Spracherkennung: ${err.message}`);
  }
  st.hud.dirty = true;
}

// ------------------------------------------------------------------ Video-Rekorder (Zustände: idle → starting → recording → review)
function setRecState(state) { st.rec.state = state; st.hud.dirty = true; }

async function recStart() {
  if (st.rec.state !== 'idle' && st.rec.state !== 'review') return;
  if (st.pendingVideo) discardPending();
  setRecState('starting');
  st.rec.discard = false;
  try {
    const { stream, label, how, cams } = await openCamera(true);
    if (st.rec.state !== 'starting') { stream.getTracks().forEach((t) => t.stop()); return; } // abgebrochen
    remoteLog('info', `Kameras: ${cams.map((c) => c.label || '(ohne Name)').join(' | ')} → nutze „${label}“ (${how})`);
    const { mime, ext } = pickVideoMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    const chunks = [];
    const started = performance.now();
    recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(st.rec.timer);
      setPreview(null);
      const audio = videoSpeech.active ? videoSpeech.stop() : null;
      if (st.rec.discard) { setRecState('idle'); remoteLog('info', 'Aufnahme verworfen'); return; }
      const seconds = (performance.now() - started) / 1000;
      const blob = new Blob(chunks, { type: recorder.mimeType || `video/${ext}` });
      st.pendingVideo = { blob, ext, seconds, url: URL.createObjectURL(blob), camera: label, title: '', transcript: '', titling: false };
      st.ghostKey = null;
      setRecState('review');
      remoteLog('info', `Video aufgenommen (${fmtDuration(seconds)}, ${Math.round(blob.size / 1024)} KB) – Trigger ins Leere platziert`);
      if (audio && audio.seconds > 1) autoTitle(st.pendingVideo, audio.wav);
    };
    recorder.start(1000);
    Object.assign(st.rec, { recorder, started, timer: setTimeout(() => recorder.state === 'recording' && recorder.stop(), MAX_VIDEO_SECONDS * 1000) });
    setRecState('recording');
    setPreview(stream);
    videoSpeech.start(stream, 60).catch((err) => remoteLog('warn', `Ton für Titel: ${err.message}`));
    const s = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    remoteLog('info', `● Aufnahme (${s.width ?? '?'}×${s.height ?? '?'}, ${mime || 'Standard'})`);
  } catch (err) {
    setRecState('idle');
    remoteLog('error', `Kamera: ${err.message} – Kamera auf der Startseite wählen und freigeben`);
  }
}

function recStop(keep) {
  if (st.rec.state === 'starting') { setRecState('idle'); return; }
  if (st.rec.state !== 'recording') return;
  st.rec.discard = !keep;
  if (st.rec.recorder?.state === 'recording') st.rec.recorder.stop();
}

function recDiscard() {
  if (st.rec.state === 'recording' || st.rec.state === 'starting') { recStop(false); return; }
  if (st.rec.state === 'review') { discardPending(); setRecState('idle'); remoteLog('info', 'Aufnahme verworfen'); }
}

function discardPending() {
  if (st.pendingVideo) URL.revokeObjectURL(st.pendingVideo.url);
  st.pendingVideo = null;
  st.ghostKey = null;
}

function previewPending() {
  const v = st.ghostItem?.video;
  if (!v) return;
  v.muted = false; v.loop = false; v.currentTime = 0;
  v.play().catch(() => {});
}

// Titel aus dem gesprochenen Ton der Aufnahme ableiten (Spracherkennung + Kurztitel über HA)
async function autoTitle(pv, wav) {
  pv.titling = true; st.ghostKey = null; st.hud.dirty = true;
  try {
    const res = await transcribe(wav, { title: true });
    pv.transcript = res.text || '';
    if (!pv.title && res.title) pv.title = res.title;
    remoteLog('info', res.title ? `Titel erkannt: „${res.title}“` : 'Kein Titel erkannt – 🎙 Titel sprechen');
    if (pv.noteId) { // bereits platziert → Notiz nachträglich benennen
      const item = st.items.get(pv.noteId);
      const note = item?.note ?? st.db.notes.find((n) => n.id === pv.noteId);
      if (note) {
        if (res.title && (note.text === 'Video-Anleitung' || !note.text)) note.text = res.title;
        note.transcript = pv.transcript;
        if (item) redraw(item);
        saveNote(note, ['text', 'transcript']);
      }
    }
  } catch (err) {
    remoteLog('warn', `Titel aus Video: ${err.message}`);
  } finally {
    pv.titling = false; st.ghostKey = null; st.hud.dirty = true;
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

// ------------------------------------------------------------------ Menü am linken Controller
function renderMenu() {
  menu.render((g, P) => {
    P.background();
    g.fillStyle = COLORS[st.colorIdx];
    g.fillRect(P.W - 46, 16, 28, 28);
    g.fillStyle = '#fff';
    g.font = 'bold 26px sans-serif';
    g.fillText(st.ui.view === 'video' ? '🎬 Video-Anleitung' : 'Home Notes', 18, 40);
    g.font = '19px sans-serif';
    const lines = [];
    if (st.dictation) lines.push('🎙 Höre zu… (Trigger beendet)');
    if (st.uploads) lines.push(`⏫ Lade ${st.uploads} Video(s) hoch…`);
    const next = queue()[0];
    if (st.ui.view === 'main') lines.push(next ? `Nächstes: ${next.label}` : `Warteschlange leer · ${st.refType}`);
    lines.push(`› ${st.hud.msg}`);
    let y = 72;
    for (const l of lines) for (const part of wrapText(g, l, P.W - 36).slice(0, 2)) { if (y < 138) { g.fillText(part, 18, y); y += 23; } }

    const col = (i) => (i % 2 === 0 ? 16 : 264);
    const row = (i) => 150 + Math.floor(i / 2) * 76;
    if (st.ui.view === 'main') {
      const defs = [
        ['＋ Notiz', 'newNote', st.pendingNew], ['🎙 Diktat', 'dictate', Boolean(st.dictation)],
        ['🎬 Video', 'videoMenu', st.rec.state !== 'idle'], ['📋 Übersicht', 'overview', overview.mesh.visible],
        ['🗺 Karte', 'map', st.map.mode !== 'off'], ['🎨 Farbe', 'color', false],
      ];
      defs.forEach(([label, action, active], i) => P.button(action, col(i), row(i), 232, 64, label, { action, active }));
      return;
    }
    // Rekorder-Ansicht: je Zustand nur die passenden, klar beschrifteten Knöpfe
    const red = '#c92a2a';
    const s = st.rec.state;
    g.font = 'bold 24px sans-serif';
    if (s === 'idle') {
      P.button('recStart', 16, 150, 480, 80, '● Aufnahme starten', { action: 'recStart', fill: red, size: 30 });
      P.button('back', 16, 248, 480, 64, '← Zurück', { action: 'back' });
    } else if (s === 'starting') {
      g.fillText('Kamera startet…', 18, 180);
      P.button('recDiscard', 16, 248, 480, 64, '✕ Abbrechen', { action: 'recDiscard' });
    } else if (s === 'recording') {
      g.fillStyle = '#ff6b6b';
      g.fillText(`● REC ${fmtDuration((performance.now() - st.rec.started) / 1000)}`, 18, 140);
      P.button('recStop', 16, 160, 232, 90, '■ Stopp & behalten', { action: 'recStop', fill: '#2f9e44' });
      P.button('recDiscard', 264, 160, 232, 90, '✕ Verwerfen', { action: 'recDiscard' });
      g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = '19px sans-serif';
      g.fillText('Erkläre beim Filmen, was du tust –', 18, 290);
      g.fillText('daraus entsteht der Titel.', 18, 314);
    } else if (s === 'review') {
      const pv = st.pendingVideo;
      g.font = '20px sans-serif';
      const t = pv?.title || (pv?.titling ? 'Titel wird erkannt…' : 'ohne Titel');
      g.fillText(`Aufnahme ${fmtDuration(pv?.seconds)} · ${t}`.slice(0, 48), 18, 140);
      P.button('recPreview', 16, 152, 232, 64, '▶ Ansehen', { action: 'recPreview' });
      P.button('recTitle', 264, 152, 232, 64, '🎙 Titel sprechen', { action: 'recTitle', active: Boolean(st.dictation) });
      P.button('recStart', 16, 228, 232, 64, '↺ Neu aufnehmen', { action: 'recStart' });
      P.button('recDiscard', 264, 228, 232, 64, '🗑 Verwerfen', { action: 'recDiscard' });
      g.fillStyle = '#69db7c'; g.font = '19px sans-serif';
      g.fillText('Platzieren: mit dem Trigger ins Leere zielen', 18, 322);
    }
  });
}

// ------------------------------------------------------------------ Übersicht in XR
function toggleOverview(force) {
  const open = force ?? !overview.mesh.visible;
  if (open && !overview.mesh.visible) {
    const m = renderer.xr.getCamera().matrixWorld;
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    const fwd = camForwardFlat();
    overview.mesh.position.copy(pos).addScaledVector(fwd, 0.85).add(new THREE.Vector3(0, -0.12, 0));
    overview.mesh.lookAt(pos);
  }
  overview.mesh.visible = open;
  st.ui.dirtyOverview = true;
}

function overviewList() {
  const f = st.ui.ovFilter;
  return st.db.notes.filter((n) => (f === 'all' ? true : f === 'video' ? n.type === 'video' : !n.done))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

function renderOverview() {
  const list = overviewList();
  const perPage = 6;
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  st.ui.ovPage = THREE.MathUtils.clamp(st.ui.ovPage, 0, pages - 1);
  overview.render((g, P) => {
    P.background(28);
    g.fillStyle = '#fff'; g.font = 'bold 36px sans-serif';
    g.fillText('📋 Übersicht', 24, 52);
    [['open', 'Offen'], ['all', 'Alle'], ['video', 'Videos']].forEach(([f, label], i) => P.button(`f-${f}`, 330 + i * 150, 14, 140, 56, label, { action: 'ovFilter', data: f, active: st.ui.ovFilter === f }));
    P.button('close', P.W - 84, 14, 64, 56, '✕', { action: 'ovClose' });
    const start = st.ui.ovPage * perPage;
    list.slice(start, start + perPage).forEach((n, i) => {
      const y = 92 + i * 112;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.beginPath(); g.roundRect(16, y, P.W - 32, 102, 14); g.fill();
      g.fillStyle = n.type === 'video' ? '#ff6b6b' : (n.color || COLORS[0]);
      g.fillRect(28, y + 14, 14, 74);
      g.fillStyle = n.done ? 'rgba(255,255,255,0.45)' : '#fff';
      g.font = 'bold 26px sans-serif';
      g.fillText(`${n.type === 'video' ? '🎬 ' : ''}${(n.text || '(leer)')}`.slice(0, 40), 58, y + 42);
      g.font = '20px sans-serif'; g.fillStyle = 'rgba(255,255,255,0.6)';
      const visible = st.items.get(n.id)?.group.visible;
      const status = n.placement ? (visible ? '⚓ hier sichtbar' : '⚓ platziert (nicht in Sicht)') : '⏳ nicht platziert';
      g.fillText(`${status}${n.done ? ' · erledigt' : ''}${n.location ? ` · 📍 ${n.location}` : ''}`.slice(0, 52), 58, y + 76);
      const bx = P.W - 400;
      P.button(`d-${n.id}`, bx, y + 18, 100, 66, n.done ? '↺' : '✓', { action: 'ovDone', data: n.id, size: 30 });
      if (n.placement) P.button(`s-${n.id}`, bx + 110, y + 18, 160, 66, '➜ Zeigen', { action: 'ovShow', data: n.id });
      else P.button(`q-${n.id}`, bx + 110, y + 18, 160, 66, '📍 Platzieren', { action: 'ovQueue', data: n.id, active: st.queueFront === n.id });
      P.button(`x-${n.id}`, bx + 280, y + 18, 90, 66, st.ui.ovConfirm === n.id ? '?' : '🗑', { action: 'ovDelete', data: n.id, fill: st.ui.ovConfirm === n.id ? '#e03131' : undefined, size: 28 });
    });
    if (!list.length) { g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '26px sans-serif'; g.fillText('Keine Einträge für diesen Filter.', 40, 160); }
    const fy = P.H - 76;
    P.button('prev', 24, fy, 120, 58, '◀', { action: 'ovPage', data: -1, disabled: st.ui.ovPage === 0 });
    P.button('next', P.W - 144, fy, 120, 58, '▶', { action: 'ovPage', data: 1, disabled: st.ui.ovPage >= pages - 1 });
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = '22px sans-serif'; g.textAlign = 'center';
    g.fillText(`Seite ${st.ui.ovPage + 1}/${pages} · ${list.length} Einträge · Grip auf das Fenster = verschieben`, P.W / 2, fy + 36);
    g.textAlign = 'left';
  });
  st.ui.dirtyOverview = false;
}

function showGuide(id) {
  const item = st.items.get(id);
  if (!item?.group.visible) { remoteLog('info', 'Notiz gerade nicht sichtbar – Ankerpunkt noch nicht gefunden'); return; }
  st.guide = { id, until: performance.now() + 15000 };
  remoteLog('info', 'Folge der gelben Linie');
}

function updateGuide() {
  const g = st.guide;
  if (!g || performance.now() > g.until) { guideLine.visible = false; st.guide = null; return; }
  const item = st.items.get(g.id);
  if (!item?.group.visible) { guideLine.visible = false; return; }
  const from = new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld).add(new THREE.Vector3(0, -0.3, 0));
  const to = new THREE.Vector3().setFromMatrixPosition(item.group.matrix);
  guideLine.geometry.setFromPoints([from, to]);
  guideLine.visible = true;
  const pulse = Math.sin(performance.now() / 150) > 0;
  item.frame.visible = true;
  item.frame.material.color.set(pulse ? 0xffd43b : 0xffffff);
}

// ------------------------------------------------------------------ Panels greifen und verschieben
function panelWorld(panel) { panel.mesh.updateMatrixWorld(); return panel.mesh.matrixWorld.clone(); }

function startPanelGrab(frame, src, panel) {
  const ctrl = sourcePose(frame, src);
  if (!ctrl) return;
  const world = panelWorld(panel);
  if (panel.mesh.parent !== scene) { scene.add(panel.mesh); setMatrix(panel.mesh, world); } // von der Hand lösen
  st.panelGrab = { src, panel, offset: ctrl.clone().invert().multiply(world) };
}

function setMatrix(obj, m) { m.decompose(obj.position, obj.quaternion, obj.scale); }

function finishPanelGrab() {
  const { panel } = st.panelGrab;
  st.panelGrab = null;
  if (panel !== mapPanel) return;
  if (st.map.mode === 'follow' || st.map.mode === 'hand') {
    // neue Lieblingsposition relativ zum Blick merken
    const head = renderer.xr.getCamera().matrixWorld.clone();
    st.map.offset = head.invert().multiply(panelWorld(mapPanel)).toArray();
    st.map.mode = 'follow';
  }
  saveMapPlacement();
  remoteLog('info', st.map.mode === 'world' ? 'Karte im Raum angeheftet' : 'Karte folgt dem Blick an dieser Stelle');
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
      if (b4 && !prev.b4 && !st.dictation) dictationStart(st.hover.get(src)?.item ?? null, 'hold', { title: st.hover.get(src)?.item?.note.type === 'video' });
      if (!b4 && prev.b4 && st.dictation?.mode === 'hold') dictationStop();
      if (b5 && !prev.b5) {
        const h = st.hover.get(src)?.item;
        if (h) { if (needsConfirm(`del:${h.note.id}`)) remoteLog('info', 'Nochmal B = löschen'); else deleteItem(h); }
      }
      const y = gp.axes[3] ?? 0;
      if (Math.abs(y) > 0.2) {
        if (st.grab && st.grab.src === src) st.grab.offset.premultiply(new THREE.Matrix4().makeTranslation(0, 0, y * dt * 1.2));
        else if (st.panelGrab && st.panelGrab.src === src) st.panelGrab.offset.premultiply(new THREE.Matrix4().makeTranslation(0, 0, y * dt * 1.2));
        else { st.distance = THREE.MathUtils.clamp(st.distance - y * dt * 1.2, 0.25, 4); st.hud.dirty = true; }
      }
    } else {
      if (b4 && !prev.b4) { st.ui.menuVisible = !st.ui.menuVisible; menu.mesh.visible = st.ui.menuVisible; } // X: Menü ein/aus
      if (b5 && !prev.b5) { st.colorIdx = (st.colorIdx + 1) % COLORS.length; st.ghostKey = null; st.hud.dirty = true; } // Y: Farbe
      if (b3 && !prev.b3) setMapMode(st.map.mode === 'off' ? 'follow' : 'off');
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
  for (const p of [menu, mapPanel, overview]) if (p.mesh.visible && p.mesh.parent && st.panelGrab?.panel !== p) targets.push(p.mesh);

  const panelHover = new Map();
  const hoveredButtons = new Set();
  for (const src of st.session.inputSources) {
    if (src.targetRayMode !== 'tracked-pointer') continue;
    const m = sourcePose(frame, src);
    let found = null;
    if (m && !(st.grab && st.grab.src === src) && !(st.panelGrab && st.panelGrab.src === src)) {
      raycaster.ray.origin.setFromMatrixPosition(m);
      raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
      raycaster.far = 8;
      const own = (o) => o.userData.panel === menu && isOnController(menu.mesh, src); // eigenes Menü nicht anpeilen
      const hit = raycaster.intersectObjects(targets, false).find((h) => !own(h.object));
      if (hit) {
        const { panel, button: btn, item } = hit.object.userData;
        if (panel) found = { panel, pbtn: hit.uv ? panel.hit(hit.uv) : null };
        else if (btn) found = { button: btn, item: btn.item };
        else found = { item, mesh: hit.object };
      }
    }
    if (found) st.hover.set(src, found); else st.hover.delete(src);
    if (found?.button) hoveredButtons.add(found.button);
    if (found?.pbtn) panelHover.set(found.panel, found.pbtn.id);
    if (found?.item) activate(found.item);
  }
  for (const p of [menu, mapPanel, overview]) p.setHover(panelHover.get(p) ?? null);
  for (const b of st.active?.buttons ?? []) {
    const h = hoveredButtons.has(b);
    if (h !== b.hover) drawButton(b, { hover: h });
  }
  const now = performance.now();
  if (st.active && now > st.activeUntil && !st.grab) { st.active.toolbar.visible = false; st.active = null; }
  for (const item of st.items.values()) {
    if (st.grab?.item === item || st.guide?.id === item.note.id) continue;
    item.frame.visible = st.active === item;
  }
}

function updateGhost(frame) {
  const sources = [...st.session.inputSources].filter((s) => s.targetRayMode === 'tracked-pointer');
  const src = sources.find((s) => s.handedness === 'right') ?? sources[0];
  const next = queue()[0];
  const show = src && next && !st.hover.get(src) && !st.grab && !st.panelGrab && st.rec.state !== 'recording';
  if (!show) { ghost.visible = false; return; }
  const key = `${next.kind}:${next.label}:${st.colorIdx}`;
  if (st.ghostKey !== key) {
    st.ghostKey = key;
    ghost.children.slice().forEach((c) => { ghost.remove(c); disposeTree(c); });
    if (st.ghostItem?.video) st.ghostItem.video.pause();
    let note;
    let opts = { asGhost: true };
    if (next.kind === 'video') {
      note = { type: 'video', text: st.pendingVideo.title || 'Video-Anleitung' };
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

// ------------------------------------------------------------------ Treffertests: Controller (Platzieren) + Raum-Scan-Anzeige
function setupHitTest() {
  if (!st.session?.requestHitTestSource || !(st.opts.useScan || st.opts.mapping)) return;
  for (const src of st.session.inputSources) {
    if (st.hitSources.has(src) || src.targetRayMode !== 'tracked-pointer') continue;
    st.hitSources.set(src, null);
    st.session.requestHitTestSource({ space: src.targetRaySpace })
      .then((h) => st.hitSources.set(src, h))
      .catch((err) => remoteLog('warn', `hit-test: ${err.message}`));
  }
}

function updateHits(frame) {
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
    if (pose) { r.matrix.fromArray(pose.transform.matrix); r.visible = Boolean(queue()[0]); st.lastHit.set(src, pose.transform); } else { r.visible = false; st.lastHit.delete(src); }
  }
}

function updateScan(frame) {
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

// ------------------------------------------------------------------ Grundriss per Tiefensensor (Belegungsraster)
async function setupMapping(session) {
  st.mapping.sources = [];
  if (!st.opts.mapping || !session.requestHitTestSource || typeof XRRay === 'undefined') return;
  let viewer;
  try { viewer = await session.requestReferenceSpace('viewer'); } catch { return; }
  const dirs = [];
  for (let yaw = -50; yaw <= 50; yaw += 10) dirs.push([yaw, -8]); // Fächer nach vorn: Wände
  for (let yaw = -40; yaw <= 40; yaw += 20) dirs.push([yaw, -40]); // schräg nach unten: Boden
  for (const [yd, pd] of dirs) {
    const y = THREE.MathUtils.degToRad(yd); const p = THREE.MathUtils.degToRad(pd);
    const d = { x: Math.sin(y) * Math.cos(p), y: Math.sin(p), z: -Math.cos(y) * Math.cos(p), w: 0 };
    try {
      st.mapping.sources.push(await session.requestHitTestSource({ space: viewer, offsetRay: new XRRay({ x: 0, y: 0, z: 0, w: 1 }, d) }));
    } catch (e) {
      remoteLog('warn', `Grundriss-Strahl ${yd}/${pd}: ${e.message}`);
      break;
    }
  }
  remoteLog('info', `Grundriss-Erfassung aktiv (${st.mapping.sources.length} Strahlen)`);
}

function addCell(x, z, occ, free, seen) {
  const key = `${Math.round(x / CELL)},${Math.round(z / CELL)}`;
  if (seen) { const tag = `${key}:${occ ? 'o' : 'f'}`; if (seen.has(tag)) return; seen.add(tag); }
  for (const map of [st.map.grid, st.map.delta]) {
    const c = map.get(key) ?? [0, 0];
    c[0] += occ; c[1] += free;
    map.set(key, c);
  }
  st.map.gridDirty = true;
}

function processMapping(frame) {
  if (!st.mapping.sources.length) return;
  st.mapping.frame += 1;
  if (st.mapping.frame % 3) return; // nur jeden dritten Frame
  const hw = homeWorld();
  if (!hw) return;
  const inv = hw.clone().invert();
  const head = new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld).applyMatrix4(inv);
  const seen = new Set();
  for (const src of st.mapping.sources) {
    const res = frame.getHitTestResults(src);
    if (!res.length) continue;
    const pose = res[0].getPose(st.refSpace);
    if (!pose) continue;
    const t = pose.transform;
    const p = new THREE.Vector3(t.position.x, t.position.y, t.position.z).applyMatrix4(inv);
    const n = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w))
      .transformDirection(inv);
    if (n.y > 0.85 && p.y < head.y - 0.9) { // Boden-Treffer → Bodenhöhe nachführen
      st.mapping.floorY = st.mapping.floorY == null ? p.y : st.mapping.floorY * 0.97 + p.y * 0.03;
    }
    const floor = st.mapping.floorY ?? head.y - 1.6;
    const h = p.y - floor;
    const dist = Math.hypot(p.x - head.x, p.z - head.z);
    if (dist > 5) continue;
    // Strahl vom Kopf bis kurz vor den Treffer: dort ist frei
    const steps = Math.floor((dist - 0.15) / CELL);
    for (let i = 1; i < steps; i += 1) {
      const f = (i * CELL) / dist;
      addCell(head.x + (p.x - head.x) * f, head.z + (p.z - head.z) * f, 0, 1, seen);
    }
    if (h > 0.25 && h < 2.0 && Math.abs(n.y) < 0.6) addCell(p.x, p.z, 1, 0, seen); // senkrechte Fläche → Wand/Möbel
    else if (h < 0.12) addCell(p.x, p.z, 0, 1, seen); // Boden → frei
    st.mapping.hits += 1;
  }
}

// ------------------------------------------------------------------ Hauskarte
function homeWorld() {
  let fallback = null;
  for (const a of st.anchors.values()) {
    const { rec } = a;
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
  if (st.map.lastPos && st.map.lastPos.distanceTo(head) < 0.3) {
    if (now - st.map.lastFlush > 5000) flushMap(now);
    return;
  }
  st.map.lastPos = head.clone();
  const p = head.applyMatrix4(hw.clone().invert());
  const pt = [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10];
  st.map.track.push(pt);
  st.map.buffer.push(pt);
  addCell(p.x, p.z, 0, 2); // wo man steht, ist frei
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
  if (!st.map.buffer.length && !st.map.wallsBuffer.length && !st.map.delta.size) return;
  const cells = [...st.map.delta].map(([k, [o, f]]) => { const [ix, iz] = k.split(',').map(Number); return [ix, iz, o, f]; });
  st.map.delta = new Map();
  const body = { track: st.map.buffer.splice(0), walls: st.map.wallsBuffer.splice(0), cells };
  if (beacon && navigator.sendBeacon) { navigator.sendBeacon('api/map', JSON.stringify(body)); return; }
  api('map', json('POST', body)).catch((e) => remoteLog('warn', `Karte speichern: ${e.message}`));
}
window.addEventListener('pagehide', () => flushMap(performance.now(), { beacon: true }));

function loadMapPlacement() {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_KEY) || '{}');
    st.map.offset = Array.isArray(saved.offset) ? saved.offset : null;
    setMapMode(['follow', 'hand', 'off'].includes(saved.mode) ? saved.mode : 'follow', { quiet: true });
  } catch { setMapMode('follow', { quiet: true }); }
}

function saveMapPlacement() {
  localStorage.setItem(MAP_KEY, JSON.stringify({ mode: st.map.mode === 'world' ? 'follow' : st.map.mode, offset: st.map.offset }));
}

function rightController() {
  const c0 = renderer.xr.getController(0);
  return c0.userData.isRight ? c0 : renderer.xr.getController(1);
}

function setMapMode(mode, { quiet = false } = {}) {
  st.map.mode = mode;
  if (mode === 'hand') {
    rightController().add(mapPanel.mesh);
    mapPanel.mesh.position.set(0, 0.07, -0.1);
    mapPanel.mesh.rotation.set(-0.9, 0, 0);
    mapPanel.mesh.scale.setScalar(0.7);
  } else if (mapPanel.mesh.parent !== scene) {
    const world = panelWorld(mapPanel);
    scene.add(mapPanel.mesh);
    setMatrix(mapPanel.mesh, world);
    mapPanel.mesh.scale.setScalar(1);
  }
  mapPanel.mesh.visible = mode !== 'off';
  if (mode === 'follow') st.map.snap = true;
  if (!quiet) {
    remoteLog('info', { follow: 'Karte folgt dem Blick – mit Grip greifen und hinschieben, wo du sie willst', world: 'Karte im Raum angeheftet', hand: 'Karte am rechten Controller', off: 'Karte aus' }[mode]);
    saveMapPlacement();
  }
}

function defaultMapOffset() {
  const m = new THREE.Matrix4().makeTranslation(0.33, 0.2, -0.8);
  return m.toArray();
}

function updateMapPanel(now) {
  if (st.map.mode === 'off') { mapPanel.mesh.visible = false; return; }
  mapPanel.mesh.visible = true;
  if (st.map.mode === 'follow' && st.panelGrab?.panel !== mapPanel) {
    // „Lazy follow“ an der selbst gewählten Stelle relativ zum Blick
    const head = renderer.xr.getCamera().matrixWorld;
    const target = head.clone().multiply(new THREE.Matrix4().fromArray(st.map.offset ?? defaultMapOffset()));
    const pos = new THREE.Vector3(); const quat = new THREE.Quaternion();
    target.decompose(pos, quat, new THREE.Vector3());
    if (st.map.snap) { mapPanel.mesh.position.copy(pos); mapPanel.mesh.quaternion.copy(quat); st.map.snap = false; }
    mapPanel.mesh.position.lerp(pos, 0.08);
    mapPanel.mesh.quaternion.slerp(quat, 0.08);
  }
  if (now - st.map.lastDraw > 250) { drawMap(now); st.map.lastDraw = now; }
}

// Raster einmal in ein Bild im Heimat-Koordinatensystem zeichnen (1 Zelle = 2 px), Karte dreht/verschiebt nur noch
let gridImage = null;
function renderGridImage() {
  if (!st.map.grid.size) { gridImage = null; return; }
  let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
  for (const key of st.map.grid.keys()) {
    const [ix, iz] = key.split(',').map(Number);
    if (ix < minX) minX = ix; if (ix > maxX) maxX = ix; if (iz < minZ) minZ = iz; if (iz > maxZ) maxZ = iz;
  }
  const S = 2;
  const canvas = gridImage?.canvas ?? document.createElement('canvas');
  canvas.width = Math.min(4096, (maxX - minX + 1) * S); canvas.height = Math.min(4096, (maxZ - minZ + 1) * S);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  for (const [key, [occ, free]] of st.map.grid) {
    const [ix, iz] = key.split(',').map(Number);
    const pOcc = occ / (occ + free);
    if (occ >= 2 && pOcc > 0.45) g.fillStyle = '#ffffff';
    else if (free >= 1 && pOcc < 0.3) g.fillStyle = 'rgba(77,171,247,0.35)';
    else continue;
    g.fillRect((ix - minX) * S, (iz - minZ) * S, S, S);
  }
  gridImage = { canvas, x0: (minX - 0.5) * CELL, z0: (minZ - 0.5) * CELL, w: canvas.width / S * CELL, h: canvas.height / S * CELL };
  st.map.gridDirty = false;
}

let lastGridRender = 0;
function drawMap(now) {
  if (st.map.gridDirty && now - lastGridRender > 1500) { renderGridImage(); lastGridRender = now; }
  mapPanel.render((g, P) => {
    const S = P.W; const C = S / 2; const CY = 64 + C;
    // Kopfzeile mit Modus-Knöpfen
    g.fillStyle = 'rgba(15,18,24,0.88)';
    g.beginPath(); g.roundRect(0, 0, S, 58, 16); g.fill();
    [['follow', '👁 Folgt'], ['world', '📌 Fix'], ['hand', '✋ Hand'], ['off', '✕']].forEach(([mode, label], i) => {
      P.button(`m-${mode}`, 8 + i * 126, 6, mode === 'off' ? 116 : 118, 46, label, { action: 'mapMode', data: mode, active: st.map.mode === mode, size: 22 });
    });
    g.fillStyle = 'rgba(12,15,20,0.82)';
    g.beginPath(); g.arc(C, CY, C - 4, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 4; g.stroke();
    const hw = homeWorld();
    const cam = renderer.xr.getCamera();
    g.textAlign = 'center';
    if (!hw) {
      g.fillStyle = '#fff'; g.font = '28px sans-serif';
      if (st.db.anchors.length) g.fillText('Suche Ankerpunkt…', C, CY);
      else { g.fillText('Karte startet mit', C, CY - 14); g.fillText('der ersten Notiz', C, CY + 22); }
      g.textAlign = 'left';
      return;
    }
    const inv = hw.clone().invert();
    const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).applyMatrix4(inv);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld).transformDirection(inv);
    const yaw = Math.atan2(dir.x, -dir.z);
    g.save();
    g.beginPath(); g.arc(C, CY, C - 8, 0, Math.PI * 2); g.clip();
    // Kartenkoordinaten: Blickrichtung zeigt nach oben
    g.translate(C, CY); g.rotate(-yaw); g.scale(MAP_PX_PER_M, MAP_PX_PER_M); g.translate(-head.x, -head.z);
    if (gridImage) { g.imageSmoothingEnabled = false; g.drawImage(gridImage.canvas, gridImage.x0, gridImage.z0, gridImage.w, gridImage.h); }
    g.strokeStyle = '#ffd43b'; g.lineWidth = 0.08;
    for (const [x1, z1, x2, z2] of st.map.walls) { g.beginPath(); g.moveTo(x1, z1); g.lineTo(x2, z2); g.stroke(); }
    for (const n of st.db.notes) {
      const pl = n.placement;
      if (!pl?.anchor) continue;
      const rec = st.db.anchors.find((a) => a.id === pl.anchor);
      if (!Array.isArray(rec?.home)) continue;
      const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(rec.home).multiply(new THREE.Matrix4().fromArray(pl.rel)));
      g.fillStyle = n.type === 'video' ? '#ff6b6b' : (n.done ? 'rgba(180,180,180,0.7)' : n.color || COLORS[0]);
      if (n.type === 'video') { g.beginPath(); g.moveTo(p.x - 0.3, p.z - 0.36); g.lineTo(p.x + 0.42, p.z); g.lineTo(p.x - 0.3, p.z + 0.36); g.fill(); } else g.fillRect(p.x - 0.3, p.z - 0.3, 0.6, 0.6);
      if (st.guide?.id === n.id) { g.strokeStyle = '#ffd43b'; g.lineWidth = 0.1; g.strokeRect(p.x - 0.5, p.z - 0.5, 1, 1); }
    }
    g.restore();
    g.fillStyle = '#4dabf7';
    g.beginPath(); g.moveTo(C, CY - 18); g.lineTo(C + 12, CY + 12); g.lineTo(C, CY + 5); g.lineTo(C - 12, CY + 12); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = '20px sans-serif';
    g.fillText(`Ø ${Math.round(S / MAP_PX_PER_M)} m · Grip = verschieben`, C, S + 64 - 22);
    g.textAlign = 'left';
  });
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
    if (st.panelGrab) {
      const m = sourcePose(frame, st.panelGrab.src);
      if (m) setMatrix(st.panelGrab.panel.mesh, m.multiply(st.panelGrab.offset));
    }
    scene.updateMatrixWorld();
    updateHits(frame);
    if (st.opts.useScan) updateScan(frame);
    processMapping(frame);
    updateHover(frame);
    updateGhost(frame);
    pollInput(frame, dt);
    updateGuide();
    if (t - st.map.lastLink > 1000) { linkAnchors(); st.map.lastLink = t; }
    recordTrack(t);
    updateMapPanel(t);
    if (st.rec.state === 'recording' || st.dictation) st.hud.dirty = true;
  }
  if (st.hud.dirty && t - st.hud.last > 250) { renderMenu(); st.hud.last = t; st.hud.dirty = false; }
  if (overview.mesh.visible && st.ui.dirtyOverview) renderOverview();
  renderer.render(scene, camera);
}

function onEnd() {
  renderer.setAnimationLoop(null);
  if (st.rec.state === 'recording') { st.rec.discard = false; st.rec.recorder?.stop(); }
  if (st.dictation) { clearTimeout(st.dictation.timer); speech.stop(); st.dictation = null; }
  speech.release();
  flushMap(performance.now());
  for (const id of [...st.items.keys()]) removeItem(id);
  ghost.children.slice().forEach((c) => { ghost.remove(c); disposeTree(c); });
  for (const obj of [...st.planeObjs.values(), ...st.meshObjs.values(), ...st.reticles.values()]) { scene.remove(obj); disposeTree(obj); }
  for (const m of [st.anchors, st.hitSources, st.lastHit, st.reticles, st.padState, st.planeObjs, st.meshObjs, st.hover, st.map.sentPlanes]) m.clear();
  st.mapping.sources = [];
  overview.mesh.visible = false;
  guideLine.visible = false;
  Object.assign(st, { session: null, grab: null, panelGrab: null, confirm: null, active: null, ghostKey: null, ghostItem: null, pendingNew: false, guide: null });
  st.ui.view = st.pendingVideo ? 'video' : 'main';
  st.map.lastPos = null;
  setLogSink(null);
  remoteLog('info', 'AR beendet');
  st.opts.onEnd?.();
}

// Test-Zugang für automatisierte Tests im Emulator (nur aktiv, wenn die Testumgebung window.__hnTest setzt)
if (window.__hnTest) {
  Object.assign(window.__hnTest, {
    st, processMapping, renderGridImage, panels: () => ({ menu, overview, mapPanel }), renderMenu, renderOverview, drawMap,
    action: (action, data) => runPanelAction(null, { action, data }),
  });
}
