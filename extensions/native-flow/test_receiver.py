import ipaddress
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import grpc
import flow_pb2 as pb
import flow_pb2_grpc as rpc
import receiver as r


def sample():
    event = pb.FlowEvent(event_id=b"e" * 16, public_key=b"k" * 32)
    event.timestamp.GetCurrentTime()
    event.window_start.seconds = event.timestamp.seconds - 60
    event.window_end.seconds = event.timestamp.seconds
    f = event.flow_fields
    f.flow_id = b"f" * 16
    f.rule_id = b"r" * 16
    f.source_ip = ipaddress.ip_address("100.64.1.2").packed
    f.dest_ip = ipaddress.ip_address("100.64.1.3").packed
    f.protocol, f.direction = 6, pb.EGRESS
    f.port_info.source_port, f.port_info.dest_port = 50000, 443
    f.num_of_starts, f.num_of_ends, f.num_of_drops = 5, 4, 2
    f.rx_bytes, f.tx_bytes, f.rx_packets, f.tx_packets = 1000, 2000, 10, 20
    return event


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.store = r.Store(self.folder.name)
        self.secret = b"s" * 64
        self.token = r.issue_token(self.secret, "peer-A", int(time.time()) + 300)
        self.server, port = r.make_grpc_server(self.secret, self.store)
        self.server.start()
        self.channel = grpc.insecure_channel("127.0.0.1:" + str(port))
        grpc.channel_ready_future(self.channel).result(timeout=5)
        self.stub = rpc.FlowServiceStub(self.channel)

    def tearDown(self):
        self.channel.close()
        self.server.stop(0).wait()
        self.folder.cleanup()

    def stream(self, events, token=None):
        return self.stub.Events(iter(events), timeout=5,
                                metadata=(("authorization", "Bearer " + (token or self.token)),))

    def test_native_handshake_aggregate_and_ack(self):
        event = sample()
        stream = self.stream([pb.FlowEvent(isInitiator=True), event])
        self.assertTrue(stream.initial_metadata())
        acks = list(stream)
        self.assertTrue(acks[0].isInitiator)
        self.assertEqual(acks[1].event_id, event.event_id)
        row = self.store.list_events()[0]
        self.assertEqual(row["reporter_id"], "peer-A")
        self.assertEqual(row["num_of_starts"], 5)
        self.assertEqual(row["num_of_drops"], 2)
        self.assertEqual(row["rx_bytes"] + row["tx_bytes"], 3000)
        self.assertEqual(row["rule_id"], (b"r" * 16).hex())
        self.assertIsNotNone(row["window_start"])

    def test_status_reports_native_event_counts_separately(self):
        self.store.save(r.event_record(sample(), "peer-A"))
        status=self.store.status()
        self.assertEqual(status["total"],1)
        self.assertEqual(status["reporters"],1)
        self.assertEqual(status["received_24h"],1)
        self.assertEqual(status["reports_with_drops"],1)
        self.assertIsInstance(status["last_received"],int)
        self.assertEqual(r.Store(self.folder.name).status()["total"],1)

    def test_retry_and_restart_are_idempotent(self):
        event = sample()
        for _ in range(2):
            self.assertEqual(len(list(self.stream([pb.FlowEvent(isInitiator=True), event]))), 2)
        self.assertEqual(len(r.Store(self.folder.name).list_events()), 1)

    def test_same_id_different_data_rejected(self):
        event = sample()
        list(self.stream([pb.FlowEvent(isInitiator=True), event]))
        event.flow_fields.tx_bytes += 1
        with self.assertRaises(grpc.RpcError) as err:
            list(self.stream([pb.FlowEvent(isInitiator=True), event]))
        self.assertEqual(err.exception.code(), grpc.StatusCode.INVALID_ARGUMENT)
        self.assertEqual(self.store.list_events()[0]["tx_bytes"], 2000)

    def test_invalid_token_cannot_ingest(self):
        bad = r.issue_token(b"x" * 64, "peer-A", int(time.time()) + 300)
        with self.assertRaises(grpc.RpcError) as err:
            list(self.stream([pb.FlowEvent(isInitiator=True), sample()], bad))
        self.assertEqual(err.exception.code(), grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self.store.status()["total"], 0)

    def test_expired_token_and_missing_auth_rejected(self):
        expired = r.issue_token(self.secret, "peer-A", int(time.time()) - 1)
        with self.assertRaises(grpc.RpcError):
            list(self.stream([pb.FlowEvent(isInitiator=True)], expired))
        with self.assertRaises(grpc.RpcError):
            list(self.stub.Events(iter([pb.FlowEvent(isInitiator=True)]), timeout=3))

    def test_handshake_required(self):
        with self.assertRaises(grpc.RpcError) as err:
            list(self.stream([sample()]))
        self.assertEqual(err.exception.code(), grpc.StatusCode.INVALID_ARGUMENT)

    def test_invalid_event_is_not_acknowledged_or_saved(self):
        event = sample()
        event.flow_fields.source_ip = b"bad"
        stream = self.stream([pb.FlowEvent(isInitiator=True), event])
        self.assertTrue(next(stream).isInitiator)
        with self.assertRaises(grpc.RpcError):
            next(stream)
        self.assertEqual(self.store.status()["total"], 0)

    def test_storage_failure_is_not_acknowledged(self):
        import sqlite3
        with patch.object(self.store, "save", side_effect=sqlite3.OperationalError("disk unavailable")):
            stream = self.stream([pb.FlowEvent(isInitiator=True), sample()])
            self.assertTrue(next(stream).isInitiator)
            with self.assertRaises(grpc.RpcError) as err:
                next(stream)
            self.assertEqual(err.exception.code(), grpc.StatusCode.UNAVAILABLE)

    def test_ipv6_and_legacy_end_event(self):
        event = sample()
        event.flow_fields.source_ip = ipaddress.ip_address("fdba::1").packed
        event.flow_fields.dest_ip = ipaddress.ip_address("fdba::2").packed
        event.flow_fields.num_of_starts = event.flow_fields.num_of_ends = event.flow_fields.num_of_drops = 0
        event.flow_fields.type = pb.TYPE_END
        row = r.event_record(event, "peer-A")
        self.assertEqual(row["num_of_ends"], 1)
        self.assertEqual(row["src"], "fdba::1")

    def test_reporter_is_token_identity_not_public_key(self):
        event = sample()
        event.public_key = b"z" * 32
        list(self.stream([pb.FlowEvent(isInitiator=True), event]))
        self.assertEqual(self.store.list_events()[0]["reporter_id"], "peer-A")

    def test_export_is_retryable_and_separate_from_ack(self):
        event = sample()
        list(self.stream([pb.FlowEvent(isInitiator=True), event]))
        self.assertEqual(self.store.export_pending(), 1)
        self.assertEqual(self.store.export_pending(), 0)
        logfile = next(self.store.directory.glob("native-*.jsonl"))
        row = json.loads(logfile.read_text())
        self.assertEqual(row["event_id"], event.event_id.hex())
        self.assertEqual(row["reporter_id"], "peer-A")

    def test_database_wide_filters_and_pagination(self):
        now = int(time.time())
        for index in range(4):
            event = sample()
            event.event_id = bytes([65+index]) * 16
            event.flow_fields.flow_id = bytes([70+index]) * 16
            event.timestamp.seconds = now - (86400*index)
            event.window_start.seconds = event.timestamp.seconds - 60
            event.window_end.seconds = event.timestamp.seconds
            event.flow_fields.dest_ip = ipaddress.ip_address(
                "192.168.0." + str(10+index)).packed
            event.flow_fields.port_info.dest_port = 443 if index%2==0 else 22
            if index == 3:
                event.flow_fields.num_of_drops = 2
                event.flow_fields.num_of_starts = 0
            self.store.save(r.event_record(event,"peer-A" if index%2==0 else "peer-B"))
        rows = self.store.search_events(limit=25)
        self.assertEqual(rows["total"],4)
        self.assertEqual(rows["flows"][0]["dst"],"192.168.0.10")
        self.assertEqual(self.store.search_events(limit=25,start=now-86400*2)["total"],3)
        self.assertEqual(self.store.search_events(limit=25,query="192.168.0.12")["total"],1)
        self.assertEqual(self.store.search_events(limit=25,query="443")["total"],2)
        self.assertEqual(self.store.search_events(limit=25,query="peer-B")["total"],2)
        self.assertEqual(self.store.search_events(limit=25,protocol=17)["total"],0)
        self.assertEqual(self.store.search_events(limit=25,state="blocked")["total"],4)
        self.assertEqual(self.store.search_events(limit=25,reporters=("peer-A",))["total"],2)
        self.assertEqual(self.store.search_events(limit=25,ips=("192.168.0.11",))["total"],1)
        self.assertEqual(self.store.search_events(limit=25,search_ips=("192.168.0.10",))["total"],1)
        self.assertEqual(self.store.search_events(limit=25,query="not-in-db",
                                                search_ips=("192.168.0.10",))["total"],1)
        self.assertEqual(self.store.search_events(limit=25,sort="src",order="asc")["total"],4)
        with self.assertRaises(ValueError):
            self.store.search_events(limit=999)
        with self.assertRaises(ValueError):
            self.store.search_events(limit=25,sort="id desc;drop table events")
        self.assertEqual(self.store.status()["total"],4)

    def test_paging_entire_collection_and_sorting(self):
        for i in range(37):
            e=sample()
            e.event_id=bytes([40+i])*16
            e.flow_fields.flow_id=bytes([50+i])*16
            e.flow_fields.dest_ip=ipaddress.ip_address("192.168.2."+str(i+1)).packed
            self.store.save(r.event_record(e,"peer-A"))
        first=self.store.search_events(page=0,limit=25)
        second=self.store.search_events(page=1,limit=25)
        self.assertEqual(first["total"],37)
        self.assertEqual(len(first["flows"]),25)
        self.assertEqual(len(second["flows"]),12)
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertFalse({x["id"] for x in first["flows"]} &
                         {x["id"] for x in second["flows"]})
        ascending=self.store.search_events(page=0,limit=25,sort="dst",order="asc")
        descending=self.store.search_events(page=0,limit=25,sort="dst",order="desc")
        self.assertNotEqual(ascending["flows"][0]["dst"],descending["flows"][0]["dst"])
        self.assertEqual(self.store.search_events(page=0,limit=25,
                         query="100%")["total"],0)

    def test_exact_flow_history_never_merges_other_flows(self):
        identity = "77" * 16
        for i in range(3):
            e = sample()
            e.event_id = bytes([65+i]) * 16
            e.flow_fields.flow_id = bytes.fromhex(identity if i<2 else "88"*16)
            e.timestamp.seconds = int(time.time()) - 60*(2-i)
            e.window_start.seconds = e.timestamp.seconds
            e.window_end.seconds = e.timestamp.seconds
            self.store.save(r.event_record(e, "peer-A" if i!=1 else "peer-B"))
        filtered=self.store.search_events(flow_id=identity, reporters=("peer-A",),
                                          limit=25, sort="time", order="asc")
        self.assertEqual(filtered["total"],1)
        self.assertEqual(filtered["flows"][0]["reporter_id"],"peer-A")
        self.assertEqual(filtered["flows"][0]["flow_id"],identity)
        self.assertEqual(self.store.search_events(flow_id=identity,limit=25)["total"],2)
        with self.assertRaises(ValueError):
            self.store.search_events(flow_id="aa'* OR 1=1 --",limit=25)
        with self.assertRaises(ValueError):
            self.store.search_events(flow_id="ff"*16+"aa",limit=25)

    def test_http_full_history_query_and_user_filter(self):
        event=sample()
        self.store.save(r.event_record(event,"peer-A"))
        server=r.make_http_server(self.store,"test-"+"x"*40)
        worker=threading.Thread(target=server.serve_forever,daemon=True)
        worker.start()
        url="http://127.0.0.1:"+str(server.server_port)
        headers={"Authorization":"Bearer test-"+"x"*40}
        try:
            req=Request(url+"/api/native/query?limit=25&reporters=peer-A&sort=time",headers=headers)
            with urlopen(req,timeout=5) as response:
                obj=json.load(response)
            self.assertEqual(obj["total"],1)
            # Regression: older dashboard sent empty before=, previously
            # HTTP 400 was misreported as an offline event receiver.
            blank=Request(url+"/api/native/query?before=&limit=25&start=0&end=0&q=&protocol=0",
                          headers=headers)
            with urlopen(blank,timeout=5) as response:
                blank_page=json.load(response)
            self.assertEqual(blank_page["total"],1)
            self.assertEqual(len(blank_page["flows"]),1)
            self.assertFalse(obj["has_more"])
            self.assertEqual(len(obj["flows"]),1)
            with self.assertRaises(HTTPError) as fail:
                urlopen(Request(url+"/api/native/query?limit=999",headers=headers),timeout=5)
            self.assertEqual(fail.exception.code,400)
            with self.assertRaises(HTTPError) as fail:
                urlopen(url+"/api/native/query?limit=25",timeout=5)
            self.assertEqual(fail.exception.code,401)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_authenticated_api_and_pagination(self):
        self.store.save(r.event_record(sample(), "peer-A"))
        http = r.make_http_server(self.store, "api-token-" + "a" * 40)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        base = "http://127.0.0.1:" + str(http.server_port)
        try:
            with self.assertRaises(HTTPError) as err:
                urlopen(base + "/api/native/flows")
            self.assertEqual(err.exception.code, 401)
            headers = {"Authorization": "Bearer api-token-" + "a" * 40}
            with urlopen(Request(base + "/api/native/flows?limit=1", headers=headers)) as res:
                data = json.load(res)
            self.assertEqual(len(data["flows"]), 1)
            with urlopen(Request(base + "/api/native/flows?after=" + str(data["next_cursor"]), headers=headers)) as res:
                self.assertEqual(json.load(res)["flows"], [])
            with urlopen(Request(base + "/api/native/export.ndjson", headers=headers)) as res:
                self.assertEqual(json.loads(res.read())["reporter_id"], "peer-A")
        finally:
            http.shutdown()
            http.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
