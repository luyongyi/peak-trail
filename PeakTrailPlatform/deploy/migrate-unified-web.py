#!/usr/bin/env python3
"""One-time migration to Git-managed navigation pages and API; never reads secrets."""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
import urllib.request


class Refused(Exception):
    pass


def digest(content):
    return hashlib.sha256(content).hexdigest()


@dataclass
class Layout:
    state: Path = Path('/srv/peak-trail/state')
    receiver: Path = Path('/srv/peak-trail/receiver.mjs')
    nginx: Path = Path('/etc/nginx/sites-available/peak.mylus.cn')
    enabled: Path = Path('/etc/nginx/sites-enabled/peak.mylus.cn')
    dropin: Path = Path('/etc/systemd/system/peak-trail-live.service.d/20-packet-navigation.conf')
    backups: Path = Path('/var/backups/peak-unified-web')

    def targets(self):
        return {'receiver.mjs': self.receiver, 'nginx.conf': self.nginx, 'live-service.conf': self.dropin}


FILES = frozenset(('receiver.mjs', 'nginx.conf', 'live-service.conf'))
SHA = re.compile(r'[a-f0-9]{64}\Z')
RELEASE = re.compile(r'[a-f0-9]{12}-[A-Za-z0-9]{6}\Z')
SERVICES = ('nginx', 'peak-trail-live.service', 'peak-packet-web.service', 'peak-packet-collector.service')
MARKER = 'deployment/unified-web.json'


def ordinary(path, *, directory=False, root_owned=False, allow_hardlink=False):
    path = Path(path)
    for ancestor in (*reversed(path.parents), path):
        if ancestor.is_symlink():
            raise Refused('A migration path contains a symbolic link.')
    info = path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise Refused('A migration path has an unexpected file type.')
    if root_owned and (info.st_uid != 0 or info.st_mode & 0o022):
        raise Refused('Installed configuration must be root-owned and not writable by others.')
    if not directory and not allow_hardlink and info.st_nlink != 1:
        raise Refused('Linked configuration files are not supported.')
    return info


def read(path, *, maximum=64 * 1024 * 1024, root_owned=False, allow_hardlink=False):
    info = ordinary(path, root_owned=root_owned, allow_hardlink=allow_hardlink)
    if info.st_size > maximum:
        raise Refused('A migration input is unexpectedly large.')
    return Path(path).read_bytes()


def present(path):
    return os.path.lexists(path)


def relative_file(name):
    if not isinstance(name, str) or not name or '\\' in name or name.startswith('/') or any(part in ('', '.', '..') for part in name.split('/')):
        raise Refused('Invalid release file reference.')
    return name


def command(arguments):
    result = subprocess.run(arguments, capture_output=True, timeout=45, check=False)
    if result.returncode:
        # Configuration diagnostics must not accidentally print environment values.
        raise Refused('System command failed: ' + Path(arguments[0]).name)


def health():
    with urllib.request.urlopen('http://127.0.0.1:8787/api/packet-replay/health', timeout=3) as response:
        value = json.loads(response.read(4096))
    if not (value.get('ok') is True and value.get('enabled') is True and value.get('configured') is True
            and value.get('service') == 'peak-packet-web' and value.get('version') == 1):
        raise Refused('The Git-managed navigation API is not ready.')


def wait_health(probe=health):
    for attempt in range(30):
        try:
            probe()
            return
        except Exception:
            if attempt == 29:
                raise Refused('The Git-managed navigation API did not become healthy.') from None
            time.sleep(0.5)


def current_site(layout):
    ordinary(layout.state, directory=True)
    ordinary(layout.state / 'releases', directory=True)
    current = layout.state / 'current'
    if not current.is_symlink():
        raise Refused('Current publication is not a deployment symlink.')
    raw = Path(os.readlink(current))
    if '..' in raw.parts:
        raise Refused('Current publication contains traversal.')
    target = Path(os.path.abspath(current.parent / raw))
    try:
        parts = target.relative_to(layout.state / 'releases').parts
    except ValueError:
        raise Refused('Current publication is outside managed releases.') from None
    if len(parts) != 3 or not RELEASE.fullmatch(parts[0]) or parts[1:] != ('PeakTrailPlatform', 'site-dist'):
        raise Refused('Current publication has an unexpected layout.')
    ordinary(target, directory=True)
    return target


def verify_ready(layout, manifest):
    site = current_site(layout)
    marker = json.loads(read(site / MARKER, maximum=65536))
    if marker.get('schemaVersion') != 1 or marker.get('navigationApiVersion') != 1 or not isinstance(marker.get('releaseFiles'), dict):
        raise Refused('Publish the unified website before migrating the server.')
    required = manifest['requiredSiteFiles']
    if marker['releaseFiles'] != required:
        raise Refused('Published navigation files do not match the reviewed migration.')
    for name, expected in required.items():
        if digest(read(site / name, allow_hardlink=name == 'downloads/peak-packet-replay-windows.zip')) != expected:
            raise Refused('A published navigation file has changed.')
    for name, expected in manifest['requiredSourceFiles'].items():
        if digest(read(site.parent / name)) != expected:
            raise Refused('The published navigation API source has changed.')
    return site


def load_package(package):
    package = Path(package).absolute()
    ordinary(package, directory=True)
    manifest = json.loads(read(package / 'migration.json', maximum=65536))
    if set(manifest) != {'schemaVersion', 'files', 'requiredSiteFiles', 'requiredSourceFiles'} or manifest['schemaVersion'] != 1 or set(manifest['files']) != FILES:
        raise Refused('Unexpected migration manifest.')
    for group in ('requiredSiteFiles', 'requiredSourceFiles'):
        if not isinstance(manifest[group], dict) or not manifest[group] or len(manifest[group]) > 32:
            raise Refused('Migration readiness files are missing.')
        for name, value in manifest[group].items():
            relative_file(name)
            if not SHA.fullmatch(str(value)):
                raise Refused('Invalid readiness fingerprint.')
    if set(manifest['requiredSiteFiles']) != {'record.html', 'record.css', 'src/packet-recorder.js', 'src/packet-watch-client.js', 'src/app.js', 'downloads/peak-packet-replay-windows.zip'}:
        raise Refused('Unexpected navigation readiness file set.')
    if set(manifest['requiredSourceFiles']) != {'server/live-server.mjs', 'server/packet-replay-api.mjs'}:
        raise Refused('Unexpected navigation API readiness file set.')
    payload = {}
    for name, entry in manifest['files'].items():
        if set(entry) != {'before', 'after'} or not SHA.fullmatch(str(entry['after'])) or entry['before'] is not None and not SHA.fullmatch(str(entry['before'])):
            raise Refused('Invalid configuration fingerprint.')
        content = read(package / name, maximum=1024 * 1024)
        if digest(content) != entry['after']:
            raise Refused('Migration payload fingerprint mismatch.')
        payload[name] = content
    return manifest, payload


def plan(package, layout=Layout(), *, enforce_owner=True):
    manifest, payload = load_package(package)
    ordinary(layout.enabled.parent, directory=True, root_owned=enforce_owner)
    if not layout.enabled.is_symlink() or layout.enabled.resolve() != layout.nginx:
        raise Refused('Nginx enabled site does not reference the reviewed configuration.')
    site = verify_ready(layout, manifest)
    originals = {}
    states = []
    for name, target in layout.targets().items():
        content = read(target, maximum=1024 * 1024, root_owned=enforce_owner) if present(target) else None
        actual = digest(content) if content is not None else None
        entry = manifest['files'][name]
        if actual not in (entry['before'], entry['after']):
            raise Refused('Installed configuration changed; migration needs review.')
        originals[name] = content
        states.append(actual == entry['after'])
    if any(states) and not all(states):
        raise Refused('A partial migration needs review before retrying.')
    return manifest, payload, originals, site, all(states)


def atomic(path, content):
    path = Path(path)
    ordinary(path.parent, directory=True)
    if present(path):
        ordinary(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, 'wb') as stream:
            fd = None
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if fd is not None:
            os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def deployment_lock(layout):
    ordinary(layout.state, directory=True)
    lock = layout.state / '.deploy-lock'
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        raise Refused('A deployment is running; retry after it finishes.') from None
    try:
        yield
    finally:
        lock.rmdir()


def apply(package, layout=Layout(), *, runner=command, probe=health, enforce_owner=True):
    if enforce_owner and (os.name != 'posix' or os.geteuid() != 0):
        raise Refused('This one-time configuration migration requires owner sudo on Linux.')
    with deployment_lock(layout):
        manifest, payload, originals, site, installed = plan(package, layout, enforce_owner=enforce_owner)
        for service in SERVICES:
            runner(['/usr/bin/systemctl', 'is-active', '--quiet', service])
        if installed:
            probe()
            return {'status': 'already-applied', 'changedFiles': 0, 'currentSiteChanged': False}
        ordinary(layout.receiver.parent, directory=True, root_owned=enforce_owner)
        ordinary(layout.nginx.parent, directory=True, root_owned=enforce_owner)
        created_dropin = not present(layout.dropin.parent)
        if created_dropin:
            ordinary(layout.dropin.parent.parent, directory=True, root_owned=enforce_owner)
        else:
            ordinary(layout.dropin.parent, directory=True, root_owned=enforce_owner)
        layout.backups.mkdir(parents=True, exist_ok=True, mode=0o700)
        ordinary(layout.backups, directory=True, root_owned=enforce_owner)
        backup = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-'), dir=layout.backups))
        for name, content in originals.items():
            if content is not None:
                atomic(backup / name, content)
        atomic(backup / 'migration.json', read(Path(package) / 'migration.json'))
        changed = []
        try:
            if created_dropin:
                layout.dropin.parent.mkdir(mode=0o755)
            for name, target in layout.targets().items():
                # Recheck the exact baseline immediately before each replacement.
                actual = read(target) if present(target) else None
                if actual != originals[name]:
                    raise Refused('Installed configuration changed during migration.')
                atomic(target, payload[name])
                changed.append(name)
            runner(['/usr/sbin/nginx', '-t'])
            runner(['/usr/bin/systemctl', 'daemon-reload'])
            runner(['/usr/bin/systemctl', 'restart', 'peak-trail-live.service'])
            probe()
            # Only switch public API traffic once the new implementation is healthy.
            runner(['/usr/bin/systemctl', 'reload', 'nginx'])
            for service in SERVICES:
                runner(['/usr/bin/systemctl', 'is-active', '--quiet', service])
            if current_site(layout) != site:
                raise Refused('Current publication changed during migration.')
            plan(package, layout, enforce_owner=enforce_owner)
            result = {'status': 'applied', 'changedFiles': len(changed), 'backup': str(backup),
                      'currentSiteChanged': False, 'collectorRestarted': False, 'authenticationPerformed': False,
                      'completedAtUtc': datetime.now(timezone.utc).isoformat()}
            atomic(backup / 'receipt.json', (json.dumps(result) + '\n').encode())
            return result
        except BaseException as failure:
            try:
                for name in reversed(changed):
                    target = layout.targets()[name]
                    if read(target) != payload[name]:
                        raise Refused('Configuration changed during rollback; refusing to overwrite it.')
                    if originals[name] is None:
                        ordinary(target)
                        target.unlink()
                    else:
                        atomic(target, originals[name])
                if created_dropin and layout.dropin.parent.exists():
                    layout.dropin.parent.rmdir()
                runner(['/usr/sbin/nginx', '-t'])
                runner(['/usr/bin/systemctl', 'daemon-reload'])
                runner(['/usr/bin/systemctl', 'restart', 'peak-trail-live.service'])
                runner(['/usr/bin/systemctl', 'reload', 'nginx'])
                for service in SERVICES:
                    runner(['/usr/bin/systemctl', 'is-active', '--quiet', service])
            except BaseException:
                raise Refused('Migration and rollback failed; inspect the backup at ' + str(backup)) from None
            raise Refused('Migration failed; prior server configuration was restored. Backup: ' + str(backup)) from failure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('preflight', 'apply'))
    parser.add_argument('--package', type=Path, default=Path(__file__).absolute().parent)
    args = parser.parse_args()
    try:
        if args.operation == 'preflight':
            *_, site, installed = plan(args.package)
            result = {'status': 'already-applied' if installed else 'ready', 'site': str(site), 'filesChanged': False}
        else:
            result = apply(args.package, probe=lambda: wait_health())
        print(json.dumps(result))
    except (Refused, OSError, ValueError, KeyError, TypeError) as error:
        print('Migration not completed: ' + str(error))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
