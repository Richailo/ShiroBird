"""Unit tests for configurable SIEM Syslog forwarding."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from shirobird import server

class SyslogSettingsTests(unittest.TestCase):
    def test_accepts_udp_destination(self):
        value = {"enabled": True, "host": "192.0.2.50",
                 "port": 5514, "protocol": "udp"}
        self.assertEqual(server.validate_syslog_settings(value), value)

    def test_bad_destinations_rejected(self):
        for host in ("", "invalid host", "bad/host"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                server.validate_syslog_settings({
                    "enabled": True, "host": host, "port": 514, "protocol": "udp"})

    def test_persisted_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "settings.json"
            with patch.object(server, "SIEM_SETTINGS_PATH", config):
                settings = {"enabled": True, "host": "198.51.100.2",
                            "port": 5514, "protocol": "udp"}
                server.save_syslog_settings(settings)
                self.assertEqual(server.syslog_settings(), settings)
