"""NetBird-backed short-lived ShiroBird sessions. Never stores OIDC access tokens."""
import hashlib
import hmac
import json
import re
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

ALLOWED_ROLES = {"owner", "admin"}
SESSION_SECONDS = 180

class _NeverRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def current_admin(access_token: str, endpoint: str) -> dict | None:
    """Ask the real NetBird management API to authenticate this exact token."""
    if not isinstance(access_token, str) or not 16 <= len(access_token) <= 8192:
        return None
    if not re.fullmatch(r"[A-Za-z0-9._~+/-]+", access_token):
        return None
    if not endpoint.startswith("http://netbird-server:80/"):
        raise ValueError("NetBird URL must be internal Docker management service")
    req = Request(endpoint, headers={"Authorization": "Bearer " + access_token,
                                     "Accept": "application/json"})
    try:
        with build_opener(_NeverRedirect()).open(req, timeout=4) as response:
            if response.status != 200:
                return None
            payload = response.read(16385)
        if len(payload) > 16384:
            return None
        user = json.loads(payload)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, TypeError):
        return None
    if (not isinstance(user, dict) or
        str(user.get("role", "")).lower() not in ALLOWED_ROLES or
        user.get("status") != "active" or
        user.get("is_blocked", False) or
        user.get("is_service_user", False) or
        not isinstance(user.get("id"), str) or not user["id"]):
        return None
    return {"id": user["id"], "role": user["role"], "name": str(user.get("name", ""))[:80]}

def sign_session(user_id: str, key: str, now: int | None = None) -> str:
    expiry = int(time.time() if now is None else now) + SESSION_SECONDS
    fingerprint = hashlib.sha256(user_id.encode()).hexdigest()[:24]
    payload = f"nb.{expiry}.{fingerprint}"
    digest = hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{digest}"

def session_valid(value: str, key: str, now: int | None = None) -> bool:
    if not isinstance(value, str) or len(value) > 180:
        return False
    match = re.fullmatch(r"nb\.([0-9]{10})\.([0-9a-f]{24})\.([0-9a-f]{64})", value)
    if not match:
        return False
    current = int(time.time() if now is None else now)
    expiry = int(match.group(1))
    if not current < expiry <= current + SESSION_SECONDS:
        return False
    payload = value.rsplit(".", 1)[0]
    digest = hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, match.group(3))
