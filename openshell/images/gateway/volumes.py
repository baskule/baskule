"""baskule-openshell volume helper.

The OpenShell Docker driver mounts only *existing* named volumes that carry the operator's admission labels, and
computerd has no Docker access. This helper is the one narrow capability computerd needs on the private dockerd:

  PUT    /volumes/<name>   create (idempotent) a labelled local volume, 200 {"name":..., "created": bool}
  GET    /volumes/<name>   200 {"name":..., "labels": {...}} or 404
  DELETE /volumes/<name>   remove it (409 if in use)
  GET    /healthz          200

Names must match ^baskule-space-[a-z0-9-]{1,48}$. Bearer token = $OPENSHELL_VOLUMES_TOKEN (required).
Listens on 0.0.0.0:$OPENSHELL_VOLUMES_PORT (default 47096), reachable only on the internal computers network.
"""
import hmac, http.client, http.server, json, os, re, socket, sys

TOKEN = os.environ.get("OPENSHELL_VOLUMES_TOKEN", "")
PORT = int(os.environ.get("OPENSHELL_VOLUMES_PORT", "47096"))
NAME = re.compile(r"^baskule-space-[a-z0-9-]{1,48}$")
LABELS = {
    "openshell.ai/sandbox-attachable": "true",
    "openshell.ai/sandbox-attachable-workspace": "default",
    "baskule.kind": "space",
}


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=30)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect("/var/run/docker.sock")


def docker(method, path, body=None):
    c = UnixHTTPConnection()
    try:
        data = json.dumps(body).encode() if body is not None else None
        c.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
        r = c.getresponse()
        raw = r.read()
        try:
            return r.status, json.loads(raw) if raw else None
        except ValueError:
            return r.status, {"message": raw.decode(errors="replace")}
    finally:
        c.close()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "baskule-volumes"

    def log_message(self, fmt, *args):
        sys.stderr.write("[volumes] " + (fmt % args) + "\n")

    def reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self):
        if self.path == "/healthz":
            return self.reply(200, {"ok": True})
        auth = self.headers.get("Authorization", "")
        if not TOKEN or not hmac.compare_digest(auth.encode(), ("Bearer " + TOKEN).encode()):
            return self.reply(401, {"error": "unauthorized"})
        m = re.match(r"^/volumes/([^/?]+)$", self.path)
        if not m or not NAME.match(m.group(1)):
            return self.reply(404, {"error": "not found"})
        name = m.group(1)
        if self.command == "GET":
            st, v = docker("GET", f"/volumes/{name}")
            if st == 404:
                return self.reply(404, {"error": "no such volume"})
            return self.reply(200, {"name": name, "labels": (v or {}).get("Labels") or {}})
        if self.command == "PUT":
            st, v = docker("GET", f"/volumes/{name}")
            if st == 200:
                return self.reply(200, {"name": name, "created": False})
            st, v = docker("POST", "/volumes/create", {"Name": name, "Driver": "local", "Labels": LABELS})
            if st >= 300:
                return self.reply(502, {"error": (v or {}).get("message", "docker error")})
            return self.reply(200, {"name": name, "created": True})
        if self.command == "DELETE":
            st, v = docker("DELETE", f"/volumes/{name}")
            if st in (200, 204, 404):
                return self.reply(200, {"name": name, "deleted": st != 404})
            return self.reply(409 if st == 409 else 502, {"error": (v or {}).get("message", "docker error")})
        return self.reply(405, {"error": "method not allowed"})

    def do_GET(self):
        self.route()

    def do_PUT(self):
        self.route()

    def do_DELETE(self):
        self.route()


if __name__ == "__main__":
    if not TOKEN:
        sys.stderr.write("[volumes] OPENSHELL_VOLUMES_TOKEN is not set; every request will be refused\n")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
