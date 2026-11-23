// Home Notes XR – gemeinsame Helfer für Übersicht und XR
export const COLORS = ['#ffe066', '#ffa8a8', '#a5d8ff', '#b2f2bb', '#d0bfff'];

let logSink = null;
export function setLogSink(fn) { logSink = fn; }

export function remoteLog(level, ...parts) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : p?.message ?? JSON.stringify(p))).join(' ');
  (level === 'error' ? console.error : console.log)(`[${level}] ${msg}`);
  fetch('api/log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, msg }),
  }).catch(() => {});
  logSink?.(level, msg);
}

export async function api(path, opts = {}) {
  const req = () => fetch(`api/${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let res;
  try { res = await req(); } catch { res = await req(); } // ein Versuch mehr bei Netzwerkfehler (z. B. abgebrochene Verbindung)
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) throw new Error(data?.error || `API ${path}: HTTP ${res.status}`);
  return data;
}

export const json = (method, body) => ({ method, body: JSON.stringify(body) });

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Math.random()}${Date.now()}`)
  .replace(/[^a-f0-9]/g, '').slice(0, 12).padEnd(12, '0');

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ Sprache → Text
// Nimmt Mikrofon-Audio als 16-kHz-Mono-PCM auf und lässt es über Home Assistant (STT) erkennen.
export class SpeechRecorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.chunks = [];
    this.active = false;
  }

  // Muss einmal innerhalb einer Nutzer-Geste aufgerufen werden (Klick), sonst bleibt der AudioContext stumm.
  prime() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  async ensureStream() {
    if (!this.stream || this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
    return this.stream;
  }

  // stream: optional fremder Stream (z. B. Ton der Video-Aufnahme); maxSeconds begrenzt die Länge
  async start(stream = null, maxSeconds = 60) {
    this.prime();
    const source = stream ?? await this.ensureStream();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.chunks = [];
    const maxSamples = maxSeconds * this.ctx.sampleRate;
    let count = 0;
    this.src = this.ctx.createMediaStreamSource(source);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e) => {
      if (!this.active || count >= maxSamples) return;
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      count += data.length;
      this.chunks.push(data);
    };
    this.src.connect(this.proc);
    this.proc.connect(this.ctx.destination);
    this.active = true;
    this.started = performance.now();
  }

  stop() {
    this.active = false;
    try { this.src?.disconnect(); this.proc?.disconnect(); } catch { /* egal */ }
    const seconds = (performance.now() - (this.started ?? 0)) / 1000;
    const pcm = downsample(this.chunks, this.ctx?.sampleRate ?? 48000, 16000);
    this.chunks = [];
    return { wav: encodeWav(pcm, 16000), seconds };
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

function downsample(chunks, fromRate, toRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { input.set(c, off); off += c.length; }
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(total / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(total, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44).set(samples);
  return new Blob([buf], { type: 'audio/wav' });
}

export async function transcribe(wavBlob, { title = false } = {}) {
  const res = await fetch(`api/stt${title ? '?title=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavBlob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Spracherkennung: HTTP ${res.status}`);
  return title ? data : (data.text || '');
}

// ------------------------------------------------------------------ Video
export function pickVideoMime() {
  const candidates = [
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [mime, ext] of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(mime)) return { mime, ext };
  }
  return { mime: '', ext: 'webm' };
}

export async function uploadVideo(blob, ext) {
  const res = await fetch(`api/media?ext=${ext}`, { method: 'POST', headers: { 'Content-Type': blob.type || `video/${ext}` }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload: HTTP ${res.status}`);
  return data;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ Kamera-Auswahl
// Die Quest meldet mehrere Kameras: die Passthrough-Kameras (echtes Bild) und eine
// „virtuelle Kamera“ (Avatar vor schwarzem Hintergrund). Wir bevorzugen die Passthrough-Kamera.
const CAMERA_KEY = 'homenotes.cameraId';

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

export function cameraScore(label = '') {
  const l = label.toLowerCase();
  let s = 0;
  if (/passthrough|headset|rgb|world|environment|back|rear/.test(l)) s += 5;
  if (/left|camera 0|\b0\b/.test(l)) s += 1;
  if (/virtual|avatar|screen|cast|mixed reality capture|mrc/.test(l)) s -= 10;
  return s;
}

export function savedCameraId() { return localStorage.getItem(CAMERA_KEY) || ''; }
export function saveCameraId(id) { if (id) localStorage.setItem(CAMERA_KEY, id); else localStorage.removeItem(CAMERA_KEY); }

export async function pickCameraId() {
  const cams = await listCameras();
  const saved = savedCameraId();
  if (saved && cams.some((c) => c.deviceId === saved)) return { id: saved, cams, how: 'gespeichert' };
  const best = [...cams].sort((a, b) => cameraScore(b.label) - cameraScore(a.label))[0];
  return { id: best?.deviceId || '', cams, how: 'automatisch' };
}

export async function openCamera(withAudio) {
  const { id, cams, how } = await pickCameraId();
  const video = id
    ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30 } }
    : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: withAudio ? { echoCancellation: true, noiseSuppression: true } : false });
  const label = stream.getVideoTracks()[0]?.label || '?';
  return { stream, label, how, cams };
}
