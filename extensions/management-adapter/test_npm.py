from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import configure_npm


class NpmTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / 'database.sqlite'
        self.old = 'client_body_timeout 1d;'
        self.config = self.root / '15.conf'
        self.config.write_text('server {\n' + self.old + '\n}\n')
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('CREATE TABLE proxy_host (id INTEGER, domain_names TEXT, is_deleted INTEGER, '
                       'enabled INTEGER, http2_support INTEGER, certificate_id INTEGER, '
                       'advanced_config TEXT, modified_on TEXT)')
            db.execute('INSERT INTO proxy_host VALUES (15,?,0,1,1,18,?,?)',
                       (json.dumps(['flow.example']), self.old, 'previous'))

    def stored(self):
        with closing(sqlite3.connect(self.db)) as db:
            return db.execute('SELECT advanced_config FROM proxy_host').fetchone()[0]

    def test_route_is_persistent_and_idempotent(self):
        with patch.object(configure_npm.subprocess, 'run') as command:
            for _ in range(2):
                configure_npm.configure('flow.example', '192.168.0.201:8084', self.db, self.root)
        self.assertEqual(self.stored().count('location ^~ /flow.FlowService/'), 1)
        self.assertIn(self.old, self.config.read_text())
        self.assertEqual(command.call_count, 2)

    def test_failed_nginx_validation_restores_database_and_file(self):
        original = self.config.read_text()
        failure = subprocess.CalledProcessError(1, ['nginx', '-t'])
        with patch.object(configure_npm.subprocess, 'run', side_effect=[failure, None, None]):
            with self.assertRaises(subprocess.CalledProcessError):
                configure_npm.configure('flow.example', '192.168.0.201:8084', self.db, self.root)
        self.assertEqual(self.stored(), self.old)
        self.assertEqual(self.config.read_text(), original)

    def test_wrong_host_does_not_change_configuration(self):
        with patch.object(configure_npm.subprocess, 'run') as command:
            with self.assertRaises(ValueError):
                configure_npm.configure('unrelated.example', '192.168.0.201:8084', self.db, self.root)
        command.assert_not_called()
        self.assertEqual(self.stored(), self.old)


if __name__ == '__main__':
    unittest.main()
