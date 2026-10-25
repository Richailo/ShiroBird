"""Exercise two official NetBird daemons over direct P2P in an isolated Docker lab.

All database changes affect a new private COPY. No production enrollment, routing,
policies or clients are modified. Temporary containers and network are removed.
"""
import argparse
import base64
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import time
import uuid

from release import run
from rollout import copy_live_data, inspect


def verify(release_dir):
    manifest = json.loads((Path(release_dir) / 'manifest.json').read_text())
    suffix = uuid.uuid4().hex[:8]
    prefix = 'shirobird-lab-' + suffix
    root = Path('/opt/shirobird/work') / prefix
    root.mkdir(mode=0o700)
    network = prefix
    names = []
    management, receiver, gateway = [prefix + '-' + s for s in ['management', 'receiver', 'flow']]
    clients = [prefix + '-a', prefix + '-b']
    current = inspect('netbird-server')
    source = Path(next(m['Source'] for m in current['Mounts'] if m['Destination'] == '/var/lib/netbird'))
    original_config = Path(next(m['Source'] for m in current['Mounts'] if m['Destination'] == '/etc/netbird/config.yaml'))
    copy_live_data(source, root / 'management-data')
    with closing(sqlite3.connect(root / 'management-data/store.db')) as db, db:
        account, group = db.execute("SELECT account_id,id FROM groups WHERE name='All'").fetchone()
        # Disconnected fixture only. Remove copied peer identities and routes.
        db.execute('DELETE FROM group_peers')
        db.execute('DELETE FROM peers')
        db.execute('DELETE FROM setup_keys')
        db.execute('UPDATE policies SET enabled=0')
        default = db.execute("SELECT id FROM policies WHERE name='Default'").fetchone()[0]
        db.execute('UPDATE policies SET enabled=1 WHERE id=?', (default,))
        db.execute('UPDATE policy_rules SET enabled=1 WHERE policy_id=?', (default,))
        plain_key = str(uuid.uuid4()).upper()
        hashed = base64.b64encode(hashlib.sha256(plain_key.encode()).digest()).decode()
        now = datetime.now(timezone.utc)
        stamp = lambda t: t.strftime('%Y-%m-%d %H:%M:%S+00:00')
        db.execute('INSERT INTO setup_keys '
                   '(id,account_id,key,key_secret,name,type,created_at,expires_at,updated_at,'
                   'revoked,used_times,auto_groups,usage_limit,ephemeral,allow_extra_dns_labels) '
                   'VALUES(?,?,?,?,?,?,?,?,?,0,0,?,2,1,0)',
                   (uuid.uuid4().hex[:20], account, hashed, plain_key[:5] + '****',
                    'ShiroBird isolated P2P validation', 'reusable', stamp(now),
                    stamp(now + timedelta(minutes=30)), stamp(now), '[]'))
    text, count = re.subn(r'(?m)^(\s*exposedAddress:)\s*.*$',
                         lambda m: m[1] + ' "http://' + management + ':80"', original_config.read_text())
    if count != 1:
        raise ValueError('unexpected combined configuration layout')
    (root / 'management.yaml').write_text(text)
    (root / 'flow.json').write_text(json.dumps({'enabled': True, 'receiver_url': 'https://' + gateway + ':8443',
        'secret_file': '/secrets/flow', 'peer_ids': [], 'group_ids': [group], 'interval_seconds': 10, 'counters': True}))
    secret_dir = root / 'secrets'
    secret_dir.mkdir(mode=0o755)
    for name in ['flow', 'api']:
        (secret_dir / name).write_text(secrets.token_urlsafe(48))
        (secret_dir / name).chmod(0o444)
    (root / 'client.env').write_text('NB_SETUP_KEY=' + plain_key + '\nNB_MANAGEMENT_URL=http://' + management + ':80\n'
        'SSL_CERT_FILE=/lab-ca.pem\n')
    (root / 'client.env').chmod(0o600)
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', root / 'key.pem', '-out', root / 'cert.pem', '-subj', '/CN=' + gateway,
        '-addext', 'subjectAltName=DNS:' + gateway, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (root / 'cert.pem').chmod(0o644)
    (root / 'nginx.conf').write_text('events {}\nhttp { server { listen 8443 ssl; http2 on;\n'
        'ssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem;\n'
        'location /flow.FlowService/ { grpc_pass grpc://' + receiver + ':8084; grpc_read_timeout 1d; }\n}}\n')
    client_image = 'netbirdio/netbird:' + manifest['version']
    run('docker', 'pull', client_image, capture=True)
    run('docker', 'network', 'create', '--internal', network, capture=True)

    def start(name, image, *options):
        run('docker', 'run', '-d', '--name', name, '--network', network, *options, image, capture=True)
        names.append(name)

    def status(name):
        return json.loads(run('docker', 'exec', name, 'netbird', 'status', '--json', capture=True))

    try:
        start(receiver, manifest['receiver_image'], '--memory', '256m',
              '-v', str(secret_dir) + ':/secrets:ro',
              '-e', 'SHIROBIRD_FLOW_SECRET_FILE=/secrets/flow', '-e', 'SHIROBIRD_NATIVE_API_TOKEN_FILE=/secrets/api')
        start(gateway, 'nginx:stable-alpine', '-v', str(root / 'nginx.conf') + ':/etc/nginx/nginx.conf:ro',
              '-v', str(root / 'cert.pem') + ':/tls/cert.pem:ro', '-v', str(root / 'key.pem') + ':/tls/key.pem:ro')
        start(management, manifest['image'], '--memory', '1g',
              '-v', str(root / 'management-data') + ':/var/lib/netbird',
              '-v', str(root / 'management.yaml') + ':/etc/netbird/config.yaml:ro',
              '-v', str(root / 'flow.json') + ':/etc/shirobird-flow.json:ro',
              '-v', str(secret_dir) + ':/secrets:ro', '-e', 'SHIROBIRD_FLOW_CONFIG_FILE=/etc/shirobird-flow.json')
        flow_ip = inspect(gateway)['NetworkSettings']['Networks'][network]['IPAddress']
        management_ip = inspect(management)['NetworkSettings']['Networks'][network]['IPAddress']
        for name in clients:
            start(name, client_image, '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW',
                  '--sysctl', 'net.netfilter.nf_conntrack_acct=1',
                  '--device', '/dev/net/tun', '--env-file', str(root / 'client.env'),
                  '-e', 'NB_HOSTNAME=' + name, '-v', str(root / 'cert.pem') + ':/lab-ca.pem:ro',
                  '--add-host', gateway + ':' + flow_ip, '--add-host', management + ':' + management_ip)
        print('Waiting for two official clients to enroll in the isolated management copy', flush=True)
        snapshots = None
        for _ in range(60):
            try:
                snapshots = [status(name) for name in clients]
                if all(s.get('management', {}).get('connected') and s.get('netbirdIp') for s in snapshots):
                    break
            except (subprocess.CalledProcessError, json.JSONDecodeError):
                pass
            time.sleep(2)
        else:
            raise RuntimeError('isolated clients did not enroll')
        ip_a, ip_b = [s['netbirdIp'].split('/')[0] for s in snapshots]
        # Trigger lazy connection, then wait for ICE to replace the initial relay.
        run('docker', 'exec', clients[0], 'ping', '-c', '1', '-W', '3', ip_b, capture=True)
        for _ in range(30):
            snapshots = [status(name) for name in clients]
            details = [d for s in snapshots for d in s.get('peers', {}).get('details', [])]
            if len(details) == 2 and all(d.get('status') == 'Connected' and
                                        d.get('connectionType') == 'P2P' for d in details):
                break
            time.sleep(1)
        else:
            (root / 'peer-status.json').write_text(json.dumps(snapshots, indent=2))
            raise RuntimeError('direct P2P was not established before the HTTP test')
        http = prefix + '-http'
        run('docker', 'run', '-d', '--name', http, '--network', 'container:' + clients[1],
            manifest['receiver_image'], 'python', '-m', 'http.server', '18080', '--bind', '0.0.0.0', capture=True)
        names.append(http)
        request = "import urllib.request,time\nfor _ in range(20):\n try:\n  assert urllib.request.urlopen('http://" + ip_b + ":18080',timeout=3).status==200\n  print('P2P HTTP request succeeded');break\n except OSError:time.sleep(1)\nelse:raise RuntimeError('P2P HTTP failed')"
        run('docker', 'run', '--rm', '--network', 'container:' + clients[0], manifest['receiver_image'],
            'python', '-c', request)
        snapshots = [status(name) for name in clients]
        (root / 'peer-status.json').write_text(json.dumps(snapshots, indent=2))
        print('Waiting for native flow aggregation and acknowledgements', flush=True)
        query = "import receiver,json;print(json.dumps(receiver.Store('/data').list_events(limit=1000)))"
        matches = []
        for _ in range(30):
            rows = json.loads(run('docker', 'exec', receiver, 'python', '-c', query, capture=True))
            matches = [r for r in rows if {r['src'], r['dst']} == {ip_a, ip_b} and
                       (r['dport'] == 18080 or r['sport'] == 18080)]
            if matches:
                break
            time.sleep(2)
        if not matches:
            raise RuntimeError('real P2P traffic was not reported by native clients')
        details = [d for s in snapshots for d in s.get('peers', {}).get('details', [])]
        direct = [d for d in details if d.get('status') == 'Connected' and
                  (d.get('connectionType') == 'P2P' or d.get('direct') is True)]
        result = {'http_success': True, 'native_records': len(matches),
                  'reporters': sorted({r['reporter_id'] for r in matches}),
                  'matched_records': matches, 'connection_details': details,
                  'direct_status_confirmed': bool(direct), 'network': 'isolated internal Docker network'}
        (root / 'result.json').write_text(json.dumps(result, indent=2))
        print('Native records from real clients: ' + str(len(matches)) + '; evidence: ' + str(root), flush=True)
        if not direct:
            raise RuntimeError('traffic succeeded but direct P2P status needs inspection')
        return result
    finally:
        for name in reversed(names):
            logs = run('docker', 'logs', '--tail', '200', name, capture=True, stderr=subprocess.STDOUT)
            (root / (name + '.log')).write_text(logs)
            run('docker', 'rm', '-f', name, capture=True)
        run('docker', 'network', 'rm', network, capture=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    verify(parser.parse_args().release)
