"""Sensor heartbeat registry and telemetry coverage tests."""
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from shirobird import server
from shirobird import collector

class SensorHeartbeatTests(unittest.TestCase):
    def test_registered_sensor_reports_kernel_accounting(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(
                server, "DB_PATH", Path(folder) / "db.sqlite"):
            server.init_db()
            server.touch_sensor("node-01", True)
            status = server.sensor_status()["sensors"]
            self.assertEqual(len(status), 1)
            self.assertEqual(status[0]["name"], "node-01")
            self.assertTrue(status[0]["online"])
            self.assertTrue(status[0]["accounting_enabled"])
            server.touch_sensor("node-01", False)
            result = server.sensor_status()["sensors"]
            self.assertEqual(len(result), 1)
            self.assertFalse(result[0]["accounting_enabled"])

    def test_invalid_accounting_and_origin_rejected(self):
        with self.assertRaises(ValueError):
            server.touch_sensor("test-node", "false")
        with self.assertRaises(ValueError):
            server.touch_sensor("test-node", False, "fake_source")

    def test_accounting_probe_missing_returns_false(self):
        with patch("builtins.open", side_effect=OSError("unavailable")):
            self.assertFalse(collector.accounting_enabled())
