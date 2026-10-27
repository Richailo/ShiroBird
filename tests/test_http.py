import http.cookiejar
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

tmp = tempfile.TemporaryDirectory()
os.environ["SHIROBIRD_DATA"] = tmp.name
os.environ["SHIROBIRD_ADMIN_TOKEN"] = "a" * 64
os.environ["SHIROBIRD_INGEST_TOKEN"] = "b" * 64
from shirobird import server
from http.server import ThreadingHTTPServer

class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()
        server.COOKIE_SECURE = False
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.http.daemon_threads = True
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()
        cls.base = "http://127.0.0.1:" + str(cls.http.server_port)
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
    def test_unauthorized(self):
        with self.assertRaises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(self.base + "/api/stats", timeout=3)
        self.assertEqual(err.exception.code, 401)
    def test_authenticated_read(self):
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        login = urllib.request.Request(self.base + "/api/login", data=json.dumps({"token": server.ADMIN_KEY}).encode(), headers={"Content-Type": "application/json"})
        self.assertEqual(opener.open(login, timeout=3).status, 200)
        self.assertEqual(opener.open(self.base + "/api/stats", timeout=3).status, 200)
    def test_ingest_and_export(self):
        event={"type":"NEW","proto":"tcp","src":"100.64.0.3","dst":"10.0.0.8","sport":1000,"dport":443}
        req=urllib.request.Request(self.base + "/api/ingest", data=json.dumps({"sensor":"unit-test","events":[event]}).encode(), headers={"Authorization":"Bearer "+server.INGEST_KEY,"Content-Type":"application/json"})
        self.assertEqual(urllib.request.urlopen(req,timeout=3).status,202)
        self.assertEqual(server.query_flows(1)[0]["sensor"],"unit-test")
    def test_unauthorized_ingest(self):
        req=urllib.request.Request(self.base + "/api/ingest",data=b"{}",headers={"Content-Type":"application/json"})
        with self.assertRaises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(req,timeout=3)
        self.assertEqual(err.exception.code,401)
