import unittest
import numpy as np
from export_water import rectangular_plane, active_ancestry


class OceanPlaneTests(unittest.TestCase):
    def test_preserves_source_sea_level_and_extent_without_guesses(self):
        vertices = np.array([[-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5]], dtype=float)
        world = np.diag([500., 500., 500., 1.])
        world[1, 3] = -1
        result = rectangular_plane(vertices, [np.array([[0, 2, 1], [0, 3, 2]])], world)
        self.assertEqual(result, [[-2500., -1., -2500.], [2500., -1., -2500.],
                                  [2500., -1., 2500.], [-2500., -1., 2500.]])

    def test_rejects_incomplete_plane_or_nonplanar_geometry(self):
        vertices = np.array([[-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5]], dtype=float)
        with self.assertRaisesRegex(ValueError, 'cover'):
            rectangular_plane(vertices, [np.array([[0, 2, 1]])], np.eye(4))
        vertices[0, 1] = 1
        with self.assertRaisesRegex(ValueError, 'horizontal'):
            rectangular_plane(vertices, [np.array([[0, 2, 1], [0, 3, 2]])], np.eye(4))

    def test_inactive_parent_rejects_prototype_renderer(self):
        class FakeScene:
            def transform(self, go): return 1
            def read(self, value):
                return {1: {'m_GameObject': {'m_PathID': 2}, 'm_Father': {'m_PathID': 3}},
                        2: {'m_Name': 'Collision', 'm_IsActive': True},
                        3: {'m_GameObject': {'m_PathID': 4}, 'm_Father': {'m_PathID': 0}},
                        4: {'m_Name': 'Water', 'm_IsActive': False}}[value]
        self.assertIsNone(active_ancestry(FakeScene(), 2))


if __name__ == '__main__':
    unittest.main()
