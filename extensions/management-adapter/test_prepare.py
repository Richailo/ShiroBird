import hashlib
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

import prepare

ARCHIVE_SHA256 = "a06c0c3ffc84a78a5ee019641988cfe0ea38ea980609535f66dd4ae82929daed"

class PreparationTests(unittest.TestCase):
    def setUp(self):
        archive = os.environ.get("SHIROBIRD_NETBIRD_ARCHIVE")
        if not archive:
            self.skipTest("SHIROBIRD_NETBIRD_ARCHIVE not supplied")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.assertEqual(hashlib.sha256(Path(archive).read_bytes()).hexdigest(), ARCHIVE_SHA256)
        paths = ["go.mod"] + ["management/internals/shared/grpc/" + p for p in prepare.HASHES]
        with tarfile.open(archive) as source:
            for name in paths:
                target = self.root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.extractfile("netbird-0.81.3/" + name).read())

    def test_supported_source_and_repeat_rejection(self):
        changed = prepare.prepare(self.root)
        self.assertEqual(len(changed), 3)
        before = {p: p.read_bytes() for p in changed}
        self.assertIn("shirobirdflow.Extend", changed[0].read_text())
        with self.assertRaises(ValueError):
            prepare.prepare(self.root)
        self.assertEqual(before, {p: p.read_bytes() for p in changed})

    def test_changed_last_file_leaves_earlier_files_untouched(self):
        base = self.root / "management/internals/shared/grpc"
        (base / "token_mgr.go").write_text("incompatible source")
        before = {name: (base / name).read_bytes() for name in prepare.HASHES}
        with self.assertRaises(ValueError):
            prepare.prepare(self.root)
        self.assertEqual(before, {name: (base / name).read_bytes() for name in prepare.HASHES})
        self.assertFalse((self.root / "management/server/shirobirdflow").exists())

    def test_wrong_project_rejected(self):
        (self.root / "go.mod").write_text("module example.invalid")
        with self.assertRaises(ValueError):
            prepare.prepare(self.root)

if __name__ == "__main__":
    unittest.main()
