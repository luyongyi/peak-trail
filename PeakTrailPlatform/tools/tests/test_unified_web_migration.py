"""Offline transactions; no production commands, credentials or network requests."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'deploy/migrate-unified-web.py'
if not SOURCE.exists():
    SOURCE = Path(__file__).with_name('migrate-unified-web.py')
spec = importlib.util.spec_from_file_location('unified_web_migration', SOURCE)
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)


@unittest.skipIf(os.name != 'posix', 'Production symlink and filesystem semantics require Linux')
class Migration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / 'package'
        self.package.mkdir()
        self.layout = m.Layout(state=self.root / 'state', receiver=self.root / 'installed/receiver.mjs',
                               nginx=self.root / 'nginx/available/site.conf', enabled=self.root / 'nginx/enabled/site.conf',
                               dropin=self.root / 'systemd/peak-trail-live.service.d/20-packet-navigation.conf',
                               backups=self.root / 'backups')
        self.site = self.layout.state / 'releases' / ('a' * 12 + '-ABC123') / 'PeakTrailPlatform/site-dist'
        self.site.mkdir(parents=True)
        self.layout.state.joinpath('current').symlink_to(self.site.relative_to(self.layout.state))
        for target in (self.layout.receiver, self.layout.nginx, self.layout.enabled):
            target.parent.mkdir(parents=True, exist_ok=True)
        self.layout.dropin.parent.parent.mkdir(parents=True)
        self.layout.enabled.symlink_to(self.layout.nginx)
        self.before = {'receiver.mjs': b'old receiver', 'nginx.conf': b'old nginx', 'live-service.conf': None}
        self.after = {'receiver.mjs': b'new receiver', 'nginx.conf': b'new nginx', 'live-service.conf': b'new dropin'}
        for name, target in self.layout.targets().items():
            if self.before[name] is not None:
                target.write_bytes(self.before[name])
            self.package.joinpath(name).write_bytes(self.after[name])
        self.site_files = {name: m.digest(name.encode()) for name in (
            'record.html', 'record.css', 'src/packet-recorder.js', 'src/packet-watch-client.js', 'src/app.js',
            'downloads/peak-packet-replay-windows.zip')}
        self.source_files = {name: m.digest(name.encode()) for name in ('server/live-server.mjs', 'server/packet-replay-api.mjs')}
        for base, files in ((self.site, self.site_files), (self.site.parent, self.source_files)):
            for name in files:
                target = base / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(name.encode())
        self.marker = self.site / m.MARKER
        self.marker.parent.mkdir(parents=True)
        self.marker.write_text(json.dumps({'schemaVersion': 1, 'navigationApiVersion': 1, 'releaseFiles': self.site_files}))
        self.manifest = {'schemaVersion': 1, 'files': {name: {'before': m.digest(value) if value else None,
                          'after': m.digest(self.after[name])} for name, value in self.before.items()},
                         'requiredSiteFiles': self.site_files, 'requiredSourceFiles': self.source_files}
        self.write_manifest()
        self.commands = []
        self.probes = 0

    def write_manifest(self):
        self.package.joinpath('migration.json').write_text(json.dumps(self.manifest))

    def runner(self, arguments):
        self.commands.append(arguments)

    def probe(self):
        self.probes += 1

    def apply(self, **kwargs):
        return m.apply(self.package, self.layout, runner=kwargs.get('runner', self.runner),
                       probe=kwargs.get('probe', self.probe), enforce_owner=False)

    def assert_before(self):
        for name, target in self.layout.targets().items():
            self.assertEqual(target.read_bytes() if target.exists() else None, self.before[name])
        self.assertFalse((self.layout.state / '.deploy-lock').exists())

    def test_readonly_preflight(self):
        result = m.plan(self.package, self.layout, enforce_owner=False)
        self.assertFalse(result[-1])
        self.assertEqual(result[-2], self.site)
        self.assert_before()
        self.assertFalse(self.layout.backups.exists())

    def test_success_and_idempotence(self):
        current = os.readlink(self.layout.state / 'current')
        result = self.apply()
        self.assertEqual(result['changedFiles'], 3)
        self.assertFalse(result['collectorRestarted'])
        self.assertFalse(result['authenticationPerformed'])
        for name, target in self.layout.targets().items():
            self.assertEqual(target.read_bytes(), self.after[name])
        self.assertEqual(os.readlink(self.layout.state / 'current'), current)
        self.assertTrue(Path(result['backup'], 'receipt.json').exists())
        self.assertEqual(self.apply()['status'], 'already-applied')
        self.assertEqual(self.probes, 2)
        self.assertEqual([item for item in self.commands if 'restart' in item],
                         [['/usr/bin/systemctl', 'restart', 'peak-trail-live.service']])

    def test_existing_deployment_lock_is_retained(self):
        lock = self.layout.state / '.deploy-lock'
        lock.mkdir()
        with self.assertRaisesRegex(m.Refused, 'deployment is running'):
            self.apply()
        self.assertTrue(lock.exists())
        self.assertEqual(self.commands, [])

    def test_changed_payload_is_refused(self):
        self.package.joinpath('receiver.mjs').write_bytes(b'drift')
        with self.assertRaisesRegex(m.Refused, 'payload fingerprint'):
            self.apply()
        self.assert_before()

    def test_installed_drift_is_refused(self):
        self.layout.receiver.write_bytes(b'drift')
        with self.assertRaisesRegex(m.Refused, 'configuration changed'):
            self.apply()
        self.assertEqual(self.commands, [])

    def test_partial_previous_migration_is_refused(self):
        self.layout.receiver.write_bytes(self.after['receiver.mjs'])
        with self.assertRaisesRegex(m.Refused, 'partial migration'):
            self.apply()
        self.assertEqual(self.commands, [])

    def test_source_api_drift_is_refused(self):
        (self.site.parent / 'server/packet-replay-api.mjs').write_bytes(b'drift')
        with self.assertRaisesRegex(m.Refused, 'API source'):
            self.apply()
        self.assert_before()

    def test_pinned_download_can_share_public_asset_pool_inode(self):
        archive = self.site / 'downloads/peak-packet-replay-windows.zip'
        os.link(archive, self.root / 'public-pool-blob')
        self.assertEqual(self.apply()['status'], 'applied')

    def test_configuration_hardlink_is_refused(self):
        os.link(self.layout.receiver, self.root / 'receiver-linked')
        with self.assertRaisesRegex(m.Refused, 'Linked configuration'):
            self.apply()

    def test_public_file_drift_is_refused(self):
        (self.site / 'record.html').write_bytes(b'drift')
        with self.assertRaisesRegex(m.Refused, 'navigation file has changed'):
            self.apply()
        self.assert_before()

    def test_missing_readiness_marker_is_refused(self):
        self.marker.unlink()
        with self.assertRaises(FileNotFoundError):
            self.apply()
        self.assert_before()

    def test_marker_fingerprint_mismatch_is_refused(self):
        marker = json.loads(self.marker.read_text())
        marker['releaseFiles']['record.html'] = 'a' * 64
        self.marker.write_text(json.dumps(marker))
        with self.assertRaisesRegex(m.Refused, 'reviewed migration'):
            self.apply()
        self.assert_before()

    def test_unsafe_manifest_reference_is_refused(self):
        self.manifest['requiredSourceFiles']['../secret'] = 'a' * 64
        self.write_manifest()
        with self.assertRaisesRegex(m.Refused, 'Invalid release file'):
            self.apply()
        self.assert_before()

    def test_unexpected_file_set_is_refused(self):
        self.manifest['files']['evil'] = self.manifest['files']['receiver.mjs']
        self.write_manifest()
        with self.assertRaisesRegex(m.Refused, 'Unexpected migration'):
            self.apply()
        self.assert_before()

    def test_symlinked_candidate_is_refused(self):
        candidate = self.package / 'receiver.mjs'
        candidate.unlink()
        candidate.symlink_to(self.layout.receiver)
        with self.assertRaisesRegex(m.Refused, 'symbolic link'):
            self.apply()
        self.assert_before()

    def test_dangling_dropin_link_is_refused(self):
        self.layout.dropin.parent.mkdir()
        self.layout.dropin.symlink_to(self.root / 'missing')
        with self.assertRaisesRegex(m.Refused, 'symbolic link'):
            self.apply()
        self.assertTrue(self.layout.dropin.is_symlink())

    def test_external_current_is_refused(self):
        current = self.layout.state / 'current'
        current.unlink()
        current.symlink_to(self.root)
        with self.assertRaisesRegex(m.Refused, 'outside managed'):
            self.apply()
        self.assert_before()

    def test_traversing_current_is_refused(self):
        current = self.layout.state / 'current'
        current.unlink()
        current.symlink_to('releases/../releases/' + self.site.parts[-3] + '/PeakTrailPlatform/site-dist')
        with self.assertRaisesRegex(m.Refused, 'traversal'):
            self.apply()
        self.assert_before()

    def test_nginx_enabled_target_mismatch_is_refused(self):
        self.layout.enabled.unlink()
        self.layout.enabled.symlink_to(self.layout.receiver)
        with self.assertRaisesRegex(m.Refused, 'Nginx enabled site'):
            self.apply()
        self.assert_before()

    def test_service_failure_before_changes_preserves_files(self):
        def fail(arguments):
            raise m.Refused('inactive')
        with self.assertRaisesRegex(m.Refused, 'inactive'):
            self.apply(runner=fail)
        self.assert_before()
        self.assertFalse(self.layout.backups.exists())

    def test_each_activation_failure_rolls_back(self):
        for target in ('-t', 'daemon-reload', 'restart', 'reload'):
            with self.subTest(target=target):
                failed = False
                def fail_once(arguments):
                    nonlocal failed
                    self.runner(arguments)
                    if target in arguments and not failed:
                        failed = True
                        raise m.Refused('injected activation failure')
                with self.assertRaisesRegex(m.Refused, 'prior server configuration was restored'):
                    self.apply(runner=fail_once)
                self.assert_before()

    def test_unhealthy_api_never_switches_nginx_to_new_service(self):
        def fail():
            raise m.Refused('not ready')
        with self.assertRaisesRegex(m.Refused, 'prior server configuration was restored'):
            self.apply(probe=fail)
        self.assert_before()
        # Only the rollback reload runs, after old config has been restored.
        self.assertEqual(sum('reload' in item for item in self.commands), 1)

    def test_receipt_failure_rolls_back(self):
        real = m.atomic
        def injected(path, content):
            if Path(path).name == 'receipt.json':
                raise OSError('receipt disk full')
            return real(path, content)
        with patch.object(m, 'atomic', side_effect=injected):
            with self.assertRaisesRegex(m.Refused, 'prior server configuration was restored'):
                self.apply()
        self.assert_before()

    def test_rollback_failure_is_reported_separately(self):
        def fail(arguments):
            if '-t' in arguments:
                raise m.Refused('nginx unusable')
        with self.assertRaisesRegex(m.Refused, 'Migration and rollback failed'):
            self.apply(runner=fail)
        self.assert_before()

    def test_existing_dropin_directory_is_preserved_on_rollback(self):
        self.layout.dropin.parent.mkdir()
        other = self.layout.dropin.parent / '10-existing.conf'
        other.write_text('retained')
        with self.assertRaises(m.Refused):
            self.apply(probe=lambda: (_ for _ in ()).throw(m.Refused('unhealthy')))
        self.assertEqual(other.read_text(), 'retained')
        self.assert_before()


class StaticContract(unittest.TestCase):
    def test_receiver_keeps_production_policy_without_overlay(self):
        receiver = SOURCE.with_name('receiver.mjs')
        if not receiver.exists():
            self.skipTest('Repository source is checked in CI')
        text = receiver.read_text()
        self.assertIn('production-301-policy.py", "prepare", release', text)
        self.assertIn('production-301-policy.py", "staged", release', text)
        self.assertNotIn('site-overlay/apply.py', text)
        self.assertNotIn('PEAK_TRAIL_WINDOWS_REPLAY_ZIP', text)
        self.assertIn('publishReleaseAndMaintain', text)


if __name__ == '__main__':
    unittest.main()
