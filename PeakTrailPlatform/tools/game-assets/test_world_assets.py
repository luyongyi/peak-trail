"""Source-independent world export contracts; no installed game needed."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('export_world_assets', Path(__file__).with_name('export-world-assets.py'))
world = importlib.util.module_from_spec(spec)
spec.loader.exec_module(world)


class WorldAssetTests(unittest.TestCase):
    def test_prefab_local_transform_retains_metres_and_negative_axes(self):
        root = np.array([[0, 0, 2, 100], [0, 3, 0, 200], [-4, 0, 0, 300], [0, 0, 0, 1]], dtype=float)
        local = np.array([[1, 2, 3, 1], [-2, 0.5, -1, 1]])
        world_points = (root @ local.T).T[:, :3]
        actual = world.relative_positions(world_points.reshape(-1), np.linalg.inv(root))
        np.testing.assert_allclose(np.array(actual).reshape(-1, 3), local[:, :3])

    def test_prefab_coordinates_are_not_recentred_or_resized(self):
        points = [0, 3, 0, 8, -2, 4]
        self.assertEqual(world.relative_positions(points, np.eye(4)), points)

    def test_image_exports_never_fabricate_runtime_render_textures(self):
        exporter = object.__new__(world.WorldExporter)
        exporter.resolve = lambda *_: SimpleNamespace(type=SimpleNamespace(name='RenderTexture'))
        self.assertIsNone(exporter.image(None, {}))


if __name__ == '__main__':
    unittest.main()
