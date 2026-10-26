"""Cross-language wire test; no live peers, external network or production data."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import receiver

SECRET = b"0123456789abcdef0123456789abcdef"  # Public synthetic test secret only.

def main():
    binary, token_path = sys.argv[1:]
    token = json.loads(Path(token_path).read_text())["token"]
    assert receiver.authenticate("Bearer " + token, SECRET)[0] == "peer-A"
    with tempfile.TemporaryDirectory() as directory:
        store = receiver.Store(directory)
        server, port = receiver.make_grpc_server(SECRET, store)
        server.start()
        try:
            result = subprocess.run([binary, "http://127.0.0.1:" + str(port), token_path],
                                    capture_output=True, text=True, timeout=25)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            # Upstream logs stream cancellation while the successful probe exits.
            print(result.stdout, end="")
            rows = store.list_events()
            assert len(rows) == 1, "native retry must not duplicate stored records"
            row = rows[0]
            assert row["reporter_id"] == "peer-A"
            assert row["src"] == "100.64.1.2" and row["dst"] == "100.64.1.3"
            assert row["num_of_starts"] == 5 and row["num_of_ends"] == 4
            assert row["num_of_drops"] == 2
            assert row["rx_bytes"] + row["tx_bytes"] == 3000
            assert store.export_pending() == 1
            exported = json.loads(next(Path(directory).glob("native-*.jsonl")).read_text())
            assert exported["event_id"] == row["event_id"]
            print("Go adapter token -> official Go client -> Python receiver -> durable record and SIEM: PASS")
        finally:
            server.stop(0).wait()

if __name__ == "__main__":
    main()
