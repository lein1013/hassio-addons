"""Home Notes XR – server for the Home Assistant app.

Two listeners share one handler:
  * 8099 (http)  – Home Assistant ingress (desktop overview in the HA sidebar)
  * 8443 (https) – direct access for the Quest browser (WebXR needs HTTPS)

Data:
  /data/homenotes.json   notes + reference anchors
  /media/homenotes/      recorded video instructions (visible in HA media browser)

Everything is Python stdlib, no pip install needed.
"""
import argparse
import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "0.3.0"
WWW = os.environ.get("HOMENOTES_WWW", "/app/www")
DATA_FILE = os.environ.get("HOMENOTES_DATA", "/data/homenotes.json")
MEDIA_DIR = os.environ.get("HOMENOTES_MEDIA", "/media/homenotes")
HA_API = os.environ.get("HOMENOTES_HA_API", "http://supervisor/core/api")
HA_TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
# Ingress port is not mapped to the host; only containers on the hassio network reach it
INGRESS_NET = ("172.30.32.", "172.30.33.")
MAX_UPLOAD = 400 * 1024 * 1024
NOTE_FIELDS = {"type", "text", "color", "done", "location", "media", "placement"}
MEDIA_NAME = re.compile(r"^[a-f0-9]{12}\.(mp4|webm)$")

_lock = threading.Lock()
CFG = {"cert_mode": "unbekannt", "stt_entity": "", "language": "de"}
_stt_cache = {"entity": None, "language": None, "checked": 0.0, "error": None}


# ------------------------------------------------------------------ storage
def load_db():
    try:
        with open(DATA_FILE, encoding="utf-8") as fh:
            db = json.load(fh)
    except FileNotFoundError:
        db = {}
    except (OSError, ValueError) as err:
        print(f"[server] {DATA_FILE} unlesbar: {err}", flush=True)
        db = {}
    db.setdefault("notes", [])
    db.setdefault("anchors", [])
    db.setdefault("map", {"track": [], "walls": []})
    return db


MAX_TRACK = 60000
MAX_WALLS = 6000


def merge_map(db, track, walls):
    """Gelaufene Wege als 10-cm-Rasterzellen, Wände als Segmente (5-cm-gerundet) im Heimat-Koordinatensystem."""
    m = db["map"]
    cells = {(round(x * 10), round(z * 10)) for x, z in m["track"]}
    for pt in track or []:
        if len(pt) >= 2 and len(cells) < MAX_TRACK:
            cells.add((round(float(pt[0]) * 10), round(float(pt[1]) * 10)))
    m["track"] = [[cx / 10, cz / 10] for cx, cz in sorted(cells)]
    seen = {tuple(w) for w in m["walls"]}
    for w in walls or []:
        if len(w) < 4 or len(seen) >= MAX_WALLS:
            continue
        a = (round(float(w[0]) * 20) / 20, round(float(w[1]) * 20) / 20)
        b = (round(float(w[2]) * 20) / 20, round(float(w[3]) * 20) / 20)
        if a == b:
            continue
        seg = a + b if a <= b else b + a
        if seg not in seen:
            seen.add(seg)
            m["walls"].append(list(seg))


def transform_xz(mat, x, z):
    """Spaltenweise 4x4-Matrix (three.js/WebXR) auf Punkt (x, 0, z) anwenden."""
    return (mat[0] * x + mat[8] * z + mat[12], mat[2] * x + mat[10] * z + mat[14])


def save_db(db):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(db, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA_FILE)


def now():
    return int(time.time())


def new_id():
    return uuid.uuid4().hex[:12]


# ------------------------------------------------------------------ Home Assistant STT
def ha_request(method, path, data=None, headers=None, timeout=30):
    req = urllib.request.Request(f"{HA_API}{path}", data=data, method=method)
    req.add_header("Authorization", f"Bearer {HA_TOKEN}")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8") or "null")


def resolve_stt():
    """Pick STT entity + language once every 5 minutes."""
    if _stt_cache["entity"] and time.time() - _stt_cache["checked"] < 300:
        return _stt_cache
    _stt_cache["checked"] = time.time()
    try:
        entity = CFG["stt_entity"]
        if not entity:
            states = ha_request("GET", "/states")
            stt = [s["entity_id"] for s in states if s["entity_id"].startswith("stt.")
                   and s.get("state") != "unavailable"]
            stt.sort(key=lambda e: (e != "stt.home_assistant_cloud", e))
            entity = stt[0] if stt else None
        if not entity:
            raise RuntimeError("Keine Spracherkennung (stt.*) in Home Assistant gefunden")
        info = ha_request("GET", f"/stt/{entity}")
        langs = info.get("languages", []) if isinstance(info, dict) else []
        want = CFG["language"]
        lang = next((l for l in langs if l.lower() == want.lower()), None) \
            or next((l for l in langs if l.lower().startswith(want.lower())), None) \
            or (langs[0] if langs else want)
        _stt_cache.update(entity=entity, language=lang, error=None)
        print(f"[stt] nutze {entity} ({lang})", flush=True)
    except Exception as err:  # noqa: BLE001 – report any failure to the UI
        _stt_cache.update(entity=None, error=str(err))
        print(f"[stt] nicht verfügbar: {err}", flush=True)
    return _stt_cache


def transcribe(wav_bytes):
    stt = resolve_stt()
    if not stt["entity"]:
        raise RuntimeError(stt["error"] or "Spracherkennung nicht verfügbar")
    result = ha_request(
        "POST", f"/stt/{stt['entity']}", data=wav_bytes, timeout=60,
        headers={
            "X-Speech-Content": f"format=wav; codec=pcm; sample_rate=16000; bit_rate=16; "
                                f"channel=1; language={stt['language']}",
            "Content-Type": "audio/wav",
        },
    )
    if not isinstance(result, dict) or result.get("result") != "success":
        raise RuntimeError(f"STT-Fehler: {result}")
    return (result.get("text") or "").strip()


# ------------------------------------------------------------------ HTTP
class Handler(SimpleHTTPRequestHandler):
    server_version = f"HomeNotesXR/{VERSION}"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".json": "application/json",
        ".html": "text/html; charset=utf-8",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WWW, **kwargs)

    # ---- helpers -------------------------------------------------------
    def log_message(self, fmt, *args):
        path = self.path or ""
        if path.startswith("/api/") and not any(q in path for q in ("/api/log", "/api/state", "/api/map")):
            print(f"[http:{self.server.label}] {self.address_string()} {fmt % args}", flush=True)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _allowed(self):
        if self.server.label == "ingress" and not self.client_address[0].startswith(INGRESS_NET):
            self.send_error(403, "Nur über Home-Assistant-Ingress erreichbar")
            return False
        return True

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _length(self):
        return int(self.headers.get("Content-Length") or 0)

    def _raw(self, limit):
        length = self._length()
        if length <= 0 or length > limit:
            return None
        return self.rfile.read(length)

    def _body(self):
        raw = self._raw(1_000_000)
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            return {}

    def _parts(self):
        parsed = urlparse(self.path)
        return parsed.path.rstrip("/") or "/", parse_qs(parsed.query)

    # ---- GET -----------------------------------------------------------
    def do_GET(self):
        if not self._allowed():
            return
        route, _ = self._parts()
        if route == "/api/info":
            stt = resolve_stt()
            return self._json(200, {
                "version": VERSION,
                "cert_mode": CFG["cert_mode"],
                "https_port": 8443,
                "via": self.server.label,
                "stt": {"entity": stt["entity"], "language": stt["language"], "error": stt["error"]},
            })
        if route == "/api/state":
            with _lock:
                db = load_db()
            return self._json(200, {"notes": db["notes"], "anchors": db["anchors"]})
        if route == "/api/map":
            with _lock:
                db = load_db()
            return self._json(200, {**db["map"], "anchors": db["anchors"], "notes": [
                {k: n.get(k) for k in ("id", "type", "text", "color", "done", "placement")} for n in db["notes"]]})
        if route.startswith("/media/"):
            return self._serve_media(route.rsplit("/", 1)[-1])
        if route.startswith("/api/"):
            return self._json(404, {"error": "unbekannter Endpunkt"})
        return super().do_GET()

    def do_HEAD(self):
        if self._allowed():
            super().do_HEAD()

    def _serve_media(self, name):
        if not MEDIA_NAME.match(name):
            return self._json(404, {"error": "unbekannte Datei"})
        path = os.path.join(MEDIA_DIR, name)
        if not os.path.isfile(path):
            return self._json(404, {"error": "Datei fehlt"})
        size = os.path.getsize(path)
        start, end = 0, size - 1
        match = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        partial = bool(match) and size > 0
        if partial:
            if match.group(1):
                start = int(match.group(1))
                if match.group(2):
                    end = min(int(match.group(2)), size - 1)
            elif match.group(2):
                start = max(0, size - int(match.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", self.extensions_map[os.path.splitext(name)[1]])
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = end - start + 1
            try:
                while remaining > 0:
                    chunk = fh.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
        return None

    # ---- POST / PATCH / DELETE -----------------------------------------
    def do_POST(self):
        if not self._allowed():
            return None
        route, query = self._parts()
        if route == "/api/log":
            data = self._body()
            level = str(data.get("level", "info"))[:8]
            print(f"[client:{self.server.label}:{level}] {str(data.get('msg', ''))[:2000]}", flush=True)
            return self._json(200, {"ok": True})
        if route == "/api/notes":
            return self._upsert_note(None, self._body())
        if route == "/api/anchors":
            data = self._body()
            if not data.get("handle"):
                return self._json(400, {"error": "handle fehlt"})
            anchor = {"id": data.get("id") or new_id(), "handle": str(data["handle"]), "created": now(),
                      "isHome": bool(data.get("isHome")), "home": data.get("home")}
            with _lock:
                db = load_db()
                db["anchors"] = [a for a in db["anchors"] if a["id"] != anchor["id"]] + [anchor]
                save_db(db)
            print(f"[anchors] gespeichert {anchor['id']} ({len(db['anchors'])}/8)", flush=True)
            return self._json(200, anchor)
        if route == "/api/media":
            return self._upload_media(query)
        if route == "/api/map":
            data = self._body()
            with _lock:
                db = load_db()
                merge_map(db, data.get("track"), data.get("walls"))
                save_db(db)
            return self._json(200, {"track": len(db["map"]["track"]), "walls": len(db["map"]["walls"])})
        if route == "/api/map/rebase":
            # neuer Heimat-Ankerpunkt: alle Kartenpunkte mit der übergebenen Matrix umrechnen
            mat = self._body().get("matrix")
            if not isinstance(mat, list) or len(mat) != 16:
                return self._json(400, {"error": "matrix (16 Werte) erwartet"})
            with _lock:
                db = load_db()
                m = db["map"]
                m["track"] = [list(transform_xz(mat, x, z)) for x, z in m["track"]]
                m["walls"] = [list(transform_xz(mat, w[0], w[1]) + transform_xz(mat, w[2], w[3])) for w in m["walls"]]
                merge_map(db, [], [])
                save_db(db)
            print("[map] Karte auf neuen Heimat-Ankerpunkt umgerechnet", flush=True)
            return self._json(200, {"ok": True})
        if route == "/api/stt":
            wav = self._raw(20 * 1024 * 1024)
            if not wav:
                return self._json(400, {"error": "keine Audiodaten"})
            try:
                text = transcribe(wav)
            except Exception as err:  # noqa: BLE001
                print(f"[stt] Fehler: {err}", flush=True)
                return self._json(502, {"error": str(err)})
            print(f"[stt] erkannt: {text!r}", flush=True)
            return self._json(200, {"text": text})
        return self._json(404, {"error": "unbekannter Endpunkt"})

    def do_PATCH(self):
        if not self._allowed():
            return None
        route, _ = self._parts()
        if route.startswith("/api/notes/"):
            return self._upsert_note(route.rsplit("/", 1)[-1], self._body(), must_exist=True)
        if route.startswith("/api/anchors/"):
            anchor_id = route.rsplit("/", 1)[-1]
            data = self._body()
            with _lock:
                db = load_db()
                anchor = next((a for a in db["anchors"] if a["id"] == anchor_id), None)
                if anchor is None:
                    return self._json(404, {"error": "Ankerpunkt nicht gefunden"})
                for key in ("home", "isHome") & data.keys():
                    anchor[key] = data[key]
                save_db(db)
            return self._json(200, anchor)
        return self._json(404, {"error": "unbekannter Endpunkt"})

    def do_DELETE(self):
        if not self._allowed():
            return None
        route, _ = self._parts()
        if route.startswith("/api/notes/"):
            note_id = route.rsplit("/", 1)[-1]
            with _lock:
                db = load_db()
                note = next((n for n in db["notes"] if n["id"] == note_id), None)
                db["notes"] = [n for n in db["notes"] if n["id"] != note_id]
                save_db(db)
            if note and (note.get("media") or {}).get("file"):
                try:
                    os.remove(os.path.join(MEDIA_DIR, note["media"]["file"]))
                except OSError:
                    pass
            print(f"[notes] gelöscht {note_id}", flush=True)
            return self._json(200, {"ok": True, "deleted": bool(note)})
        if route == "/api/map":
            with _lock:
                db = load_db()
                db["map"] = {"track": [], "walls": []}
                save_db(db)
            print("[map] Karte zurückgesetzt", flush=True)
            return self._json(200, {"ok": True})
        if route.startswith("/api/anchors/"):
            anchor_id = route.rsplit("/", 1)[-1]
            with _lock:
                db = load_db()
                db["anchors"] = [a for a in db["anchors"] if a["id"] != anchor_id]
                for note in db["notes"]:
                    if (note.get("placement") or {}).get("anchor") == anchor_id:
                        note["placement"] = None
                save_db(db)
            print(f"[anchors] gelöscht {anchor_id}", flush=True)
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "unbekannter Endpunkt"})

    # ---- helpers for writes ---------------------------------------------
    def _upsert_note(self, note_id, data, must_exist=False):
        if not isinstance(data, dict):
            return self._json(400, {"error": "JSON-Objekt erwartet"})
        note_id = note_id or data.get("id") or new_id()
        with _lock:
            db = load_db()
            note = next((n for n in db["notes"] if n["id"] == note_id), None)
            if note is None:
                if must_exist:
                    return self._json(404, {"error": "Notiz nicht gefunden"})
                note = {"id": note_id, "type": "note", "text": "", "color": "#ffe066", "done": False,
                        "location": "", "media": None, "placement": None, "created": now()}
                db["notes"].append(note)
            for key in NOTE_FIELDS & data.keys():
                note[key] = data[key]
            note["updated"] = now()
            save_db(db)
        return self._json(200, note)

    def _upload_media(self, query):
        length = self._length()
        if length <= 0 or length > MAX_UPLOAD:
            return self._json(413, {"error": "Video fehlt oder ist zu groß (max. 400 MB)"})
        ext = "mp4" if (query.get("ext", ["webm"])[0] == "mp4") else "webm"
        name = f"{new_id()}.{ext}"
        os.makedirs(MEDIA_DIR, exist_ok=True)
        path = os.path.join(MEDIA_DIR, name)
        remaining = length
        with open(path + ".part", "wb") as fh:
            while remaining > 0:
                chunk = self.rfile.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        if remaining:
            os.remove(path + ".part")
            return self._json(400, {"error": "Upload abgebrochen"})
        os.replace(path + ".part", path)
        print(f"[media] gespeichert {name} ({length // 1024} KB)", flush=True)
        return self._json(200, {"file": name, "size": length, "mime": f"video/{ext}"})


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys
        err = sys.exc_info()[1]
        if isinstance(err, (ssl.SSLError, ConnectionError, TimeoutError)):
            return  # abgebrochene TLS-Handshakes/Verbindungen sind normal (Zertifikatswarnung, Tab zu)
        super().handle_error(request, client_address)


def serve(label, port, context=None):
    httpd = Server(("0.0.0.0", port), Handler)
    httpd.label = label
    if context:
        # handshake happens lazily in the handler thread, so a stalled client cannot block accept()
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
    print(f"[server] {label} lauscht auf Port {port} ({'https' if context else 'http'})", flush=True)
    httpd.serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--cert-mode", default="ssl-ordner")
    parser.add_argument("--stt-entity", default="")
    parser.add_argument("--language", default="de")
    parser.add_argument("--ingress-port", type=int, default=8099)
    parser.add_argument("--https-port", type=int, default=8443)
    args = parser.parse_args()
    CFG.update(cert_mode=args.cert_mode, stt_entity=args.stt_entity.strip(), language=args.language.strip() or "de")

    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)

    threading.Thread(target=serve, args=("https", args.https_port, ctx), daemon=True).start()
    serve("ingress", args.ingress_port)


if __name__ == "__main__":
    main()
