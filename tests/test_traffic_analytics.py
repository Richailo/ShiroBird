"""Flow analytics counts only observed conntrack activity, never policy decisions."""
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from shirobird import server

class FlowAnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.db = Path(self.folder.name) / "flows.sqlite3"
        self.path_patch = patch.object(server, "DB_PATH", self.db)
        self.path_patch.start()
        server.init_db()

    def tearDown(self):
        self.path_patch.stop()
        self.folder.cleanup()

    def populate(self):
        now = int(time.time())
        with sqlite3.connect(self.db) as db:
            db.executemany(
                "INSERT INTO flows (ts,sensor,type,proto,src,dst,sport,dport,packets,bytes) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)", [
                    (now-10,"peer-a","NEW","tcp","100.64.1.2","100.64.1.3",49000,443,0,0),
                    (now-8,"peer-a","UPDATE","tcp","100.64.1.2","100.64.1.3",49000,443,4,400),
                    (now-4,"peer-a","DESTROY","tcp","100.64.1.2","100.64.1.3",49000,443,7,700),
                    (now-3,"peer-a","NEW","udp","100.64.1.2","192.168.2.20",55321,53,0,0),
                    (now-90000,"peer-a","NEW","tcp","100.64.1.2","100.64.1.4",49001,22,0,0)
                ])

    def test_grouping_and_no_duplicate_bytes(self):
        self.populate()
        response = server.flow_analytics(60)
        self.assertFalse(response["policy_decisions_available"])
        self.assertFalse(response["drops_available"])
        self.assertEqual(response["total"]["starts"], 2)
        self.assertEqual(response["total"]["ends"], 1)
        self.assertEqual(response["total"]["bytes"], 700)
        self.assertEqual(response["total"]["packets"], 7)
        self.assertEqual(len(response["flows"]), 2)
        tcp = [row for row in response["flows"] if row["proto"] == "tcp"][0]
        self.assertEqual(tcp["starts"], 1)
        self.assertEqual(tcp["ends"], 1)
        self.assertEqual(tcp["bytes"], 700)

    def test_time_windows_and_destination_rank(self):
        self.populate()
        response = server.flow_analytics(1440)
        self.assertEqual(response["total"]["starts"], 2)
        self.assertEqual(len(response["destinations"]), 2)
        self.assertTrue(response["trend"])

    def test_unsupported_time_window_rejected(self):
        with self.assertRaises(ValueError):
            server.flow_analytics(42)
