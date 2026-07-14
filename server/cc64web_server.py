#!/usr/bin/env python3
"""cc64-web deployment server (rpi6): static IDE + in-memory PRG stash.

Compilation happens client-side (the compiler is pure browser ESM); this
server only (a) serves the repo's static tree under /cc64-web/ and
(b) holds compiled .prg files IN MEMORY for 5 minutes so the IDE can hand
web64.nofs.ai a fetchable URL (its ?url= autostart):

    POST /cc64-web/api/prg?name=foo.prg   body = raw PRG bytes
      -> {"id": "...", "path": "/cc64-web/prg/<id>/foo.prg", "expiresIn": 300}
    GET  /cc64-web/prg/<id>/<name>        CORS *, no-store; 404 once expired
    GET  /cc64-web/api/ping               feature-detect for the UI button

Nothing is ever written to disk. Zero dependencies (python3 stdlib) —
runs as a systemd unit behind apache (see deploy/).
"""
import json
import os
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

PREFIX = '/cc64-web'
ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get('PORT', '9007'))
TTL_SECONDS = 300
MAX_PRG_BYTES = 65536          # a PRG can't exceed 64K anyway
MAX_STASHED = 200

# only these top-level dirs are served (matches what web/index.html fetches)
STATIC_ALLOW = ('web', 'src', 'assets', 'test', 'examples')

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.css': 'text/css; charset=utf-8',
    '.c': 'text/plain; charset=utf-8',
    '.h': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
}

_stash = {}                    # id -> (bytes, name, expires_at)
_lock = threading.Lock()


def _sweep():
    now = time.time()
    with _lock:
        for k in [k for k, v in _stash.items() if v[2] < now]:
            del _stash[k]


class Handler(BaseHTTPRequestHandler):
    server_version = 'cc64web/1.0'
    protocol_version = 'HTTP/1.1'

    # ---- helpers ----
    def _send(self, status, body=b'', ctype='text/plain; charset=utf-8', extra=()):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _route(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        if path == PREFIX or path == PREFIX + '/':
            return ('redirect', PREFIX + '/web/', u)
        if not path.startswith(PREFIX + '/'):
            return ('miss', None, u)
        return ('rel', path[len(PREFIX) + 1:], u)

    # ---- handlers ----
    def do_GET(self):
        _sweep()
        kind, arg, u = self._route()
        if kind == 'redirect':
            return self._send(302, b'', extra=[('Location', arg)])
        if kind == 'miss':
            return self._send(404, b'not found')
        rel = arg

        if rel == 'api/ping':
            return self._send(200, b'{"ok":true}', 'application/json')

        m = re.fullmatch(r'prg/([A-Za-z0-9_-]+)/([A-Za-z0-9._-]+)', rel)
        if m:
            with _lock:
                hit = _stash.get(m.group(1))
            if not hit or hit[2] < time.time():
                return self._send(404, b'expired or unknown prg')
            return self._send(200, hit[0], 'application/octet-stream', extra=[
                ('Access-Control-Allow-Origin', '*'),
                ('Cache-Control', 'no-store'),
                ('Content-Disposition', f'inline; filename="{hit[1]}"'),
            ])

        # static tree
        if rel == 'web' or rel == 'web/':
            rel = 'web/index.html'
        target = (ROOT / rel).resolve()
        try:
            inside = target.is_relative_to(ROOT)
        except AttributeError:      # < 3.9, not expected
            inside = str(target).startswith(str(ROOT))
        if (not inside or '..' in rel.split('/')
                or rel.split('/', 1)[0] not in STATIC_ALLOW
                or not target.is_file()):
            return self._send(404, b'not found')
        ctype = MIME.get(target.suffix.lower(), 'application/octet-stream')
        return self._send(200, target.read_bytes(), ctype,
                          extra=[('Cache-Control', 'no-cache')])

    do_HEAD = do_GET

    def do_POST(self):
        _sweep()
        kind, rel, u = self._route()
        if kind != 'rel' or rel != 'api/prg':
            return self._send(404, b'not found')
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 2 or length > MAX_PRG_BYTES:
            return self._send(413, b'prg size out of range')
        body = self.rfile.read(length)
        q = parse_qs(u.query)
        name = (q.get('name') or ['program.prg'])[0]
        name = re.sub(r'[^A-Za-z0-9._-]', '_', name)[:64] or 'program.prg'
        pid = secrets.token_urlsafe(9)
        with _lock:
            while len(_stash) >= MAX_STASHED:     # drop the oldest
                _stash.pop(min(_stash, key=lambda k: _stash[k][2]))
            _stash[pid] = (body, name, time.time() + TTL_SECONDS)
        out = json.dumps({
            'id': pid,
            'path': f'{PREFIX}/prg/{pid}/{name}',
            'expiresIn': TTL_SECONDS,
        }).encode()
        return self._send(200, out, 'application/json',
                          extra=[('Access-Control-Allow-Origin', '*')])

    def do_OPTIONS(self):
        self._send(204, b'', extra=[
            ('Access-Control-Allow-Origin', '*'),
            ('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'),
            ('Access-Control-Allow-Headers', 'Content-Type'),
        ])

    def log_message(self, fmt, *args):
        print(f'{self.address_string()} {fmt % args}', flush=True)


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'cc64-web server on 127.0.0.1:{PORT}, root {ROOT}, prefix {PREFIX}',
          flush=True)
    srv.serve_forever()
