import importlib
import ipaddress
import os
import tempfile
import unittest
from pathlib import Path

_temp = tempfile.TemporaryDirectory()
os.environ["SHIROBIRD_DATA"] = _temp.name
os.environ["SHIROBIRD_ADMIN_TOKEN"] = "a" * 64
os.environ["SHIROBIRD_INGEST_TOKEN"] = "b" * 64
from shirobird import server, collector

class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()

    def test_validation(self):
        row = server.validate_event({"type": "NEW", "proto": "tcp", "src": "100.64.0.1",
             "dst": "10.0.0.1", "sport": 123, "dport": 443}, "router")
        self.assertEqual(row[2], "NEW")

    def test_bad_ipv4(self):
        with self.assertRaises(ValueError):
            server.validate_event({"type": "NEW", "proto": "tcp", "src": "not-an-ip",
                "dst": "10.0.0.1"}, "router")

    def test_no_negative_counters(self):
        with self.assertRaises(ValueError):
            server.validate_event({"type": "NEW", "proto": "tcp", "src": "100.64.0.1",
                "dst": "10.0.0.1", "bytes": -1}, "router")

    def test_siem_and_db(self):
        n = server.write_events([{"type": "DESTROY", "proto": "udp", "src": "100.64.1.2",
            "dst": "192.168.1.1", "bytes": 300}], "gateway")
        self.assertEqual(n, 1)
        self.assertEqual(server.query_flows()[0]["sensor"], "gateway")
        self.assertIn('"integration":"shirobird"', server.SIEM_PATH.read_text())

    def test_session_expiry(self):
        token = server.session_value(2000000000)
        self.assertTrue(server.session_valid(token))
        self.assertFalse(server.session_valid(server.session_value(10)))
        self.assertFalse(server.session_valid(token + "wrong"))

class CollectorTests(unittest.TestCase):
    def test_conntrack(self):
        line = "[2026-10-24 17:30:00] [DESTROY] tcp 6 100 TIME_WAIT src=100.64.1.2 dst=192.168.0.10 sport=1234 dport=443 packets=3 bytes=200 src=192.168.0.10 dst=100.64.1.2 sport=443 dport=1234 packets=4 bytes=300"
        event = collector.parse_line(line)
        self.assertEqual(event["bytes"], 500)
        self.assertEqual(event["packets"], 7)
        self.assertEqual(event["type"], "DESTROY")

    def test_non_netbird_filter(self):
        self.assertIsNone(collector.parse_line(
            "[NEW] tcp 6 100 src=10.0.0.1 dst=8.8.8.8 sport=12 dport=53"))

    def test_ipv6(self):
        line = "[NEW] udp 17 30 src=fdba::1 dst=fdba::2 sport=123 dport=53"
        self.assertIsNotNone(collector.parse_line(line, networks=[ipaddress.ip_network("fdba::/16")]))

if __name__ == "__main__":
    unittest.main()