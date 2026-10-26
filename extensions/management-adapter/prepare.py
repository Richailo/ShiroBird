"""Apply the opt-in adapter ONLY to a disposable NetBird v0.81.3 source checkout."""
import argparse
import hashlib
from pathlib import Path

HASHES = {
    "conversion.go": "3f2ba8e32742572c628b682caeb78d760ab8c9443e495b035f61483428806187",
    "components_envelope_response.go": "29d338b802dbd8a16e516a7831609547d30aeee2af062a276aa5b64fbd49c7ea",
    "token_mgr.go": "5d241e080852cb0949a4873ded95fcddebcbe7891fadc7b198ef4d7df3f3821c",
}
IMPORT = '\t"github.com/netbirdio/netbird/management/server/shirobirdflow"\n'
CTOR = "func NewTimeBasedAuthSecretsManager("
CHECK = """
    var flowRefreshTTL time.Duration
    if relayCfg != nil { flowRefreshTTL = relayCfg.CredentialsTTL.Duration }
    if err := shirobirdflow.ValidateRefresh(relayCfg != nil, flowRefreshTTL); err != nil {
        return nil, err
    }
"""

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("upstream integration anchor changed or is ambiguous")
    return text.replace(old, new, 1)


def prepare(root, compatible=False):
    root = Path(root).resolve(strict=True)
    if not (root / "go.mod").is_file() or "module github.com/netbirdio/netbird" not in (root / "go.mod").read_text():
        raise ValueError("not a NetBird source tree")
    target = root / "management/server/shirobirdflow"
    if target.exists():
        raise ValueError("adapter already exists; use a fresh disposable checkout")
    changed = {}
    for name, expected in HASHES.items():
        path = root / "management/internals/shared/grpc" / name
        data = path.read_bytes()
        if not compatible and hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("upstream source differs from verified v0.81.3: " + name)
        text = data.decode()
        if "shirobirdflow" in text:
            raise ValueError("source already contains ShiroBird hooks")
        text = replace_once(text, "import (\n", "import (\n" + IMPORT)
        if name == "conversion.go":
            text = replace_once(text, "\tresponse.NetbirdConfig = extendedConfig",
                                "\tresponse.NetbirdConfig = shirobirdflow.Extend(peer.ID, peerGroups, extendedConfig)")
        elif name == "components_envelope_response.go":
            line = "\tresp.NetbirdConfig = integrationsConfig.ExtendNetBirdConfig(peer.ID, peerGroups, nbConfig, extraSettings)"
            text = replace_once(text, line, line + "\n\tresp.NetbirdConfig = shirobirdflow.Extend(peer.ID, peerGroups, resp.NetbirdConfig)")
        else:
            text = replace_once(text, "\tupdate.NetbirdConfig = extendedConfig",
                                "\tupdate.NetbirdConfig = shirobirdflow.Extend(peerID, peerGroups, extendedConfig)")
            if text.count(CTOR) != 1:
                raise ValueError("upstream credential manager constructor changed")
            pos = text.index("\n", text.index(CTOR)) + 1
            if not text[:pos].rstrip().endswith("{"):
                raise ValueError("upstream credential manager signature changed")
            text = text[:pos] + CHECK + text[pos:]
        changed[path] = text
    # Validate every source and read every new file before the first write.
    package = {name: (Path(__file__).parent / name).read_bytes()
               for name in ("adapter.go", "adapter_test.go", "LICENSE")}
    target.mkdir(parents=True)
    for name, content in package.items():
        (target / name).write_bytes(content)
    for path, text in changed.items():
        path.write_text(text)
    return list(changed)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--compatible", action="store_true",
                        help="allow changed source only when every hook still matches; build and tests remain mandatory")
    args = parser.parse_args()
    for path in prepare(args.source_dir, compatible=args.compatible):
        print(path)
