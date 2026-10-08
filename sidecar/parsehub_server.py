"""
Local HTTP wrapper around ParseHub (https://github.com/z-mio/ParseHub, MIT) so the
TypeScript bot can parse and download posts from Douyin, Weibo, Xiaohongshu,
Kuaishou, Bilibili, Instagram, Threads, Facebook, Tieba, Douban, Zhihu, etc.

Listens on 127.0.0.1 only. Endpoints (JSON in, JSON out):
  POST /parse    {"url"}  -> {"supported": false} | {"supported": true, "post": {...}}
  POST /download {"url"}  -> {"post": {...}, "dir": "...", "files": [...]}
Errors: HTTP 422 {"error": "..."}.

Config (optional) in PARSEHUB_CONFIG, a JSON file:
  {"proxy": "http://host:port",
   "platforms": {"bilibili": {"proxy": "socks5://...", "cookie": "SESSDATA=..."}}}
"""

import asyncio
import json
import os
import re
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from parsehub import ParseHub
from parsehub.errors import ParseError, UnknownPlatform
from parsehub.types import AniFile, ImageFile, LivePhotoFile, VideoFile

HOST = "127.0.0.1"
PORT = int(os.environ.get("PARSEHUB_PORT", "8765"))
MEDIA_ROOT = Path(os.environ.get("PARSEHUB_MEDIA_DIR", "/var/lib/grokbot/media")).resolve()
CONFIG_PATH = os.environ.get("PARSEHUB_CONFIG", "")
# Cookies the owner pastes in /admin → Maintenance → Site cookies (file owned by the bot user).
COOKIES_PATH = os.environ.get("PARSEHUB_COOKIES", "/var/lib/grokbot/parsehub-cookies.json")
TAG = re.compile(r"<[^>]+>")
# Only real platform hosts. ParseHub's own URL patterns don't pin the host
# (".+xhslink.com/" also matches "https://evil.example/xhslink.com/x") and it
# follows redirects for share links, so anything else could make this server
# fetch internal addresses.
PLATFORM_DOMAINS = (
    "weibo.com", "weibo.cn", "instagram.com", "youtube.com", "youtu.be", "bilibili.com", "b23.tv",
    "bili2233.cn", "douban.com", "douc.cc", "snapchat.com", "kuaishou.com", "chenzhongtech.com",
    "zhihu.com", "twitter.com", "x.com", "fixupx.com", "xiaohongshu.com", "xiaohongshu.cn",
    "xhslink.com", "xhslink.cn", "douyin.com", "iesdouyin.com", "facebook.com", "fb.watch",
    "threads.com", "threads.net", "tieba.baidu.com", "tiktok.com", "xiaoheihe.cn", "pipix.com",
    "mp.weixin.qq.com", "xiaochuankeji.cn", "coolapk.com",
)


def allowed_host(url: str) -> bool:
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or parts.username or parts.password:
        return False
    return any(host == d or host.endswith("." + d) for d in PLATFORM_DOMAINS)


def load_config() -> dict:
    if CONFIG_PATH and Path(CONFIG_PATH).exists():
        return json.loads(Path(CONFIG_PATH).read_text("utf-8"))
    return {}


def load_cookies() -> dict:
    try:
        data = json.loads(Path(COOKIES_PATH).read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def platform_options(hub: ParseHub, url: str) -> tuple[str | None, str | None, str | None]:
    """(platform id, proxy, cookie) for a URL: the config file, then cookies set from /admin."""
    parser = hub.get_parser(url)
    platform = getattr(getattr(parser, "__platform__", None), "id", None) if parser else None
    config = load_config()
    entry = config.get("platforms", {}).get(platform or "", {})
    cookie = entry.get("cookie") or load_cookies().get(platform or "") or None
    return platform, entry.get("proxy") or config.get("proxy"), cookie


def clean(text: str) -> str:
    return TAG.sub("", text or "").replace("&nbsp;", " ").strip()


def post_dict(result) -> dict:
    data = result.to_dict()
    media = data.get("media")
    media = media if isinstance(media, list) else ([media] if media else [])
    return {
        "platform": data.get("platform"),
        "platform_name": str(result.platform) if result.platform else None,
        "type": data.get("type"),
        "title": clean(data.get("title", "")),
        "content": clean(data.get("content", "")),
        "raw_url": data.get("raw_url") or "",
        "media": media,
    }


def file_dict(media) -> dict:
    if isinstance(media, LivePhotoFile):
        kind = "livephoto"
    elif isinstance(media, VideoFile):
        kind = "video"
    elif isinstance(media, AniFile):
        kind = "gif"
    elif isinstance(media, ImageFile):
        kind = "image"
    else:
        kind = "file"
    path = Path(media.path)
    return {
        "kind": kind,
        "path": str(path),
        "size": path.stat().st_size if path.exists() else 0,
        "width": getattr(media, "width", 0) or 0,
        "height": getattr(media, "height", 0) or 0,
        "duration": getattr(media, "duration", 0) or 0,
    }


async def parse(url: str) -> dict:
    hub = ParseHub()
    if not allowed_host(url) or not hub.get_parser(url):
        return {"supported": False}
    platform, proxy, cookie = platform_options(hub, url)
    result = await hub.parse(url, proxy=proxy, cookie=cookie)
    return {"supported": True, "post": post_dict(result)}


async def download(url: str) -> dict:
    hub = ParseHub()
    if not allowed_host(url) or not hub.get_parser(url):
        raise UnknownPlatform(url)
    platform, proxy, cookie = platform_options(hub, url)
    result = await hub.parse(url, proxy=proxy, cookie=cookie)
    target = MEDIA_ROOT / uuid.uuid4().hex
    target.mkdir(parents=True, exist_ok=True)
    # ParseHub names files after the post title, which yt-dlp reads as an output template:
    # titles with "%" or odd punctuation broke downloads. Each request has its own folder.
    result.name = "post"
    downloaded = await result.download(target, proxy=proxy)
    media = downloaded.media
    media = list(media) if isinstance(media, (list, tuple)) else ([media] if media else [])
    # "dir" is the per-request folder; the bot deletes it after uploading.
    return {"post": post_dict(result), "dir": str(target), "files": [file_dict(m) for m in media]}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        routes = {"/parse": parse, "/download": download}
        handler = routes.get(self.path)
        if not handler:
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length") or 0)
            url = str(json.loads(self.rfile.read(length) or b"{}").get("url") or "").strip()
            if not re.match(r"^https?://", url):
                return self.reply(422, {"error": "url must be http(s)"})
            self.reply(200, asyncio.run(handler(url)))
        except (ParseError, UnknownPlatform) as error:
            self.reply(422, {"error": str(error)})
        except Exception as error:  # noqa: BLE001
            self.reply(422, {"error": f"{type(error).__name__}: {error}"})

    def do_GET(self) -> None:  # noqa: N802
        self.reply(200, {"ok": True}) if self.path == "/health" else self.reply(404, {"error": "not found"})

    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # The bot stopped waiting (timeout); nothing left to answer.
            pass

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"{self.address_string()} {fmt % args}\n")


if __name__ == "__main__":
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    print(f"parsehub sidecar on http://{HOST}:{PORT}, media in {MEDIA_ROOT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
