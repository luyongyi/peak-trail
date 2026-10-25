import copy
from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import struct
import time
from types import SimpleNamespace
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from verify_map_build_equivalence import (
    authenticate_bundle, authenticate_file, dependency_name, parse_scene_order,
    authenticate_builtin_extra, authenticate_bundles, inspect_dependencies, safe_child, source_entries, verify_manifest_assets, verify_unityfs_contents,
)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def bundle_job_fixture(game, cache, bundle, default, builtin):
    # A top-level callable is picklable in Windows spawn workers. Deliberately
    # complete later inputs sooner to exercise result ordering, not scheduling.
    if bundle.get('fail'):
        raise ValueError('simulated bundle authentication failure')
    time.sleep(bundle.get('delay', 0))
    return {'file': bundle['file']}, {'scene': bundle['file']}


def order_fixture():
    paths = [f'Assets/8_SCENES/Generated/Level_{index}.unity' for index in range(2)]
    raw = struct.pack('<i', len(paths))
    for path in paths:
        value = path.encode()
        raw += struct.pack('<i', len(value)) + value
        raw += b'\0' * (-len(raw) % 4)
    return raw, {'firstArrayOffsetBytes': 0, 'count': 2, 'objectSha256': digest(raw)}, paths


def catalog_fixture():
    maps = [{'sceneName': f'Level_{slot}', 'mapSlot': slot, 'scenePath': f'Assets/8_SCENES/Generated/Level_{slot}.unity',
             'mapPackId': 'sha256-' + str(slot + 1) * 64, 'sceneSha256': str(slot + 2) * 64} for slot in range(2)]
    entries = [{**item, 'gameBuildId': '123', 'path': f"./packs/{item['mapPackId']}/map-pack.json"} for item in maps]
    return {'schemaVersion': 1, 'mapPacks': entries}, {'schemaVersion': 1, 'authority': 'installed-game-assets-and-serialized-map-baker',
            'gameBuildId': '123', 'sceneCount': 2, 'maps': maps}


class BuildEquivalenceTests(unittest.TestCase):
    def test_serial_and_process_jobs_preserve_bundle_order(self):
        bundles = [{'file': 'first', 'delay': .1}, {'file': 'second'}, {'file': 'third'}]
        for jobs in (1, 3):
            with self.subTest(jobs=jobs):
                results = list(authenticate_bundles(None, None, bundles, None, None, jobs,
                                                    worker=bundle_job_fixture))
                self.assertEqual([row[0]['file'] for row in results], ['first', 'second', 'third'])
                self.assertEqual([row[1]['scene'] for row in results], ['first', 'second', 'third'])

    def test_serial_and_process_jobs_propagate_authentication_errors(self):
        bundles = [{'file': 'good'}, {'file': 'bad', 'fail': True}, {'file': 'later'}]
        for jobs in (1, 3):
            with self.subTest(jobs=jobs), self.assertRaisesRegex(ValueError, 'bundle authentication failure'):
                list(authenticate_bundles(None, None, bundles, None, None, jobs, worker=bundle_job_fixture))
        for jobs in (0, 4):
            with self.subTest(jobs=jobs), self.assertRaisesRegex(ValueError, 'jobs must be'):
                list(authenticate_bundles(None, None, [], None, None, jobs, worker=bundle_job_fixture))

    def test_scene_order_requires_native_bytes_and_exact_order(self):
        raw, order, paths = order_fixture()
        self.assertEqual(parse_scene_order(raw, order, paths), paths)
        with self.assertRaisesRegex(ValueError, 'MapBaker object changed'):
            parse_scene_order(raw + b'changed', order, paths)
        with self.assertRaisesRegex(ValueError, 'order changed'):
            parse_scene_order(raw, order, paths[::-1])

    def test_scene_order_rejects_truncated_strings(self):
        raw, order, paths = order_fixture()
        raw = raw[:12]
        order['objectSha256'] = digest(raw)
        with self.assertRaisesRegex(ValueError, 'Invalid ScenePaths string'):
            parse_scene_order(raw, order, paths)

    def test_catalog_requires_complete_unique_scene_to_pack_binding(self):
        catalog, evidence = catalog_fixture()
        entries, _ = source_entries(catalog, evidence)
        self.assertEqual(len(entries), 2)
        for mutation in ('missing', 'duplicate', 'disabled', 'different-pack'):
            changed = copy.deepcopy(catalog)
            if mutation == 'missing':
                changed['mapPacks'].pop()
            elif mutation == 'duplicate':
                changed['mapPacks'].append(changed['mapPacks'][0])
            elif mutation == 'disabled':
                changed['mapPacks'][0]['enabled'] = False
            else:
                changed['mapPacks'][0]['mapPackId'] = 'sha256-' + 'f' * 64
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                source_entries(changed, evidence)

    def test_dependencies_must_close_inside_authenticated_bundle(self):
        names = {'scene.sharedAssets', 'stream.resS'}
        self.assertEqual(dependency_name('archive:/scene/scene.sharedAssets', names), 'scene.sharedAssets')
        self.assertEqual(dependency_name('stream.resS', names), 'stream.resS')
        self.assertEqual(dependency_name('Library/unity default resources', names), 'unity default resources')
        for reference in ('resources.assets', '../stream.resS', 'archive:/scene/../stream.resS',
                          'C:/game/stream.resS', 'Library/other resources', r'archive:\scene\stream.resS'):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                dependency_name(reference, names)

    def test_mesh_texture_streams_are_checked_beyond_external_table(self):
        stream = SimpleNamespace(size=32, path='archive:/scene/texture.resS')
        texture = SimpleNamespace(type=SimpleNamespace(name='Texture2D'),
                                  read=lambda **kwargs: SimpleNamespace(m_StreamData=stream))
        native = SimpleNamespace(externals=[SimpleNamespace(path='Library/unity default resources')],
                                 objects={1: texture})
        names = {'texture.resS'}
        with patch('verify_map_build_equivalence.serialized_file', return_value=nullcontext(native)):
            refs, count, streams = inspect_dependencies(Path('scene.sharedAssets'), names)
        self.assertEqual(refs, {'unity default resources', 'texture.resS'})
        self.assertEqual((count, streams), (1, 1))
        for value in ('archive:/outside/other.resS', ''):
            stream.path = value
            with self.subTest(reference=value), \
                    patch('verify_map_build_equivalence.serialized_file', return_value=nullcontext(native)), \
                    self.assertRaises(ValueError):
                inspect_dependencies(Path('scene.sharedAssets'), names)

    def test_builtin_file_name_requires_separate_object_proof(self):
        native = SimpleNamespace(externals=[SimpleNamespace(path='Resources/unity_builtin_extra')], objects={})
        with patch('verify_map_build_equivalence.serialized_file', return_value=nullcontext(native)), \
                self.assertRaisesRegex(ValueError, 'object-level baseline evidence'):
            inspect_dependencies(Path('scene.sharedAssets'), set())
        with patch('verify_map_build_equivalence.serialized_file', return_value=nullcontext(native)):
            refs, _, _ = inspect_dependencies(Path('scene.sharedAssets'), set(), {'allObjectsEqual': True})
        self.assertEqual(refs, {'Resources/unity_builtin_extra'})

    def test_builtin_objects_must_match_authenticated_archived_bytes(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            baseline = root / '25739797/PEAK_Data'
            current = root / 'game/PEAK_Data/Resources'
            (baseline / 'Resources').mkdir(parents=True)
            current.mkdir(parents=True)
            (baseline / 'Resources/unity_builtin_extra').write_bytes(b'old container')
            (current / 'unity_builtin_extra').write_bytes(b'new container metadata')
            (baseline / 'extraction-evidence.json').write_text(json.dumps({'schemaVersion': 1, 'files': [
                {'name': 'Resources/unity_builtin_extra', 'sha256': digest(b'old container'), 'bytes': len(b'old container')}
            ]}))
            def obj(payload):
                return SimpleNamespace(type=SimpleNamespace(name='Shader'), get_raw_data=lambda: payload,
                                       read_typetree=lambda: {'m_ParsedForm': {'m_Name': 'Sprites/Default'}})
            old = SimpleNamespace(externals=[], objects={6: obj(b'same object')})
            new = SimpleNamespace(externals=[], objects={6: obj(b'same object')})
            with patch('verify_map_build_equivalence.serialized_file', side_effect=[nullcontext(old), nullcontext(new)]):
                proof = authenticate_builtin_extra(root / 'game', baseline)
            self.assertTrue(proof['allObjectsEqual'])
            self.assertNotEqual(proof['sha256'], proof['baselineFileSha256'])
            new.objects[6] = obj(b'changed shader')
            with patch('verify_map_build_equivalence.serialized_file', side_effect=[nullcontext(old), nullcontext(new)]), \
                    self.assertRaisesRegex(ValueError, 'shader object changed'):
                authenticate_builtin_extra(root / 'game', baseline)

    def test_path_and_hash_checks_reject_escape_and_corruption(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'mesh.glb'
            path.write_bytes(b'mesh')
            authenticate_file(path, digest(b'mesh'), 4)
            for reference in ('../mesh.glb', '/mesh.glb', 'x/../mesh.glb', 'C:/mesh.glb', 'x\\mesh.glb'):
                with self.subTest(reference=reference), self.assertRaises(ValueError):
                    safe_child(root, reference)
            path.write_bytes(b'fake')
            with self.assertRaisesRegex(ValueError, 'SHA-256 differs'):
                authenticate_file(path, digest(b'mesh'), 4)

    def test_bundle_cache_requires_source_hash_every_member_and_builtins(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            game = root / 'game'
            cache = root / 'cache'
            (game / 'StreamingAssets/maps').mkdir(parents=True)
            bundle_path = game / 'StreamingAssets/maps/levels0-31.assetbundle'
            bundle_path.write_bytes(b'bundle')
            extracted = cache / 'levels0-31'
            extracted.mkdir(parents=True)
            (extracted / 'scene').write_bytes(b'scene')
            (extracted / 'unity default resources').write_bytes(b'builtin')
            extraction = {'schemaVersion': 1, 'sourceBundle': bundle_path.name, 'sourceBundleSha256': digest(b'bundle'),
                          'files': [{'name': 'scene', 'sha256': digest(b'scene'), 'bytes': 5}]}
            (extracted / 'extraction-evidence.json').write_text(json.dumps(extraction))
            bundle = {'file': 'StreamingAssets/maps/' + bundle_path.name, 'sha256': digest(b'bundle'), 'extractedBytes': 5}
            with patch('verify_map_build_equivalence.inspect_dependencies', return_value=(set(), 0, 0)), \
                    patch('verify_map_build_equivalence.verify_unityfs_contents'):
                proof, _ = authenticate_bundle(game, cache, bundle, digest(b'builtin'))
                self.assertEqual(proof['memberCount'], 1)
                bundle_path.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'SHA-256 differs'):
                    authenticate_bundle(game, cache, bundle, digest(b'builtin'))
                bundle_path.write_bytes(b'bundle')
                (extracted / 'scene').write_bytes(b'other')
                with self.assertRaisesRegex(ValueError, 'SHA-256 differs'):
                    authenticate_bundle(game, cache, bundle, digest(b'builtin'))
                (extracted / 'scene').write_bytes(b'scene')
                with self.assertRaisesRegex(ValueError, 'SHA-256 differs'):
                    authenticate_bundle(game, cache, bundle, digest(b'other builtin'))

    def test_actual_unityfs_members_authenticate_cached_hashes(self):
        from test_unpack_game_data import bundle_fixture
        value, payload = bundle_fixture('scene')
        with TemporaryDirectory() as folder:
            bundle = Path(folder) / 'maps.assetbundle'
            bundle.write_bytes(value)
            expected = [{'name': 'scene', 'bytes': len(payload), 'sha256': digest(payload)}]
            verify_unityfs_contents(bundle, expected)
            with self.assertRaisesRegex(ValueError, 'Actual UnityFS member differs'):
                verify_unityfs_contents(bundle, [{**expected[0], 'sha256': 'f' * 64}])
            with self.assertRaisesRegex(ValueError, 'member set differs'):
                verify_unityfs_contents(bundle, [{**expected[0], 'name': 'other'}])

    def test_manifest_reuse_requires_exact_scene_build_and_payload_hashes(self):
        with TemporaryDirectory() as folder:
            packs = Path(folder)
            pack = 'sha256-' + 'a' * 64
            root = packs / pack
            root.mkdir()
            layer = {}
            for key, name in [('texture', 'survey.png'), ('height', 'survey.f32'), ('geometry', 'mesh.glb.gz')]:
                payload = key.encode()
                (root / name).write_bytes(payload)
                layer.update({key: name, key + 'Sha256': digest(payload)})
            manifest = {'identityVersion': 3, 'schemaVersion': 1, 'mapPackId': pack, 'sceneName': 'Level_0', 'mapSlot': 0,
                        'gameBuildId': 123, 'gameVersion': 'old', 'source': {'sceneSha256': 'b' * 64, 'sceneFile': 'bundle/scene'},
                        'layers': [layer]}
            source = {'sceneName': 'Level_0', 'mapSlot': 0, 'sceneSha256': 'b' * 64, 'sceneFile': 'bundle/scene'}
            entry = {'mapPackId': pack}
            (root / 'map-pack.json').write_text(json.dumps(manifest))
            _, _, files, _ = verify_manifest_assets(entry, source, '123', 'old', packs)
            self.assertEqual(files, 3)
            with self.assertRaisesRegex(ValueError, 'not bound'):
                verify_manifest_assets(entry, source, '124', 'old', packs)
            changed = {**source, 'sceneSha256': 'c' * 64}
            with self.assertRaisesRegex(ValueError, 'not bound'):
                verify_manifest_assets(entry, changed, '123', 'old', packs)
            (root / layer['geometry']).write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'SHA-256 differs'):
                verify_manifest_assets(entry, source, '123', 'old', packs)


if __name__ == '__main__':
    unittest.main()
