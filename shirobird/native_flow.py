"""Optional server-side bridge to the independent native-flow receiver."""
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def snapshot(after=0, limit=200, filters=None, query=None):
    url = os.getenv("SHIROBIRD_NATIVE_API_URL", "").rstrip("/")
    if not url:
        return {"configured": False, "available": False, "flows": [],
                "note": "Native peer reporting is not configured; central observation remains separate."}
    status = None
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
        if query is not None and filters is None:
            # Legacy management-side filter API, keep older integrations
            # compatible. Unknown fields (including supplied tokens) omitted.
            options = {k: (v[0] if isinstance(v, (list,tuple)) and v else v)
                       for k,v in query.items() if k in
                       ("q","match","limit","from","to","protocol","direction","user_id",
                        "reporter_id","source_id","destination_id","type","page")}
            page=get("/api/native/flows?" + urlencode(options))
        elif filters is not None:
            options = {k: v for k, v in filters.items() if k in
                       ("before", "limit", "start", "end", "q", "protocol",
                        "state", "reporters", "ips", "search_ips", "page", "sort", "order", "flow_id")
                       and v is not None and str(v) != ""}
            page = get("/api/native/query?" + urlencode(options))
        else:
            page = get("/api/native/flows?after=" + str(max(0, int(after))) +
                       "&limit=" + str(min(1000, max(1, int(limit)))))
        return {"configured": True, "available": True, "status": status,
                "flows": page["flows"], "next_cursor": page.get("next_cursor"),
                "page": page.get("page",0), "snapshot": page.get("snapshot"),
                "has_more": page.get("has_more", False),
                "total": page.get("total", len(page["flows"])),
                "note": "Peer-reported native flows; reporter perspectives are not deduplicated across peers. "
                        "Do not add native counters to central conntrack totals."}
    except HTTPError as error:
        # An invalid query is NOT an offline receiver, and a previous
        # successful status response is useful for dashboard diagnostics.
        code = int(error.code)
        note = ("Native receiver rejected traffic filters (HTTP 400)."
                if code == 400 else
                "Native receiver rejected its service credential (HTTP %d)." % code
                if code in (401, 403) else
                "Native receiver returned an HTTP %d error." % code)
        return {"configured": True, "available": False,
                "receiver_online": status is not None,
                "status": status, "flows": [], "note": note}
    except (OSError, URLError, ValueError, KeyError, TypeError):
        return {"configured": True, "available": False, "flows": [],
                "note": "Native receiver connection or response unavailable. Check server logs."}
