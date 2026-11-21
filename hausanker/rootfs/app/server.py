"""HausAnker XR – minimal server for the Home Assistant app.

Two listeners share one handler:
  * 8099 (http)  – Home Assistant ingress (only the Supervisor may connect)
  * 8443 (https) – direct access for the Quest browser (WebXR needs HTTPS)

Everything is Python stdlib, no pip install needed.
"""
import argparse
import json
import os
import ssl
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

VERSION = "0.1.0"
WWW = os.environ.get("HAUSANKER_WWW", "/app/www")
DATA_FILE = os.environ.get("HAUSANKER_DATA", "/data/notes.json")
INGRESS_PEER = "172.30.32.2"

_lock = threading.Lock()
CERT_MODE = "unbekannt"


def load_notes():
    try:
        with open(DATA_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as err:
        print(f"[server] notes.json unlesbar: {err}", flush=True)
        return []


def save_notes(notes):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(notes, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA_FILE)


class Handler(SimpleHTTPRequestHandler):
    server_version = f"HausAnker/{VERSION}"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".html": "text/html; charset=utf-8",
        ".css": "text/css",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WWW, **kwargs)

    # ---- helpers -------------------------------------------------------
    def log_message(self, fmt, *args):  # quieter log, skip static noise
        if "/api/" in (self.path or "") and "/api/log" not in self.path:
            print(f"[http:{self.server.label}] {self.address_string()} {fmt % args}", flush=True)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _allowed(self):
        if self.server.label == "ingress" and self.client_address[0] != INGRESS_PEER:
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

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _route(self):
        return urlparse(self.path).path.rstrip("/") or "/"

    # ---- verbs ---------------------------------------------------------
    def do_GET(self):
        if not self._allowed():
            return
        route = self._route()
        if route == "/api/info":
            with _lock:
                count = len(load_notes())
            return self._json(200, {
                "version": VERSION,
                "cert_mode": CERT_MODE,
                "https_port": 8443,
                "via": self.server.label,
                "notes": count,
            })
        if route == "/api/notes":
            with _lock:
                return self._json(200, load_notes())
        if route.startswith("/api/"):
            return self._json(404, {"error": "unbekannter Endpunkt"})
        return super().do_GET()

    def do_HEAD(self):
        if self._allowed():
            super().do_HEAD()

    def do_POST(self):
        if not self._allowed():
            return
        route = self._route()
        data = self._body()
        if route == "/api/log":
            level = str(data.get("level", "info"))[:8]
            msg = str(data.get("msg", ""))[:2000]
            print(f"[client:{self.server.label}:{level}] {msg}", flush=True)
            return self._json(200, {"ok": True})
        if route == "/api/notes":
            if not isinstance(data, dict):
                return self._json(400, {"error": "JSON-Objekt erwartet"})
            data.setdefault("id", uuid.uuid4().hex[:12])
            data.setdefault("created", int(time.time()))
            data["updated"] = int(time.time())
            with _lock:
                notes = [n for n in load_notes() if n.get("id") != data["id"]]
                notes.append(data)
                save_notes(notes)
            print(f"[notes] gespeichert {data['id']} (handle={'ja' if data.get('handle') else 'nein'})", flush=True)
            return self._json(200, data)
        return self._json(404, {"error": "unbekannter Endpunkt"})

    def do_DELETE(self):
        if not self._allowed():
            return
        route = self._route()
        if route == "/api/notes":
            with _lock:
                save_notes([])
            print("[notes] alle gelöscht", flush=True)
            return self._json(200, {"ok": True})
        if route.startswith("/api/notes/"):
            note_id = route.rsplit("/", 1)[-1]
            with _lock:
                notes = load_notes()
                remaining = [n for n in notes if n.get("id") != note_id]
                save_notes(remaining)
            print(f"[notes] gelöscht {note_id}", flush=True)
            return self._json(200, {"ok": True, "deleted": len(notes) - len(remaining)})
        return self._json(404, {"error": "unbekannter Endpunkt"})


def serve(label, port, context=None):
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.label = label
    if context:
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    print(f"[server] {label} lauscht auf Port {port} ({'https' if context else 'http'})", flush=True)
    httpd.serve_forever()


def main():
    global CERT_MODE
    parser = argparse.ArgumentParser()
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--cert-mode", default="ssl-ordner")
    parser.add_argument("--ingress-port", type=int, default=8099)
    parser.add_argument("--https-port", type=int, default=8443)
    args = parser.parse_args()
    CERT_MODE = args.cert_mode

    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)

    threading.Thread(target=serve, args=("https", args.https_port, ctx), daemon=True).start()
    serve("ingress", args.ingress_port)


if __name__ == "__main__":
    main()
