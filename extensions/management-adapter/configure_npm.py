"""Persist a single native-flow gRPC location in an authorized NPM host.

Uses the local NPM database and rendered config together, preserves all existing
directives, validates before reload, and keeps a private rollback snapshot.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import ipaddress
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess


def configure(domain, upstream, database='/data/database.sqlite', config_root='/data/nginx/proxy_host'):
    address, port = upstream.rsplit(':', 1)
    ipaddress.IPv4Address(address)
    if not 1 <= int(port) <= 65535:
        raise ValueError('invalid upstream port')
    block = ('# BEGIN ShiroBird native flow\n'
             'location ^~ /flow.FlowService/ {\n'
             '    grpc_pass grpc://' + address + ':' + str(int(port)) + ';\n'
             '    grpc_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
             '    grpc_read_timeout 1d;\n    grpc_send_timeout 1d;\n'
             '    grpc_socket_keepalive on;\n    client_max_body_size 64k;\n'
             '}\n# END ShiroBird native flow')
    with closing(sqlite3.connect(database, timeout=15)) as db:
        db.row_factory = sqlite3.Row
        rows = [r for r in db.execute('SELECT * FROM proxy_host WHERE is_deleted=0 AND enabled=1')
                if domain in json.loads(r['domain_names'])]
        if len(rows) != 1:
            raise ValueError('expected exactly one enabled proxy host for this domain')
        row = rows[0]
        if not row['http2_support'] or not row['certificate_id']:
            raise ValueError('the host requires existing TLS and HTTP/2')
        old = row['advanced_config'] or ''
        path = Path(config_root) / (str(row['id']) + '.conf')
        rendered = path.read_text()
        if block in old and block in rendered:
            print('Native-flow route already configured')
            return
        if '/flow.FlowService/' in old or '/flow.FlowService/' in rendered:
            raise ValueError('an existing flow route needs explicit reconciliation')
        if not old.strip() or rendered.count(old.strip()) != 1:
            raise ValueError('rendered host does not match stored advanced configuration')
        backup = Path(database).parent / 'shirobird-backups' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup.mkdir(parents=True, mode=0o700)
        backup.parent.chmod(0o700)
        with closing(sqlite3.connect(backup / 'database.sqlite')) as target:
            db.backup(target)
        shutil.copy2(path, backup / path.name)
        (backup / 'host.json').write_text(json.dumps(dict(row), indent=2))
        new = old.rstrip() + '\n\n' + block + '\n'
        candidate = rendered.replace(old.strip(), new.strip(), 1)
        file_touched = False
        committed = False
        try:
            db.execute('BEGIN IMMEDIATE')
            changed = db.execute('UPDATE proxy_host SET advanced_config=?, modified_on=? '
                                 'WHERE id=? AND advanced_config=?',
                                 (new, datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S'), row['id'], old))
            if changed.rowcount != 1:
                raise RuntimeError('proxy host changed concurrently')
            file_touched = True
            path.write_text(candidate)
            subprocess.run(['nginx', '-t'], check=True, capture_output=True)
            db.commit()
            committed = True
            subprocess.run(['nginx', '-s', 'reload'], check=True, capture_output=True)
        except Exception:
            db.rollback()
            if committed:
                with db:
                    db.execute('UPDATE proxy_host SET advanced_config=?, modified_on=? WHERE id=? AND advanced_config=?',
                               (old, row['modified_on'], row['id'], new))
            if file_touched:
                path.write_text(rendered)
                subprocess.run(['nginx', '-t'], check=True, capture_output=True)
                subprocess.run(['nginx', '-s', 'reload'], check=True, capture_output=True)
            raise
        print('Native-flow gRPC route installed for ' + domain + '; backup: ' + str(backup))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', required=True)
    parser.add_argument('--upstream', required=True)
    args = parser.parse_args()
    configure(args.domain, args.upstream)
