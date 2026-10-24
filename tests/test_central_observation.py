import ipaddress
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from shirobird import collector, server

class CentralObservationTests(unittest.TestCase):
    def test_real_extended_format_ipv4_and_ipv6(self):
        for family, src, dst, cidr in [
            ("ipv4 2", "100.64.177.75", "192.168.0.201", "100.64.0.0/16"),
            ("ipv6 10", "fdba:3a54::1", "fdba:3a54::2", "fdba:3a54::/64")]:
            line = ("[1792874756.151766] [DESTROY] " + family +
                    " udp 17 src=" + src + " dst=" + dst +
                    " sport=54321 dport=9 packets=2 bytes=80 src=" + dst +
                    " dst=" + src + " sport=9 dport=54321 packets=1 bytes=40")
            event = collector.parse_line(line, networks=[ipaddress.ip_network(cidr)])
            self.assertEqual(event["bytes"], 120)
            self.assertEqual(event["packets"], 3)
            self.assertEqual(event["src"], src)
            self.assertTrue(event["event_ref"])

    def test_lan_only_excluded(self):
        self.assertIsNone(collector.parse_line(
            "[NEW] ipv4 2 tcp 6 src=192.168.0.1 dst=8.8.8.8 sport=1 dport=443",
            networks=[ipaddress.ip_network("100.64.0.0/16")]))

    def test_auto_discovery_and_missing_interface(self):
        addresses = [{"addr_info": [
            {"family":"inet", "scope":"global", "local":"100.64.177.75", "prefixlen":16},
            {"family":"inet6", "scope":"global", "local":"fdba:3a54::1", "prefixlen":64},
            {"family":"inet6", "scope":"link", "local":"fe80::1", "prefixlen":64}]}]
        with patch.dict("os.environ", {"SHIROBIRD_NETWORKS":"auto"}):
            with patch.object(collector.subprocess, "run") as run:
                run.return_value.stdout = json.dumps(addresses)
                self.assertEqual([str(n) for n in collector.discover_networks()],
                                 ["100.64.0.0/16", "fdba:3a54::/64"])
            with patch.object(collector.subprocess, "run", side_effect=OSError):
                self.assertEqual(collector.discover_networks(), [])

    def test_coverage_roundtrip_and_validation(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(
                server, "DB_PATH", Path(folder) / "db.sqlite"):
            server.init_db()
            detail = {"networks":["100.64.0.0/16"], "capture_ready":False}
            server.touch_sensor("router", True, coverage=detail)
            data = server.sensor_status()["sensors"][0]
            self.assertTrue(data["online"])
            self.assertFalse(data["coverage"]["capture_ready"])
            self.assertEqual(data["coverage"]["scope"], "local_and_routed")
            with self.assertRaises(ValueError):
                server.touch_sensor("router", coverage={"networks":["invalid"], "capture_ready":True})
