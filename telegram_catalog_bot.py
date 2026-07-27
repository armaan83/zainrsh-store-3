#!/usr/bin/env python3
"""
Telegram -> GitHub Pages catalog bot (stdlib only, no pip install needed).

WHAT IT DOES
  You (the store owner) send a photo + caption to your Telegram bot.
  The bot uploads the photo to the GitHub repo (images/) and writes the
  product into products.json in the repo. GitHub Pages serves the site, which
  reads products.json on load, so the new product goes live automatically
  (GitHub Pages caches ~1 min; just refresh).

  Orders/checkout still go through the Apps Script Web App (CONFIG.APPS_SCRIPT_URL
  in js/config.js) — that part of the deployed script works fine.

HOW TO USE (send to the bot)
  Photo (or image URL) + caption:
      Name: Meera Jhumka
      Category: Earrings
      Price: 449
      MRP: 699
      Description: Antique gold jhumka with pearl drops
  - "Category" and "Description" are optional.
  - If you don't attach a photo, put an image URL in the caption:
      URL: https://example.com/photo.jpg
      Name: ...
  Commands: /start  /help  /add  /list  /delete <id>

SETUP
  1. Create a bot with @BotFather -> copy the token into bot_config.json.
  2. Make sure your git remote URL contains your GitHub PAT, e.g.
       https://<user>:<TOKEN>@github.com/<user>/<repo>.git
     The bot reads the token from there, so you never have to store it in a file.
  3. Set owner_chat_ids (your Telegram numeric id) in bot_config.json.
  4. Run:  python3 telegram_catalog_bot.py
"""

import json
import os
import re
import sys
import time
import base64
import fcntl
import subprocess
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "bot_config.json")

DEFAULT_CONFIG = {
    "bot_token": "PASTE_BOT_TOKEN_HERE",
    "owner_chat_ids": [],          # empty list = allow ANY chat (lock this down for production)
    "github_repo": "armaan83/zainrsh-store-3",  # "owner/repo"
    "github_branch": "main",
    "images_path": "images",        # folder in the repo where product photos go
    "products_file": "products.json",
    "site_url": "https://zainrash.com/"
}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
        print("Created bot_config.json — fill in bot_token and owner_chat_ids.")
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    # merge defaults for any missing keys
    for k, v in DEFAULT_CONFIG.items():
        cfg.setdefault(k, v)
    if not cfg.get("bot_token") or cfg["bot_token"].startswith("PASTE"):
        print("ERROR: set 'bot_token' in bot_config.json (from @BotFather).")
        sys.exit(1)
    if not cfg.get("owner_chat_ids"):
        print("ERROR: set 'owner_chat_ids' in bot_config.json (your Telegram numeric id).")
        sys.exit(1)
    return cfg


def get_github_token(cfg):
    """Token precedence: explicit cfg key -> git remote URL -> GITHUB_TOKEN env."""
    if cfg.get("github_token"):
        return cfg["github_token"]
    try:
        out = subprocess.check_output(
            ["git", "config", "--get", "remote.origin.url"],
            cwd=HERE, stderr=subprocess.DEVNULL).decode().strip()
        m = re.search(r"https://[^:]+:([^@]+)@github\.com", out)
        if m:
            return m.group(1)
    except Exception:
        pass
    return os.environ.get("GITHUB_TOKEN", "")


# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------
def tg_api(token, method, data=None, files=None, timeout=30):
    url = "https://api.telegram.org/bot%s/%s" % (token, method)
    if files:
        boundary = "----hermesbotboundary"
        body = b""
        for k, v in (data or {}).items():
            body += ("--%s\r\n" % boundary).encode()
            body += ('Content-Disposition: form-data; name="%s"\r\n\r\n' % k).encode()
            body += str(v).encode() + b"\r\n"
        for k, (fname, fbytes) in files.items():
            body += ("--%s\r\n" % boundary).encode()
            body += ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (k, fname)).encode()
            body += b"Content-Type: application/octet-stream\r\n\r\n"
            body += fbytes + b"\r\n"
        body += ("--%s--\r\n" % boundary).encode()
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "multipart/form-data; boundary=%s" % boundary)
    else:
        req = urllib.request.Request(url, data=json.dumps(data).encode() if data else None, method="POST")
        if data:
            req.add_header("Content-Type", "application/json")
    req.timeout = timeout
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def download_telegram_file(token, file_id):
    info = tg_api(token, "getFile", {"file_id": file_id})
    if not info.get("ok"):
        raise RuntimeError("getFile failed: " + str(info))
    path = info["result"]["file_path"]
    url = "https://api.telegram.org/file/bot%s/%s" % (token, path)
    req = urllib.request.Request(url)
    req.timeout = 60
    with urllib.request.urlopen(req) as r:
        return r.read()


# ---------------------------------------------------------------------------
# GitHub API (raw, stdlib only)
# ---------------------------------------------------------------------------
def _gh(method, url, token, data=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", "token " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "zainrash-bot")
    if data is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(data).encode()
    req.timeout = 60
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        try:
            detail = json.loads(detail).get("message", detail)
        except Exception:
            pass
        raise RuntimeError("%s %s -> %s: %s" % (method, url, e.code, detail))


def gh_upload(cfg, token, path, content_base64):
    """Create or update a file. Returns the raw URL."""
    api = "https://api.github.com/repos/%s/contents/%s" % (cfg["github_repo"], path)
    # find existing sha (needed for update)
    sha = None
    try:
        existing = _gh("GET", api + "?ref=" + cfg["github_branch"], token)
        sha = existing.get("sha")
    except RuntimeError:
        sha = None
    payload = {
        "message": "Add product image %s" % path,
        "content": content_base64,
        "branch": cfg["github_branch"],
    }
    if sha:
        payload["sha"] = sha
    _gh("PUT", api, token, payload)
    return "https://raw.githubusercontent.com/%s/%s/%s" % (
        cfg["github_repo"], cfg["github_branch"], path)


def gh_get_products(cfg, token):
    api = "https://api.github.com/repos/%s/contents/%s?ref=%s" % (
        cfg["github_repo"], cfg["products_file"], cfg["github_branch"])
    try:
        d = _gh("GET", api, token)
    except RuntimeError:
        return []
    if "content" not in d:
        return []
    try:
        raw = base64.b64decode(d["content"]).decode()
        return json.loads(raw)
    except Exception:
        return []


def gh_save_products(cfg, token, products):
    api = "https://api.github.com/repos/%s/contents/%s" % (
        cfg["github_repo"], cfg["products_file"])
    content = base64.b64encode(json.dumps(products, indent=2).encode()).decode()
    sha = None
    try:
        existing = _gh("GET", api + "?ref=" + cfg["github_branch"], token)
        sha = existing.get("sha")
    except RuntimeError:
        sha = None
    payload = {
        "message": "Update catalog (%d products)" % len(products),
        "content": content,
        "branch": cfg["github_branch"],
    }
    if sha:
        payload["sha"] = sha
    _gh("PUT", api, token, payload)


# ---------------------------------------------------------------------------
# Caption parsing
# ---------------------------------------------------------------------------
def parse_product(caption):
    """Parse a caption into a product dict. Supports Name/Category/Price/MRP/URL/Description
    on separate lines or separated by '|'. Returns (product, image_url_from_text_or_None)."""
    if not caption:
        return None, None
    parts = re.split(r"[\n|]", caption)
    fields = {}
    free_url = None
    url_re = re.compile(r"https?://[^\s]+\.(?:png|jpe?g|gif|webp)", re.I)
    for part in parts:
        m = re.match(r"\s*(name|category|price|mrp|url|description|desc)\s*[:=]\s*(.+?)\s*$", part, re.I)
        if m:
            key = m.group(1).lower()
            val = m.group(2).strip()
            if key == "desc":
                key = "description"
            fields[key] = val
        else:
            um = url_re.search(part)
            if um and not free_url:
                free_url = um.group(0)
    product = {
        "name": fields.get("name", "").strip(),
        "category": fields.get("category", "Uncategorized").strip(),
        "price": fields.get("price", "").strip(),
        "mrp": fields.get("mrp", "").strip(),
        "description": fields.get("description", "").strip(),
    }
    text_url = fields.get("url", "").strip() or free_url
    product["image"] = text_url
    return product, text_url


def slugify(s):
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.lower()).strip("-")
    return s or ("item-" + str(int(time.time())))


def make_id(name):
    return slugify(name) + "-" + str(int(time.time()))[-5:]


# ---------------------------------------------------------------------------
# Product handling
# ---------------------------------------------------------------------------
def handle_product(cfg, token, chat_id, caption, photo_file_id=None, photo_ext="jpg"):
    product, text_url = parse_product(caption)
    if not product or not product["name"]:
        return ("❌ Send a photo (or image URL) + caption with at least:\n"
                "Name: <product name>\nPrice: <number>\nCategory: <optional>")
    image_url = product.get("image")
    gh_token = get_github_token(cfg)
    if not gh_token:
        return ("❌ GitHub token not found. Put it in the git remote URL "
                "(https://user:TOKEN@github.com/...) or set github_token / GITHUB_TOKEN env.")

    if not image_url and photo_file_id:
        try:
            raw = download_telegram_file(token, photo_file_id)
            b64 = base64.b64encode(raw).decode()
            fname = slugify(product["name"]) + "-" + str(int(time.time())) + "." + photo_ext
            path = cfg["images_path"].strip("/") + "/" + fname
            up = gh_upload(cfg, gh_token, path, b64)
            # Store a repo-relative path so the site resolves it from its own root.
            image_url = path
        except Exception as e:
            return "❌ Image upload to GitHub failed: " + str(e)
    elif text_url and not image_url:
        image_url = text_url

    if not image_url:
        return "❌ No image found. Attach a photo or include a URL: line in the caption."

    product["image"] = image_url
    try:
        product["price"] = float(re.sub(r"[^0-9.]", "", str(product["price"]))) if product["price"] else 0
    except Exception:
        product["price"] = 0
    try:
        product["mrp"] = float(re.sub(r"[^0-9.]", "", str(product["mrp"]))) if product["mrp"] else 0
    except Exception:
        product["mrp"] = 0
    product["id"] = make_id(product["name"])
    product["inStock"] = True

    try:
        products = gh_get_products(cfg, gh_token)
        products.append(product)
        gh_save_products(cfg, gh_token, products)
    except Exception as e:
        return "❌ Could not save product to GitHub: " + str(e)

    site = cfg.get("site_url", "")
    return ("✅ Added: *%s* (%s) — ₹%s\n🌐 Live at %s\n"
            "(GitHub Pages refreshes in ~1 min — just reload the site.)" % (
                product["name"], product["category"], product["price"], site))


def handle_list(cfg, token):
    gh_token = get_github_token(cfg)
    if not gh_token:
        return "❌ GitHub token not found."
    products = gh_get_products(cfg, gh_token)
    if not products:
        return "📭 No products yet."
    lines = ["📦 *%d product(s):*" % len(products)]
    for p in products:
        lines.append("• `%s` — %s (₹%s)" % (p.get("id"), p.get("name"), p.get("price")))
    return "\n".join(lines)


def handle_delete(cfg, token, arg):
    gid = arg.strip()
    if not gid:
        return "Usage: /delete <id>"
    gh_token = get_github_token(cfg)
    if not gh_token:
        return "❌ GitHub token not found."
    products = gh_get_products(cfg, gh_token)
    before = len(products)
    products = [p for p in products if p.get("id") != gid]
    if len(products) == before:
        return "❌ No product with id `%s`." % gid
    gh_save_products(cfg, gh_token, products)
    return "🗑 Deleted `%s`. %d products remain." % (gid, len(products))


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def acquire_lock():
    """Ensure only ONE instance runs. Uses a pidfile with an exclusive lock, and
    also asserts the lock-holder is actually alive (so a crashed/dead process
    doesn't block restarts forever)."""
    lock_path = os.path.join(HERE, ".bot.lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        # Another live instance holds it. Read its pid.
        try:
            with open(lock_path) as f:
                pid = int(f.read().strip() or 0)
            alive = False
            if pid:
                try:
                    os.kill(pid, 0)  # signal 0 = just check existence
                    alive = True
                except OSError:
                    alive = False
            if alive:
                print("Another instance is already running (pid %d). Exiting." % pid)
                sys.exit(1)
            # stale lock (process dead) — take over
        except Exception:
            pass
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.ftruncate(fd, 0)
    os.write(fd, str(os.getpid()).encode())
    return fd  # keep open for the process lifetime


def clear_webhook(token):
    """If anyone ever set a webhook, delete it so long-polling works cleanly."""
    try:
        tg_api(token, "deleteWebhook", {"drop_pending_updates": True})
    except Exception:
        pass


def main():
    cfg = load_config()
    token = cfg["bot_token"]
    acquire_lock()
    clear_webhook(token)
    owners = [str(x) for x in cfg.get("owner_chat_ids", [])]
    offset = 0
    print("Telegram catalog bot started. Polling for messages… (Ctrl+C to stop)")
    while True:
        try:
            updates = tg_api(token, "getUpdates",
                             {"offset": offset, "timeout": 30, "allowed_updates": json.dumps(["message"])})
            if not updates.get("ok"):
                time.sleep(3)
                continue
            for upd in updates.get("result", []):
                offset = upd["update_id"] + 1
                msg = upd.get("message")
                if not msg:
                    continue
                chat_id = str(msg["chat"]["id"])
                if owners and chat_id not in owners:
                    tg_api(token, "sendMessage", {"chat_id": chat_id, "text": "🚫 Unauthorized."})
                    continue
                text = msg.get("text", "")
                caption = msg.get("caption", "")
                photo = msg.get("photo")
                if text.startswith("/"):
                    cmd = text.split()[0].lower()
                    arg = text[len(cmd):].strip()
                    if cmd in ("/start", "/help"):
                        tg_api(token, "sendMessage", {"chat_id": chat_id, "text":
                            "Send a photo + caption to add a product:\n"
                            "Name: Meera Jhumka\nCategory: Earrings\nPrice: 449\nMRP: 699\n"
                            "Description: antique gold jhumka\n\n"
                            "Or send a URL: line instead of a photo.\nCommands: /list  /delete <id>"})
                    elif cmd == "/add":
                        tg_api(token, "sendMessage", {"chat_id": chat_id, "text":
                            "Just send a photo (or image URL) + caption:\n"
                            "Name: …\nCategory: …\nPrice: …\nMRP: … (optional)\nDescription: … (optional)"})
                    elif cmd == "/list":
                        tg_api(token, "sendMessage",
                               {"chat_id": chat_id, "text": handle_list(cfg, token), "parse_mode": "Markdown"})
                    elif cmd == "/delete":
                        tg_api(token, "sendMessage",
                               {"chat_id": chat_id, "text": handle_delete(cfg, token, arg), "parse_mode": "Markdown"})
                    else:
                        tg_api(token, "sendMessage", {"chat_id": chat_id, "text": "Unknown command. Send /help."})
                    continue
                if photo or (caption and re.search(r"https?://\S+\.(png|jpe?g|gif|webp)", caption, re.I)):
                    file_id = None
                    ext = "jpg"
                    if photo:
                        file_id = photo[-1]["file_id"]
                    reply = handle_product(cfg, token, chat_id, caption, file_id, ext)
                    tg_api(token, "sendMessage",
                           {"chat_id": chat_id, "text": reply, "parse_mode": "Markdown"})
                elif caption:
                    tg_api(token, "sendMessage", {"chat_id": chat_id, "text":
                        "❌ Attach a photo or include an image URL (ending in .jpg/.png) in the caption."})
        except KeyboardInterrupt:
            print("\nStopped.")
            break
        except Exception as e:
            print("Error:", e)
            time.sleep(5)


if __name__ == "__main__":
    main()
