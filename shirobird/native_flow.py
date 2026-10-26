"""Optional server-side bridge to the independent native-flow receiver."""
import json
import os
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def snapshot(after=0, limit=200, query=None):
    url = os.getenv("SHIROBIRD_NATIVE_API_URL", "").rstrip("/")
    if not url:
        return {"configured": False, "available": False, "flows": [],
                "note": "Native peer reporting is not configured; central observation remains separate."}
    try:
        parts = urlsplit(url)
        if (parts.scheme not in ("http", "https") or not parts.hostname or
                parts.username or parts.password or parts.query or parts.fragment or parts.path):
            raise ValueError("invalid receiver URL")
        token_file = os.getenv("SHIROBIRD_NATIVE_API_TOKEN_FILE", "")
        if not token_file:
            raise ValueError("receiver token file required")
        token = Path(token_file).read_text().strip()
        if len(token) < 32:
            raise ValueError("receiver token too short")
        opener = build_opener(NoRedirect())

        def get(path):
            req = Request(url + path, headers={"Authorization": "Bearer " + token})
            with opener.open(req, timeout=3) as response:
                data = response.read(1024 * 1024 + 1)
                if len(data) > 1024 * 1024:
                    raise ValueError("receiver response too large")
                result = json.loads(data)
                if not isinstance(result, dict):
                    raise ValueError("invalid receiver response")
                return result

        status = get("/api/native/status")
        if query is not None:
            allowed = {"start", "end", "offset", "limit", "snapshot", "q", "match", "peer_ip",
                       "protocol", "direction", "src", "dst", "reporter_id", "event", "kind", "sort", "order"}
            page = get("/api/native/events?" + urlencode({k: v for k, v in query.items() if k in allowed}, doseq=True))
        else:
            page = get("/api/native/flows?after=" + str(max(0, int(after))) +
                       "&limit=" + str(min(1000, max(1, int(limit)))))
        return {"configured": True, "available": True, "status": status,
                **page,
                "note": "Peer-reported native flows; reporter perspectives are not deduplicated across peers. "
                        "Do not add native counters to central conntrack totals."}
    except (OSError, URLError, ValueError, KeyError, TypeError):
        return {"configured": True, "available": False, "flows": [],
                "note": "Native receiver unavailable. Check its service and server-side credentials."}
