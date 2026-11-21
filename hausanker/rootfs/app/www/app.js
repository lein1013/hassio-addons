// HausAnker XR – WebXR-Minimaltest
// Post-its im Passthrough setzen, als persistente Anker speichern, nach Neustart wiederfinden.
import * as THREE from './vendor/three.module.min.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#ffe066', '#ffa8a8', '#a5d8ff', '#b2f2bb', '#d0bfff'];
const NOTE_SIZE = 0.15; // Meter

// ---------------------------------------------------------------- HUD state
const hud = {
  features: '–', notes: 0, persistent: 0, restored: '–', planes: '–', meshes: '–',
  labels: '', msg: 'bereit', dirty: true, last: 0,
};

// ---------------------------------------------------------------- logging → App-Log in HA
function remoteLog(level, ...parts) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : p?.message ?? JSON.stringify(p))).join(' ');
  (level === 'error' ? console.error : console.log)(`[${level}] ${msg}`);
  fetch('api/log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, msg }),
  }).catch(() => {});
  hud.msg = msg.slice(0, 90);
  hud.dirty = true;
}
window.addEventListener('error', (e) => remoteLog('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => remoteLog('error', `Promise: ${e.reason?.message ?? e.reason}`));

async function api(path, opts = {}) {
  const res = await fetch(`api/${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`API ${path}: HTTP ${res.status}`);
  return res.json();
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 12);

// ---------------------------------------------------------------- 2D-Seite
let colorIdx = 0;
let info = null;

function renderSwatches() {
  const box = $('swatches');
  box.innerHTML = '';
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = `swatch${i === colorIdx ? ' on' : ''}`;
    b.style.background = c;
    b.title = `Farbe ${i + 1}`;
    b.onclick = () => { colorIdx = i; renderSwatches(); };
    box.appendChild(b);
  });
}

async function renderList() {
  let notes = [];
  try { notes = await api('notes'); } catch (e) { remoteLog('error', e); }
  $('count').textContent = `(${notes.length})`;
  const ul = $('notes');
  ul.innerHTML = '';
  if (!notes.length) {
    ul.innerHTML = '<li class="meta">Noch keine Post-its.</li>';
    return;
  }
  notes.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  for (const n of notes) {
    const li = document.createElement('li');
    const when = n.created ? new Date(n.created * 1000).toLocaleString('de-AT') : '';
    li.innerHTML = `<span class="chip" style="background:${n.color}"></span>
      <span class="grow">${n.handle ? '⚓ ' : ''}${escapeHtml(n.text || '(ohne Text)')}<br><span class="meta">${when}</span></span>`;
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = 'Löschen';
    del.onclick = async () => { await api(`notes/${n.id}`, { method: 'DELETE' }); renderList(); };
    li.appendChild(del);
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function initPage() {
  renderSwatches();
  const yes = (t) => `<span class="ok">✓ ${t}</span>`;
  const no = (t) => `<span class="bad">✗ ${t}</span>`;

  try { info = await api('info'); } catch (e) { remoteLog('error', e); }
  $('s-version').textContent = info?.version ?? '?';
  $('s-via').textContent = info?.via === 'ingress' ? 'Home-Assistant-Seitenleiste (Ingress)' : `Direkt, Port ${location.port || 443}`;
  $('s-cert').textContent = info?.cert_mode ?? '?';
  $('s-secure').innerHTML = window.isSecureContext ? yes('ja') : no('nein – WebXR braucht HTTPS');

  let xrOk = false;
  if (navigator.xr) {
    try { xrOk = await navigator.xr.isSessionSupported('immersive-ar'); } catch (e) { remoteLog('warn', `isSessionSupported: ${e.message}`); }
  }
  $('s-xr').innerHTML = xrOk ? yes('unterstützt') : no(navigator.xr ? 'nicht verfügbar' : 'kein navigator.xr (kein Headset/Browser?)');

  const inFrame = window.self !== window.top;
  const showOpen = info?.via === 'ingress' || !xrOk;
  if (showOpen) {
    const httpsUrl = `https://${location.hostname}:${info?.https_port ?? 8443}/`;
    $('open-card').hidden = false;
    $('open-reason').textContent = inFrame
      ? 'Du siehst die Seite eingebettet in Home Assistant. WebXR läuft im Quest-Browser am zuverlässigsten in einem eigenen Tab:'
      : 'Für WebXR die Seite über HTTPS im Quest-Browser öffnen:';
    $('links').innerHTML = `
      <p><a class="btn" href="${httpsUrl}" target="_blank" rel="noopener">${httpsUrl}</a></p>
      <p class="hint">Direkter HTTPS-Port der App. Passt das Zertifikat nicht zur Adresse (z. B. bei IP statt Domain),
      zeigt der Browser eine Warnung → „Erweitert“ → „Weiter zu …“.</p>
      ${inFrame ? `<p><a class="btn ghost" href="${location.href}" target="_blank" rel="noopener">Diese Seite in neuem Tab öffnen</a></p>
      <p class="hint">Variante über das HA-Zertifikat – funktioniert, wenn du Home Assistant selbst per HTTPS öffnest.</p>` : ''}`;
  }

  const btn = $('start-ar');
  btn.disabled = !xrOk;
  btn.onclick = () => startAR().catch((e) => remoteLog('error', `AR-Start fehlgeschlagen: ${e.message}`));
  $('reload').onclick = renderList;
  $('clear').onclick = async () => {
    if (!confirm('Alle gespeicherten Post-its löschen?')) return;
    await api('notes', { method: 'DELETE' });
    renderList();
  };
  renderList();
  remoteLog('info', `Seite geladen via=${info?.via} secure=${window.isSecureContext} xr=${xrOk} frame=${inFrame} ua=${navigator.userAgent}`);
}

// ---------------------------------------------------------------- three.js
const renderer = new THREE.WebGLRenderer({ canvas: $('xr-canvas'), antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

// HUD am Controller
const hudCanvas = document.createElement('canvas');
hudCanvas.width = 512; hudCanvas.height = 320;
const hudTex = new THREE.CanvasTexture(hudCanvas);
hudTex.colorSpace = THREE.SRGBColorSpace;
const hudMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(0.2, 0.125),
  new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false }),
);
hudMesh.renderOrder = 10;
hudMesh.position.set(0, 0.07, -0.08);
hudMesh.rotation.x = -0.7;
let hudAttached = false;

function drawHud() {
  const g = hudCanvas.getContext('2d');
  g.clearRect(0, 0, 512, 320);
  g.fillStyle = 'rgba(15,18,24,0.82)';
  g.beginPath(); g.roundRect(0, 0, 512, 320, 24); g.fill();
  g.fillStyle = COLORS[colorIdx];
  g.fillRect(452, 22, 36, 36);
  g.fillStyle = '#fff';
  g.font = 'bold 30px sans-serif';
  g.fillText('HausAnker XR', 24, 52);
  g.font = '22px sans-serif';
  const lines = [
    `Features: ${hud.features}`,
    `Post-its: ${hud.notes}  ·  persistent: ${hud.persistent}/8`,
    `Wiederhergestellt: ${hud.restored}`,
    `Ebenen: ${hud.planes}  ·  Meshes: ${hud.meshes}`,
    hud.labels ? `Labels: ${hud.labels}` : '',
    `› ${hud.msg}`,
  ];
  let y = 96;
  for (const l of lines) {
    if (!l) continue;
    wrap(g, l, 464).forEach((part) => { g.fillText(part, 24, y); y += 30; });
  }
  hudTex.needsUpdate = true;
  hud.dirty = false;
}

function wrap(g, text, maxW) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
  }
  if (line) out.push(line);
  return out;
}

// Controller-Strahlen
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }),
  );
  ray.scale.z = 0.4;
  c.add(ray);
  c.addEventListener('connected', (e) => {
    if (!hudAttached && (e.data.handedness === 'left' || i === 1)) { c.add(hudMesh); hudAttached = true; }
  });
  scene.add(c);
  return c;
});

// ---------------------------------------------------------------- Post-it-Meshes
function makeNoteMesh(note) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = note.color || COLORS[0];
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.fillRect(0, 0, 256, 30);
  g.fillStyle = '#222';
  g.font = 'bold 26px sans-serif';
  let y = 66;
  for (const part of wrap(g, note.text || '(ohne Text)', 224).slice(0, 6)) { g.fillText(part, 16, y); y += 32; }
  g.font = '16px sans-serif';
  g.fillStyle = 'rgba(0,0,0,0.55)';
  const when = note.created ? new Date(note.created * 1000).toLocaleDateString('de-AT') : '';
  g.fillText(`${when}  ${note.handle ? '⚓ persistent' : '· nur Position'}`, 16, 240);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(NOTE_SIZE, NOTE_SIZE),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
  );
  m.matrixAutoUpdate = false;
  m.visible = false;
  scene.add(m);
  return m;
}

function disposeMesh(m) {
  scene.remove(m);
  m.geometry.dispose();
  m.material.map?.dispose();
  m.material.dispose();
}

// ---------------------------------------------------------------- XR-Session
let xrSession = null;
let refSpace = null;
const live = new Map(); // id → { note, mesh, anchor, fallback }
const hitSources = new Map(); // XRInputSource → XRHitTestSource | null
const lastHit = new Map(); // XRInputSource → XRRigidTransform
const reticles = new Map();
const prevButtons = new Map();
const planeObjs = new Map();
const meshObjs = new Map();
let vizOn = true;

async function startAR() {
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['anchors', 'hit-test', 'plane-detection', 'mesh-detection', 'hand-tracking'],
  });
  xrSession = session;
  await renderer.xr.setSession(session);
  refSpace = renderer.xr.getReferenceSpace();

  const feats = session.enabledFeatures ? [...session.enabledFeatures] : [];
  hud.features = feats.length ? feats.filter((f) => !['viewer', 'local', 'local-floor'].includes(f)).join(', ') : 'unbekannt';
  remoteLog('info', `AR-Session gestartet, Features: ${feats.join(', ') || '(enabledFeatures nicht verfügbar)'}; restorePersistentAnchor=${typeof session.restorePersistentAnchor}`);

  session.addEventListener('end', onEnd);
  session.addEventListener('select', onSelect);
  session.addEventListener('squeeze', onSqueeze);
  session.addEventListener('inputsourceschange', setupHitTest);
  setupHitTest();
  renderer.setAnimationLoop(render);
  await restoreNotes(session);
}

async function restoreNotes(session) {
  let notes = [];
  try { notes = await api('notes'); } catch (e) { remoteLog('error', e); }
  let ok = 0; let failed = 0; let fallback = 0;
  for (const note of notes) {
    const entry = { note, mesh: makeNoteMesh(note), anchor: null, fallback: false };
    live.set(note.id, entry);
    if (note.handle && session.restorePersistentAnchor) {
      try {
        entry.anchor = await session.restorePersistentAnchor(note.handle);
        ok += 1;
      } catch (e) {
        failed += 1;
        remoteLog('warn', `Anker ${note.id} nicht wiederherstellbar: ${e.message}`);
      }
    }
    if (!entry.anchor && note.matrix) {
      // Fallback: Position relativ zum Startpunkt dieser Session – kann verschoben sein
      entry.mesh.matrix.fromArray(note.matrix);
      entry.mesh.material.opacity = 0.55;
      entry.mesh.material.transparent = true;
      entry.mesh.visible = true;
      entry.fallback = true;
      fallback += 1;
    }
  }
  hud.restored = `${ok} Anker, ${failed} fehlgeschlagen, ${fallback} ungefähr`;
  updateCounts();
  remoteLog('info', `Wiederherstellung: ${ok} ok, ${failed} fehlgeschlagen, ${fallback} nur ungefähr (von ${notes.length})`);
}

function setupHitTest() {
  if (!xrSession?.requestHitTestSource) return;
  for (const src of xrSession.inputSources) {
    if (hitSources.has(src) || src.targetRayMode !== 'tracked-pointer') continue;
    hitSources.set(src, null);
    xrSession.requestHitTestSource({ space: src.targetRaySpace })
      .then((h) => hitSources.set(src, h))
      .catch((e) => remoteLog('warn', `hit-test: ${e.message}`));
  }
}

function reticleFor(src) {
  let r = reticles.get(src);
  if (!r) {
    r = new THREE.Mesh(
      new THREE.RingGeometry(0.025, 0.035, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    r.matrixAutoUpdate = false;
    r.visible = false;
    scene.add(r);
    reticles.set(src, r);
  }
  return r;
}

function camForwardFlat() {
  const v = new THREE.Vector3();
  renderer.xr.getCamera().getWorldDirection(v);
  v.y = 0;
  return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3(0, 0, -1);
}

function orientTo(obj, normal) {
  // +Z der Notiz zeigt entlang der Flächennormale; an Wänden bleibt der Text aufrecht
  obj.up.copy(Math.abs(normal.y) > 0.9 ? camForwardFlat() : new THREE.Vector3(0, 1, 0));
  obj.lookAt(obj.position.clone().add(normal));
  obj.updateMatrix();
}

function onSelect(e) {
  const { frame, inputSource: src } = e;
  const tmp = new THREE.Object3D();
  const hit = lastHit.get(src);
  if (hit) {
    const q = new THREE.Quaternion(hit.orientation.x, hit.orientation.y, hit.orientation.z, hit.orientation.w);
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    tmp.position.set(hit.position.x, hit.position.y, hit.position.z).addScaledVector(n, 0.004);
    orientTo(tmp, n);
  } else {
    const rp = frame.getPose(src.targetRaySpace, refSpace);
    if (!rp) return;
    const m = new THREE.Matrix4().fromArray(rp.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    tmp.position.copy(origin).addScaledVector(dir, 0.4);
    orientTo(tmp, dir.clone().negate());
  }

  const note = {
    id: newId(),
    text: $('note-text').value.trim() || `Notiz ${live.size + 1}`,
    color: COLORS[colorIdx],
    created: Math.floor(Date.now() / 1000),
    matrix: tmp.matrix.toArray(),
    handle: null,
    surface: Boolean(hit),
  };

  // createAnchor muss synchron im Event-Handler laufen (Frame ist nur jetzt aktiv)
  let anchorPromise = null;
  if (frame.createAnchor) {
    const p = tmp.position; const q = tmp.quaternion;
    try {
      anchorPromise = frame.createAnchor(
        new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }),
        refSpace,
      );
    } catch (err) {
      remoteLog('warn', `createAnchor: ${err.message}`);
    }
  }
  finishNote(note, tmp.matrix, anchorPromise);
}

async function finishNote(note, matrix, anchorPromise) {
  const mesh = makeNoteMesh(note);
  mesh.matrix.copy(matrix);
  mesh.visible = true;
  const entry = { note, mesh, anchor: null, fallback: false };
  live.set(note.id, entry);
  updateCounts();

  if (anchorPromise) {
    try {
      entry.anchor = await anchorPromise;
      if (entry.anchor.requestPersistentHandle) note.handle = await entry.anchor.requestPersistentHandle();
    } catch (err) {
      remoteLog('warn', `Anker/persistenter Handle fehlgeschlagen: ${err.message}`);
    }
  }
  // Textur neu zeichnen, damit ⚓ sichtbar wird
  const fresh = makeNoteMesh(note);
  fresh.matrix.copy(mesh.matrix);
  fresh.visible = true;
  disposeMesh(mesh);
  entry.mesh = fresh;

  try {
    await api('notes', { method: 'POST', body: JSON.stringify(note) });
  } catch (err) {
    remoteLog('error', `Speichern fehlgeschlagen: ${err.message}`);
  }
  updateCounts();
  remoteLog('info', `Post-it gesetzt ${note.surface ? 'auf Fläche' : 'frei im Raum'} – ${note.handle ? 'persistenter Anker' : entry.anchor ? 'Anker (nicht persistent)' : 'nur Position'}`);
}

async function onSqueeze(e) {
  const { frame, inputSource: src } = e;
  const pose = frame.getPose(src.gripSpace || src.targetRaySpace, refSpace);
  if (!pose) return;
  const p = new THREE.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
  let best = null; let bestD = 0.25;
  for (const entry of live.values()) {
    if (!entry.mesh.visible) continue;
    const d = new THREE.Vector3().setFromMatrixPosition(entry.mesh.matrix).distanceTo(p);
    if (d < bestD) { best = entry; bestD = d; }
  }
  if (!best) { remoteLog('info', 'Kein Post-it in Griffweite (25 cm)'); return; }
  await deleteEntry(best);
}

async function deleteEntry(entry) {
  const { note } = entry;
  if (note.handle && xrSession?.deletePersistentAnchor) {
    try { await xrSession.deletePersistentAnchor(note.handle); } catch (err) { remoteLog('warn', `deletePersistentAnchor: ${err.message}`); }
  }
  try { entry.anchor?.delete(); } catch { /* bereits weg */ }
  disposeMesh(entry.mesh);
  live.delete(note.id);
  try { await api(`notes/${note.id}`, { method: 'DELETE' }); } catch (err) { remoteLog('error', err); }
  updateCounts();
  remoteLog('info', `Post-it gelöscht (${note.text.slice(0, 30)})`);
}

function updateCounts() {
  hud.notes = live.size;
  hud.persistent = [...live.values()].filter((x) => x.note.handle).length;
  hud.dirty = true;
}

// ---------------------------------------------------------------- Raum-Scan (Ebenen + Mesh)
function updateSceneUnderstanding(frame) {
  const planes = frame.detectedPlanes;
  if (planes) {
    for (const [plane, obj] of planeObjs) if (!planes.has(plane)) { disposeMesh(obj); planeObjs.delete(plane); }
    for (const plane of planes) {
      let obj = planeObjs.get(plane);
      if (!obj || obj.userData.t !== plane.lastChangedTime) {
        if (obj) disposeMesh(obj);
        const pts = plane.polygon.map((pt) => new THREE.Vector3(pt.x, pt.y, pt.z));
        obj = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: plane.orientation === 'vertical' ? 0x4dabf7 : 0x69db7c }),
        );
        obj.matrixAutoUpdate = false;
        obj.userData.t = plane.lastChangedTime;
        scene.add(obj);
        planeObjs.set(plane, obj);
      }
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (pose) obj.matrix.fromArray(pose.transform.matrix);
      obj.visible = vizOn && Boolean(pose);
    }
    if (hud.planes !== planes.size) { hud.planes = planes.size; hud.dirty = true; }
  }

  const meshes = frame.detectedMeshes;
  if (meshes) {
    for (const [mesh, obj] of meshObjs) if (!meshes.has(mesh)) { disposeMesh(obj); meshObjs.delete(mesh); }
    const labels = new Set();
    for (const mesh of meshes) {
      if (mesh.semanticLabel) labels.add(mesh.semanticLabel);
      let obj = meshObjs.get(mesh);
      if (!obj || obj.userData.t !== mesh.lastChangedTime) {
        if (obj) disposeMesh(obj);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.vertices), 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
        obj = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.12 }));
        obj.matrixAutoUpdate = false;
        obj.userData.t = mesh.lastChangedTime;
        scene.add(obj);
        meshObjs.set(mesh, obj);
      }
      const pose = frame.getPose(mesh.meshSpace, refSpace);
      if (pose) obj.matrix.fromArray(pose.transform.matrix);
      obj.visible = vizOn && Boolean(pose);
    }
    const lbl = [...labels].slice(0, 6).join(', ');
    if (hud.meshes !== meshes.size || hud.labels !== lbl) { hud.meshes = meshes.size; hud.labels = lbl; hud.dirty = true; }
  }
}

function pollButtons() {
  for (const src of xrSession.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const a = Boolean(gp.buttons[4]?.pressed);
    const b = Boolean(gp.buttons[5]?.pressed);
    const prev = prevButtons.get(src) ?? { a: false, b: false };
    if (a && !prev.a) { vizOn = !vizOn; remoteLog('info', `Raum-Scan ${vizOn ? 'eingeblendet' : 'ausgeblendet'}`); }
    if (b && !prev.b) { colorIdx = (colorIdx + 1) % COLORS.length; hud.dirty = true; }
    prevButtons.set(src, { a, b });
  }
}

// ---------------------------------------------------------------- Render-Loop
function render(t, frame) {
  if (frame && refSpace) {
    for (const entry of live.values()) {
      if (!entry.anchor) continue;
      const pose = frame.getPose(entry.anchor.anchorSpace, refSpace);
      if (pose) { entry.mesh.matrix.fromArray(pose.transform.matrix); entry.mesh.visible = true; }
    }
    for (const [src, hts] of hitSources) {
      const ret = reticleFor(src);
      const results = hts ? frame.getHitTestResults(hts) : [];
      const pose = results.length ? results[0].getPose(refSpace) : null;
      if (pose) { ret.matrix.fromArray(pose.transform.matrix); ret.visible = true; lastHit.set(src, pose.transform); } else { ret.visible = false; lastHit.delete(src); }
    }
    updateSceneUnderstanding(frame);
    pollButtons();
  }
  if (hud.dirty && t - hud.last > 250) { drawHud(); hud.last = t; }
  renderer.render(scene, camera);
}

function onEnd() {
  renderer.setAnimationLoop(null);
  for (const entry of live.values()) disposeMesh(entry.mesh);
  for (const obj of [...planeObjs.values(), ...meshObjs.values(), ...reticles.values()]) disposeMesh(obj);
  [live, hitSources, lastHit, reticles, prevButtons, planeObjs, meshObjs].forEach((m) => m.clear());
  xrSession = null;
  remoteLog('info', 'AR-Session beendet');
  renderList();
}

initPage();
