"""SIEM Integration reports truthful local-export state; remote delivery is never assumed."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shirobird import server

class SiemStatusTests(unittest.TestCase):
    def test_empty_export_is_ready_not_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            with patch.object(server, "SIEM_PATH", path), \
                 patch.object(server, "stats", return_value={"total": 0}), \
                 patch.object(server, "SYSLOG_TARGET", ""):
                result = server.siem_status()
            self.assertTrue(result["jsonl"]["ready"])
            self.assertFalse(result["jsonl"]["exists"])
            self.assertEqual(result["total_flow_events"], 0)
            self.assertFalse(result["remote_ingestion_verified"])
            self.assertFalse(result["syslog"]["configured"])

    def test_existing_file_and_udp_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text('{"integration":"shirobird"}\n')
            with patch.object(server, "SIEM_PATH", path), \
                 patch.object(server, "stats", return_value={"total": 1}), \
                 patch.object(server, "SYSLOG_TARGET", "127.0.0.1"), \
                 patch.object(server, "SYSLOG_PORT", 1514):
                result = server.siem_status()
            self.assertTrue(result["jsonl"]["exists"])
            self.assertGreater(result["jsonl"]["size_bytes"], 0)
            self.assertEqual(result["syslog"]["port"], 1514)
            self.assertTrue(result["syslog"]["configured"])
            self.assertFalse(result["remote_ingestion_verified"])
