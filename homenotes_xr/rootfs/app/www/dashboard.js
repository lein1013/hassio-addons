// Home Notes XR – Übersicht (Desktop in der HA-Seitenleiste und 2D-Seite auf der Quest)
import {
  api, json, remoteLog, escapeHtml, COLORS, SpeechRecorder, transcribe, fmtDuration,
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
    $('use-scan').checked = localStorage.getItem('homenotes.useScan') === '1';
    $('use-scan').onchange = () => localStorage.setItem('homenotes.useScan', $('use-scan').checked ? '1' : '0');
    $('grant').onclick = grantMedia;
    checkPermissions();
    $('start-ar').onclick = async () => {
      try {
        xrModule ??= await import('./xr.js');
        xrModule.primeAudio(); // in der Klick-Geste, sonst bleibt das Mikrofon stumm
        await xrModule.startXR({ useScan: $('use-scan').checked, onEnd: () => refresh() });
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
    $('grant-status').textContent = `✓ freigegeben (Kamera ${v.width ?? '?'}×${v.height ?? '?'})`;
    remoteLog('info', `Kamera/Mikrofon freigegeben ${v.width}x${v.height}`);
  } catch (err) {
    $('grant-status').textContent = `✗ ${err.message}`;
    remoteLog('warn', `Freigabe: ${err.message}`);
  }
}

async function checkPermissions() {
  try {
    const [cam, mic] = await Promise.all(['camera', 'microphone'].map((n) => navigator.permissions.query({ name: n })));
    if (cam.state === 'granted' && mic.state === 'granted') $('grant-status').textContent = '✓ bereits freigegeben';
  } catch { /* Permissions-API nicht verfügbar */ }
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
