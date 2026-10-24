"""Windows WFP events preserve provenance and cannot be mistaken for NetBird policy IDs."""
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from shirobird import server

class WindowsIngestionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "flow.db"
        self.jsonl = Path(self.tmp.name) / "siem" / "events.jsonl"
        self.patches = [
            patch.object(server, "DB_PATH", self.db),
            patch.object(server, "SIEM_PATH", self.jsonl),
            patch.object(server, "SIEM_SETTINGS_PATH", Path(self.tmp.name) / "siem" / "settings.json"),
        ]
        for p in self.patches: p.start()
        server.init_db()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.tmp.cleanup()

    def event(self, event_type="BLOCK", number=314):
        return {
            "type": event_type, "source": "windows_wfp",
            "proto": "tcp", "src": "100.64.1.4", "dst": "100.64.1.5",
            "sport": 5454, "dport": 443, "direction": "outbound",
            "application": "C:\\Program Files\\NetBird\\netbird.exe",
            "filter_id": "990", "event_ref": "security:" + str(number),
            "ts": int(time.time())
        }

    def test_windows_block_ingestion_is_idempotent(self):
        event = self.event()
        self.assertEqual(server.write_events([event], "peer-win"), 1)
        self.assertEqual(server.write_events([event], "peer-win"), 0)
        row = server.query_flows(1)[0]
        self.assertEqual(row["type"], "BLOCK")
        self.assertEqual(row["source"], "windows_wfp")
        self.assertEqual(row["filter_id"], "990")
        self.assertEqual(row["direction"], "outbound")
        self.assertEqual(self.jsonl.read_text().count("\n"), 1)

    def test_win_verdict_requires_win_source_and_ref(self):
        ev = self.event()
        ev["source"] = "linux_conntrack"
        with self.assertRaises(ValueError): server.validate_event(ev, "peer-win")
        ev["source"] = "windows_wfp"
        ev.pop("event_ref")
        with self.assertRaises(ValueError): server.validate_event(ev, "peer-win")

    def test_connection_block_and_packet_drop_are_different(self):
        self.assertEqual(server.write_events([
            self.event("ALLOW", 315),
            self.event("BLOCK", 316),
            self.event("DROP", 317)], "peer-win"), 3)
        analytics = server.flow_analytics(60)
        self.assertEqual(analytics["total"]["allows"], 1)
        self.assertEqual(analytics["total"]["blocks"], 1)
        self.assertEqual(analytics["total"]["drops"], 1)
        self.assertTrue(analytics["wfp_decisions_available"])
        self.assertFalse(analytics["policy_decisions_available"])
        self.assertIn("windows_wfp", analytics["sources"])
        self.assertEqual(analytics["total"]["bytes"], 0)

    def test_old_database_migrates_without_data_loss(self):
        with sqlite3.connect(self.db) as c:
            c.execute("DROP INDEX IF EXISTS flows_event_ref")
            c.execute("DROP TABLE flows")
            c.execute("""CREATE TABLE flows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL, sensor TEXT NOT NULL, type TEXT NOT NULL,
                proto TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
                sport INTEGER NOT NULL DEFAULT 0, dport INTEGER NOT NULL DEFAULT 0,
                packets INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0)""")
            c.execute("""INSERT INTO flows(ts,sensor,type,proto,src,dst)
                      VALUES(?,?,?,?,?,?)""", (
                int(time.time()), "legacy-peer", "NEW", "tcp",
                "100.64.1.1", "100.64.1.2"))
        server.init_db()
        rows = server.query_flows(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sensor"], "legacy-peer")
        self.assertEqual(rows[0]["source"], "linux_conntrack")
        self.assertEqual(rows[0]["event_ref"], "")
