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

    def test_event_query_filters_and_stable_pages(self):
        for i in range(5):
            record = r.event_record(sample(), "peer-A" if i % 2 else "peer-B")
            record.update(event_id=str(i), ts=100 + i, protocol=6 if i % 2 else 17,
                          num_of_drops=1 if i == 3 else 0)
            self.store.save(record)
        page = self.store.query_events({"limit": ["2"]})
        self.assertEqual([e["ts"] for e in page["flows"]], [104, 103])
        record.update(event_id="new", ts=200)
        self.store.save(record)
        next_page = self.store.query_events({"limit": ["2"], "offset": ["2"], "snapshot": [str(page["snapshot"])]})
        self.assertEqual(next_page["total"], 5)
        self.assertEqual([e["ts"] for e in next_page["flows"]], [102, 101])
        filtered = self.store.query_events({"protocol": ["6"], "event": ["drop"], "start": ["100"], "end": ["104"]})
        self.assertEqual([e["ts"] for e in filtered["flows"]], [103])
        self.assertEqual(self.store.query_events({"q": ["50000"]})["total"], 6)
        self.assertEqual(self.store.query_events({"q": ["%'"]})["total"], 0)
        self.assertEqual(self.store.query_events({"q": ["Alice"], "match": ["100.64.1.2"]})["total"], 6)

    def test_event_query_classification_and_validation(self):
        self.store.save(r.event_record(sample(), "peer-A"))
        self.assertEqual(self.store.query_events({"kind": ["p2p"]})["total"], 0)
        self.assertEqual(self.store.query_events({"kind": ["p2p"], "peer_ip": ["100.64.1.2", "100.64.1.3"]})["total"], 1)
        self.assertEqual(self.store.query_events({"kind": ["routed"]})["total"], 0)
        for query in ({"limit": ["201"]}, {"offset": ["-1"]}, {"sort": ["payload; DROP TABLE events"]},
                      {"order": ["arbitrary"]}, {"event": ["allowed"]}, {"start": ["200"], "end": ["100"]}):
            with self.assertRaises(ValueError):
                self.store.query_events(query)

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
