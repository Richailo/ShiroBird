import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from shirobird import native_flow


class NativeFlowBridgeTests(unittest.TestCase):
    def test_disabled_by_default(self):
        with patch.dict("os.environ", {"SHIROBIRD_NATIVE_API_URL": ""}):
            self.assertFalse(native_flow.snapshot()["configured"])

    def test_unavailable_does_not_expose_secret(self):
        with patch.dict("os.environ", {"SHIROBIRD_NATIVE_API_URL": "http://receiver:8085",
                                      "SHIROBIRD_NATIVE_API_TOKEN_FILE": "/missing-secret"}):
            data = native_flow.snapshot()
            self.assertTrue(data["configured"])
            self.assertFalse(data["available"])
            self.assertNotIn("/missing-secret", json.dumps(data))

    def test_proxy_preserves_aggregates_and_bounds_pagination(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token"
            path.write_text("s" * 64)
            with patch.dict("os.environ", {
                "SHIROBIRD_NATIVE_API_URL": "http://receiver:8085",
                "SHIROBIRD_NATIVE_API_TOKEN_FILE": str(path)
            }), patch.object(native_flow, "build_opener") as opener:
                opener.return_value.open.side_effect = [
                    io.BytesIO(b'{"total":1}'),
                    io.BytesIO(b'{"flows":[{"num_of_starts":8}],"next_cursor":1}')]
                data = native_flow.snapshot(0, 99999)
                self.assertEqual(data["flows"][0]["num_of_starts"], 8)
                self.assertNotIn("s" * 64, json.dumps(data))
                request = opener.return_value.open.call_args.args[0]
                self.assertTrue(request.full_url.endswith("limit=1000"))

    def test_empty_optional_filters_are_omitted(self):
        with tempfile.TemporaryDirectory() as directory:
            key_file=Path(directory)/"token"
            key_file.write_text("s"*64)
            with patch.dict("os.environ", {
                "SHIROBIRD_NATIVE_API_URL": "http://receiver:8085",
                "SHIROBIRD_NATIVE_API_TOKEN_FILE": str(key_file)
            }), patch.object(native_flow, "build_opener") as opener:
                opener.return_value.open.side_effect=[
                    io.BytesIO(b'{"total":10,"last_received":1000}'),
                    io.BytesIO(b'{"flows":[{"id":1}],"total":10,"page":0}')]
                data=native_flow.snapshot(filters={
                    "before":"","limit":"100","start":"0","end":"0",
                    "q":"","protocol":"0","state":"","page":"0",
                    "sort":"time","order":"desc"})
                self.assertTrue(data["available"])
                self.assertEqual(data["total"],10)
                url=opener.return_value.open.call_args.args[0].full_url
                self.assertNotIn("before=",url)
                self.assertNotIn("q=",url)
                self.assertIn("limit=100",url)

    def test_invalid_query_does_not_claim_receiver_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            key_file=Path(directory)/"token"
            key_file.write_text("s"*64)
            with patch.dict("os.environ", {
                "SHIROBIRD_NATIVE_API_URL": "http://receiver:8085",
                "SHIROBIRD_NATIVE_API_TOKEN_FILE": str(key_file)
            }), patch.object(native_flow, "build_opener") as opener:
                failure=HTTPError("http://receiver:8085/api/native/query",
                                  400, "Bad Request",{},io.BytesIO(b'{}'))
                opener.return_value.open.side_effect=[
                    io.BytesIO(b'{"total":10,"last_received":1000}'),failure]
                data=native_flow.snapshot(filters={"limit":"999"})
                self.assertFalse(data["available"])
                self.assertTrue(data["receiver_online"])
                self.assertEqual(data["status"]["total"],10)
                self.assertIn("HTTP 400",data["note"])
                self.assertNotIn("token",json.dumps(data))

    def test_redirects_are_not_followed(self):
        self.assertIsNone(native_flow.NoRedirect().redirect_request(None))

    def test_url_with_userinfo_is_rejected(self):
        with patch.dict("os.environ", {"SHIROBIRD_NATIVE_API_URL": "http://user:password@receiver:8085"}):
            self.assertFalse(native_flow.snapshot()["available"])
