#!/usr/bin/env python3
"""Browser reader for grokbot: renders a web page with headless Chromium and returns its HTML.

Used only when a page can't be read directly (it needs JavaScript, or blocks simple fetches). Listens on a
Unix socket; POST /read with {"url": "https://..."} returns {"html": "..."}. Standard library only.

The systemd unit (deploy/grokbot-browser.service) is what keeps pages away from the server itself: its
IPAddressDeny blocks loopback and private networks for Chromium, so a link can't reach local services.
"""

import ipaddress
import json
import os
import socket
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import UnixStreamServer
from urllib.parse import urlparse

SOCKET = os.environ.get("BROWSER_SOCKET", "/run/grokbot-browser/browser.sock")
CHROMIUM = os.environ.get("BROWSER_BIN") or shutil.which("chromium") or shutil.which("chromium-browser") or "chromium"
TIMEOUT_S = 35
MAX_HTML = 3 * 1024 * 1024
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
one_at_a_time = threading.Semaphore(1)


def public_host(host: str) -> bool:
    """Every address the name resolves to is on the public internet (a fast refusal; the unit's IPAddressDeny is the real guard)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True  # unknown names fail in the browser with a normal error
    return all(ipaddress.ip_address(info[4][0].split("%")[0]).is_global for info in infos)


def render(url: str) -> str:
    profile = tempfile.mkdtemp(prefix="browser-")
    try:
        args = [
            CHROMIUM, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--disable-dev-shm-usage", "--mute-audio", "--hide-scrollbars",
            "--disable-background-networking", "--disable-sync", "--metrics-recording-only",
            "--blink-settings=imagesEnabled=false", f"--user-data-dir={profile}", f"--user-agent={USER_AGENT}",
            "--lang=zh-CN,zh,en", "--virtual-time-budget=12000", "--dump-dom", url,
        ]
        if os.environ.get("BROWSER_NO_SANDBOX") == "1":
            args.insert(1, "--no-sandbox")
        done = subprocess.run(args, capture_output=True, timeout=TIMEOUT_S)
        html = done.stdout[:MAX_HTML].decode("utf-8", "replace")
        if not html.strip():
            detail = done.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no output"]
            raise RuntimeError(f"browser returned nothing ({detail[0][:200]})")
        return html
    finally:
        shutil.rmtree(profile, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/read":
            return self.reply(404, {"error": "not found"})
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 10_000)
            url = str(json.loads(self.rfile.read(length) or b"{}").get("url", ""))
        except (ValueError, AttributeError):
            return self.reply(400, {"error": "bad request"})
        if urlparse(url).scheme not in ("http", "https") or not urlparse(url).hostname:
            return self.reply(400, {"error": "only http(s) links"})
        if not public_host(urlparse(url).hostname):
            return self.reply(403, {"error": "not a public address"})
        with one_at_a_time:
            try:
                return self.reply(200, {"html": render(url)})
            except subprocess.TimeoutExpired:
                return self.reply(504, {"error": f"page took longer than {TIMEOUT_S} s"})
            except Exception as error:  # noqa: BLE001 - reported to the bot as a short message
                return self.reply(502, {"error": str(error)[:300]})

    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def address_string(self) -> str:  # Unix sockets have no client address
        return "local"

    def log_message(self, format, *args):  # noqa: A002 - quiet: URLs aren't logged
        pass


class UnixHTTPServer(ThreadingHTTPServer, UnixStreamServer):
    address_family = UnixStreamServer.address_family

    def server_bind(self):
        UnixStreamServer.server_bind(self)
        self.server_name, self.server_port = "localhost", 0


def main() -> None:
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    server = UnixHTTPServer(SOCKET, Handler)
    os.chmod(SOCKET, 0o666)  # the bot runs as another user; the socket's folder decides who reaches it
    print(f"browser reader on {SOCKET} using {CHROMIUM}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
