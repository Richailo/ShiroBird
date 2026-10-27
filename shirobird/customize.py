"""Installation-wide navigation visibility; this is UI only, never authorization."""
from contextlib import closing
from shirobird import server as _server

# id, localized UI label, group, premium, aliases used by the native adapter
FEATURES = [
    ("control-center", "Control Center", "Navigation", False, ["control center"]),
    ("peers", "Peers", "Navigation", False, ["peers"]),
    ("access-control", "Access Control", "Navigation", False, ["access control"]),
    ("network-routing", "Network Routing", "Navigation", False, ["network routing"]),
    ("reverse-proxy", "Reverse Proxy", "Navigation", False, ["reverse proxy"]),
    ("dns", "DNS", "Navigation", False, ["dns"]),
    ("team", "Team", "Navigation", False, ["team"]),
    ("activity", "Activity", "Navigation", False, ["activity"]),
    ("settings", "Settings", "Navigation", False, ["settings"]),
    ("integrations", "Integrations", "Navigation", False, ["integrations"]),
    ("documentation", "Documentation", "Navigation", False, ["documentation"]),
    ("setup-keys", "Setup Keys", "Subpages", False, ["setup keys"]),
    ("access-policies", "Access Policies", "Subpages", False, ["access policies", "policies"]),
    ("posture-checks", "Posture Checks", "Subpages", False, ["posture checks"]),
    ("networks", "Networks", "Subpages", False, ["networks"]),
    ("network-routes", "Network Routes", "Subpages", False, ["network routes", "routes"]),
    ("users", "Users", "Subpages", False, ["users"]),
    ("groups", "Groups", "Subpages", False, ["groups"]),
    ("audit-events", "Audit Events", "Subpages", False, ["audit events", "audit logs"]),
    ("traffic-events", "Traffic Events", "Premium", True, ["traffic events", "traffic logging"]),
    ("event-streaming", "Event Streaming", "Premium", True, ["event streaming", "events streaming"]),
    ("device-approvals", "Device Approvals", "Premium", True, ["device approvals", "device approval"]),
    ("scim", "SCIM Provisioning", "Premium", True, ["scim", "provisioning"]),
    ("shirobird-traffic-flow", "Traffic Flow", "ShiroBird", False, []),
    ("shirobird-siem-integration", "SIEM Integration", "ShiroBird", False, []),
]
DEFAULTS = {key: not premium for key, _, _, premium, _ in FEATURES}
KEYS = frozenset(DEFAULTS)

def get_settings():
    with closing(_server.connection()) as db, db:
        overrides = dict(db.execute("SELECT feature, enabled FROM ui_visibility"))
    visibility = {key: bool(overrides[key]) if key in overrides else val
                  for key, val in DEFAULTS.items()}
    return {"features": [{"id": key, "label": label, "group": group,
                          "paid": premium, "aliases": aliases}
                         for key, label, group, premium, aliases in FEATURES],
            "visibility": visibility}

def update_settings(data):
    if not isinstance(data, dict) or (set(data) - {"visibility", "reset"}):
        raise ValueError("invalid settings object")
    if "reset" in data and (data.get("reset") is not True or set(data) != {"reset"}):
        raise ValueError("invalid reset request")
    if data.get("reset") is True and set(data) == {"reset"}:
        with _server.WRITE_LOCK, closing(_server.connection()) as db, db:
            db.execute("DELETE FROM ui_visibility")
        return get_settings()
    values = data.get("visibility")
    if not isinstance(values, dict) or not values or not set(values) <= KEYS:
        raise ValueError("unknown or missing feature")
    if any(type(value) is not bool for value in values.values()):
        raise ValueError("feature visibility must be boolean")
    with _server.WRITE_LOCK, closing(_server.connection()) as db, db:
        db.executemany("INSERT INTO ui_visibility(feature,enabled) VALUES (?,?) "
                       "ON CONFLICT(feature) DO UPDATE SET enabled=excluded.enabled",
                       [(key, int(value)) for key, value in values.items()])
    return get_settings()
