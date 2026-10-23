import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from build_maps import bundled_map_sources, scene_path
from export_build import input_cache_lock


class SceneSourceTests(unittest.TestCase):
    def test_cache_lock_excludes_another_preparer_and_releases_after_failure(self):
        with TemporaryDirectory() as folder:
            destination = Path(folder) / 'maps/levels0-31'
            lock = destination.parent / '.levels0-31.prepare.lock'
            with input_cache_lock(destination):
                self.assertTrue(lock.is_file())
                with self.assertRaises(TimeoutError):
                    with input_cache_lock(destination, timeout=0):
                        self.fail('A second preparer acquired the same input cache')
            self.assertFalse(lock.exists())
            with self.assertRaisesRegex(RuntimeError, 'simulated'):
                with input_cache_lock(destination):
                    raise RuntimeError('simulated extraction failure')
            self.assertFalse(lock.exists())

    def test_bundle_membership_uses_shipped_scene_paths_not_manifest_order(self):
        with TemporaryDirectory() as folder:
            game = Path(folder)
            maps = game / 'PEAK_Data/StreamingAssets/maps'
            maps.mkdir(parents=True)
            (maps / 'levels64-95.assetbundle').write_bytes(b'authenticated elsewhere')
            (maps / 'levels64-95.assetbundle.manifest').write_text(
                'Assets:\n- Assets/8_SCENES/Generated/Level_79.unity\n'
                '- Assets/8_SCENES/Generated/Level_64.unity\nDependencies: []\n')
            self.assertEqual(bundled_map_sources(game), {
                'Level_79': 'levels64-95/BuildPlayer-Level_79',
                'Level_64': 'levels64-95/BuildPlayer-Level_64',
            })

    def test_missing_bundle_and_duplicate_scene_fail_closed(self):
        with TemporaryDirectory() as folder:
            game = Path(folder)
            maps = game / 'PEAK_Data/StreamingAssets/maps'
            maps.mkdir(parents=True)
            (maps / 'levels0-31.assetbundle.manifest').write_text(
                '- Assets/8_SCENES/Generated/Level_0.unity\n')
            with self.assertRaisesRegex(ValueError, 'missing'):
                bundled_map_sources(game)
            (maps / 'levels0-31.assetbundle').write_bytes(b'first')
            (maps / 'levels32-63.assetbundle').write_bytes(b'second')
            (maps / 'levels32-63.assetbundle.manifest').write_text(
                '- Assets/8_SCENES/Generated/Level_0.unity\n')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                bundled_map_sources(game)

    def test_source_cache_is_explicit_and_cannot_escape_its_root(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            cache = root / 'maps'
            cache.mkdir()
            (cache / 'scene').write_bytes(b'raw scene')
            (root / 'outside').write_bytes(b'other source')
            with patch.dict(os.environ, {'PEAK_TRAIL_MAP_CACHE': str(cache)}):
                self.assertEqual(scene_path(root, 'scene'), cache / 'scene')
                with self.assertRaisesRegex(ValueError, 'unsafe'):
                    scene_path(root, '../outside')
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(ValueError, 'PEAK_TRAIL_MAP_CACHE'):
                    scene_path(root, 'scene')

    def test_unrecognized_and_missing_bundle_manifests_fail_closed(self):
        with TemporaryDirectory() as folder:
            game = Path(folder)
            maps = game / 'PEAK_Data/StreamingAssets/maps'
            maps.mkdir(parents=True)
            (maps / 'levels0-31.assetbundle').write_bytes(b'new bundle')
            with self.assertRaisesRegex(ValueError, 'manifest is missing'):
                bundled_map_sources(game)
            (maps / 'levels0-31.assetbundle.manifest').write_text('Assets:\n- Unexpected/Scene.unity\n')
            with self.assertRaisesRegex(ValueError, 'no recognized'):
                bundled_map_sources(game)

    def test_embedded_scenes_keep_original_build_indices(self):
        with TemporaryDirectory() as folder:
            game = Path(folder)
            data = game / 'PEAK_Data'
            data.mkdir()
            (data / 'globalgamemanagers').write_bytes(b'embedded source')
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(scene_path(game, 12), data / 'level12')


if __name__ == '__main__':
    unittest.main()
