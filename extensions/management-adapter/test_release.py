import io
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import release
import rollout


class ReleaseTests(unittest.TestCase):
    def test_official_revision_and_version_are_required(self):
        info = 'build -ldflags="-X github.com/netbirdio/netbird/version.version=0.81.3"\n'
        info += 'build vcs.revision=' + 'a' * 40 + '\n'
        self.assertEqual(release.source_revision(info, '0.81.3'), 'a' * 40)
        for changed in [info.replace('0.81.3', '0.81.2'), info + 'build vcs.modified=true',
                        info.replace('vcs.revision=', 'unknown=')]:
            with self.assertRaises(ValueError):
                release.source_revision(changed, '0.81.3')

    def test_toolchain_is_explicit_and_runtime_compatible(self):
        self.assertEqual(release.toolchain('go 1.26.0\ntoolchain go1.26.7\n'),
                         'golang:1.26.7-bookworm')
        with self.assertRaises(ValueError):
            release.toolchain('toolchain arbitrary-image\n')

    def test_archive_cannot_escape_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'source.tar'
            with tarfile.open(archive, 'w') as tar:
                item = tarfile.TarInfo('../outside')
                item.size = 3
                tar.addfile(item, io.BytesIO(b'bad'))
            with self.assertRaises(tarfile.FilterError):
                release.extract(archive, root / 'source')
            self.assertFalse((root / 'outside').exists())

    def test_live_trial_copy_uses_sqlite_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / 'data'
            data.mkdir()
            with closing(sqlite3.connect(data / 'store.db')) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE sample(value INTEGER)')
                db.execute('INSERT INTO sample VALUES(42)')
                db.commit()
                rollout.copy_live_data(data, root / 'trial')
            with closing(sqlite3.connect(root / 'trial/store.db')) as db:
                self.assertEqual(db.execute('SELECT value FROM sample').fetchone(), (42,))

    def test_rollback_restores_data_and_preserves_failed_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live = root / '_data'
            live.mkdir()
            (live / 'store.db').write_text('failed new state')
            backup = root / 'backup'
            (backup / 'data').mkdir(parents=True)
            (backup / 'data/store.db').write_text('previous good state')
            state = {'data': str(live), 'container': 'test-only',
                     'override': str(root / 'docker-compose.override.yml'),
                     'old_override': None, 'old_image_id': 'sha256:old',
                     'compose_command': ['docker', 'compose'], 'health_url': 'http://example.invalid'}
            (backup / 'state.json').write_text(json.dumps(state))
            mock_container = {'Mounts': [{'Source': str(live), 'Destination': '/var/lib/netbird'}]}
            with patch.object(rollout, 'inspect', return_value=mock_container), \
                 patch.object(rollout, 'run') as commands, patch.object(rollout, 'wait_health'):
                rollout.rollback(backup)
            self.assertEqual((live / 'store.db').read_text(), 'previous good state')
            self.assertEqual(next(backup.glob('failed-data-*/store.db')).read_text(), 'failed new state')
            override = json.loads((root / 'docker-compose.override.yml').read_text())
            self.assertEqual(override['services']['netbird-server']['image'], 'sha256:old')
            self.assertEqual(commands.call_args_list[0].args, ('docker', 'stop', 'test-only'))

    def test_rollback_rejects_changed_volume_before_stopping(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state.json').write_text(json.dumps({'data': '/expected/_data', 'container': 'test'}))
            with patch.object(rollout, 'inspect', return_value={'Mounts': []}), \
                 patch.object(rollout, 'run') as commands:
                with self.assertRaises(RuntimeError):
                    rollout.rollback(root)
            commands.assert_not_called()


if __name__ == '__main__':
    unittest.main()
