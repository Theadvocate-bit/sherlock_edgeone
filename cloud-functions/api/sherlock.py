"""sherlock_edgeone — EdgeOne Makers Python cloud-function entry point.

Route (file-system):  /api/sherlock
Methods:              GET  (?username=...)   or   POST (JSON body)

Returns JSON:
{
  "username": "torvalds",
  "elapsed_seconds": 14.2,
  "total_sites": 481,
  "found": 23,
  "results": {
    "GitHub": {"status": "Claimed", "url": "https://github.com/torvalds",
               "http_status": 200, "context": null, "query_time": 0.31},
    ...
  }
}

Upstream project: https://github.com/sherlock-project/sherlock (MIT).
Detection logic is upstream's; this file only adapts it to the Makers
`class handler(BaseHTTPRequestHandler)` entry-point convention.
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from sherlock_core.sherlock import sherlock
from sherlock_core.sites import SitesInformation
from sherlock_core.result import QueryStatus

# Local data.json bundled with the function (no network fetch at build/run).
DATA_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "sherlock_core", "resources", "data.json")
)

# Loaded once per cold start. honor_exclusions=False avoids a runtime fetch
# of the upstream false-positive exclusion list.
# sherlock() expects {site_name: info_dict}; SiteInformation.information is
# exactly that dict, so flatten the loader's objects into a plain mapping.
_SITES = {
    site.name: site.information
    for site in SitesInformation(data_file_path=DATA_PATH, honor_exclusions=False)
}


class _Collector:
    """Duck-typed QueryNotify replacement: just collects, prints nothing."""

    def start(self, *args, **kwargs):
        pass

    def update(self, result):
        self.results.append(result)

    def __init__(self):
        self.results = []


def _status_text(query_status):
    try:
        return str(query_status.value)
    except AttributeError:
        return str(query_status)


def _filter_sites(sites, only_sites=None, exclude_nsfw=False):
    out = sites
    if exclude_nsfw:
        out = {name: info for name, info in out.items() if not info.get("isNSFW")}
    if only_sites:
        wanted = {s.strip() for s in only_sites if s.strip()}
        out = {name: info for name, info in out.items() if name in wanted}
    return out


def _run_scan(username, timeout=30.0, only_sites=None, exclude_nsfw=False, proxy=None):
    site_data = _filter_sites(_SITES, only_sites=only_sites, exclude_nsfw=exclude_nsfw)
    notify = _Collector()

    start = time.monotonic()
    raw = sherlock(
        username=username,
        site_data=site_data,
        query_notify=notify,
        proxy=proxy,
        timeout=timeout,
    )
    elapsed = round(time.monotonic() - start, 2)

    results = {}
    found = 0
    for site_name, entry in raw.items():
        status_obj = entry.get("status")
        if status_obj is None:
            continue
        status = _status_text(status_obj.status)
        if status == "Claimed":
            found += 1
        results[site_name] = {
            "status": status,
            "url": entry.get("url_user", ""),
            "http_status": entry.get("http_status", ""),
            "context": status_obj.context,
            "query_time": (
                round(status_obj.query_time, 3)
                if isinstance(status_obj.query_time, (int, float))
                else None
            ),
        }

    return {
        "username": username,
        "elapsed_seconds": elapsed,
        "total_sites": len(site_data),
        "found": found,
        "results": results,
    }


class handler(BaseHTTPRequestHandler):
    server_version = "sherlock_edgeone"

    # ---- helpers ---------------------------------------------------------
    def _respond(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _params(self, query_pairs, body=None):
        params = {k: v[0] for k, v in parse_qs(query_pairs or "").items()}
        if body:
            if isinstance(body, dict):
                params.update({k: v for k, v in body.items() if v is not None})
        return params

    # ---- verbs -----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = self._params(parsed.query)
        self._handle(params)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            body = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            return self._respond(400, {"error": "Request body is not valid JSON."})
        if not isinstance(body, dict):
            return self._respond(400, {"error": "JSON body must be an object."})
        params = self._params(parsed.query, body=body)
        self._handle(params)

    # ---- core ------------------------------------------------------------
    def _handle(self, params):
        username = params.get("username") or params.get("u")
        if not username:
            return self._respond(400, {
                "error": "Missing required parameter 'username'.",
                "usage": {
                    "GET": "/api/sherlock?username=<name>",
                    "POST": "/api/sherlock  {\"username\": \"<name>\"}",
                    "optional": {
                        "timeout": "seconds per request (default 20, max 60)",
                        "sites": "comma-separated site names to limit the scan",
                        "exclude_nsfw": "true to skip isNSFW sites",
                        "proxy": "http(s)/socks proxy URL (optional)",
                    },
                },
            })

        try:
            timeout = float(params.get("timeout", 20))
        except (TypeError, ValueError):
            return self._respond(400, {"error": "'timeout' must be a number."})
        # Per-request timeout. The whole invocation is capped by the Makers
        # cloud-function maxDuration (edgeone.json -> 120s), so keep this
        # modest for full scans and use `sites` for slow targeted lookups.
        timeout = max(1.0, min(timeout, 60.0))

        only_sites = None
        if params.get("sites"):
            only_sites = [s for s in params["sites"].split(",")]

        exclude_nsfw = str(params.get("exclude_nsfw", "")).lower() in ("1", "true", "yes")
        proxy = params.get("proxy") or None

        try:
            result = _run_scan(
                username,
                timeout=timeout,
                only_sites=only_sites,
                exclude_nsfw=exclude_nsfw,
                proxy=proxy,
            )
        except Exception as exc:  # noqa: BLE001 - surface as JSON 500
            return self._respond(500, {"error": f"Scan failed: {exc}"})

        self._respond(200, result)

    def log_message(self, *args):  # silence default stderr access log
        return
