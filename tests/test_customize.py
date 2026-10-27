import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from shirobird import customize, server

class CustomizeTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "customize.sqlite3"
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE ui_visibility (feature TEXT PRIMARY KEY, enabled INTEGER NOT NULL)")
        self.db_patch = patch.object(server, "connection", self.connect)
        self.db_patch.start()

    def tearDown(self):
        self.db_patch.stop()
        self.folder.cleanup()

    def connect(self):
        return sqlite3.connect(self.path)

    def test_defaults_hide_premium_and_keep_core(self):
        config = customize.get_settings()
        self.assertTrue(config["visibility"]["activity"])
        self.assertTrue(config["visibility"]["audit-events"])
        self.assertFalse(config["visibility"]["traffic-events"])
        self.assertTrue(config["visibility"]["posture-checks"])
        self.assertTrue(config["visibility"]["peers"])
        self.assertTrue(config["visibility"]["shirobird-traffic-flow"])

    def test_changes_are_persisted_and_reset(self):
        saved = customize.update_settings({"visibility": {
            "peers": False, "traffic-events": True
        }})
        self.assertFalse(saved["visibility"]["peers"])
        self.assertTrue(customize.get_settings()["visibility"]["traffic-events"])
        reset = customize.update_settings({"reset": True})
        self.assertTrue(reset["visibility"]["peers"])
        self.assertFalse(reset["visibility"]["traffic-events"])

    def test_strict_allowlist_and_boolean_validation(self):
        for payload in ({"visibility": {"customize": False}},
                        {"visibility": {"peers": "false"}},
                        {"visibility": {"peers": 1}},
                        {"visibility": {}},
                        {"reset": True, "visibility": {"peers": False}},
                        {"unexpected": True}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                customize.update_settings(payload)
        self.assertEqual(customize.get_settings()["visibility"]["peers"], True)

if __name__ == "__main__":
    unittest.main()
