import unittest
import numpy as np
from export_landmarks import centimeters, scene_alignment, native_world_path


class SourceFixture:
    def __init__(self):
        self.nodes = {}
        self.roots = []
        self.matrices = {}
        self.special = {'MountainProgressHandler': {'progressPoints': []}}
        self.nodes[100] = {'m_GameObject': {'m_PathID': 101}, 'm_Father': {'m_PathID': 0}, 'm_Children': []}
        self.nodes[101] = {'m_Name': 'Map 根'}
        root_positions = [(0, 0, 0), (0, 0, 76), (0, 0, 161), (1.25, 645.15, 1202), (-17, 862.1, 2147), (0, 727, 507)]
        for index, (biome, position) in enumerate(zip([0, 1, 2, 8, 8, 17], root_positions)):
            go, transform = 200 + index, 300 + index
            self.nodes[go] = {'m_Name': 'Stage / ' + str(index)}
            self.nodes[transform] = {'m_GameObject': {'m_PathID': go}, 'm_Father': {'m_PathID': 100}, 'm_Children': []}
            self.nodes[100]['m_Children'].append({'m_PathID': transform})
            self.matrices[transform] = np.eye(4)
            self.matrices[transform][:3, 3] = position
            self.roots.append((index, {'_biome': biome, '_segmentParent': {'m_PathID': go}}))
        for index, (biome, z) in enumerate([(0, -360), (1, 200), (7, 200), (2, 625), (6, 625), (3, 1295), (3, 2010), (8, 1295), (8, 2010), (5, 2135)]):
            go, transform = 400 + index, 500 + index
            self.nodes[go] = {'m_Name': 'Reached' + str(index)}
            self.nodes[transform] = {'m_GameObject': {'m_PathID': go}, 'm_Father': {'m_PathID': 0}}
            self.matrices[transform] = np.eye(4)
            self.matrices[transform][:3, 3] = (0, index * 100, z)
            self.special['MountainProgressHandler']['progressPoints'].append({'biome': biome, 'title': 'unused title', 'transform': {'m_PathID': transform}})

    def read(self, key): return self.nodes[key]
    def transform(self, go): return go + 100
    def world(self, transform): return self.matrices[transform]
    def layers(self): return self.roots


class LandmarkContractTests(unittest.TestCase):
    def test_rounds_native_float_centimetres_away_from_zero(self):
        self.assertEqual(centimeters([1.125, -1.125, 0]), [113, -113, 0])

    def test_selected_repeated_final_biomes_keep_distinct_native_gates(self):
        result = scene_alignment(SourceFixture())
        points = {value['key']: value for value in result['landmarks']}
        self.assertEqual(len(points), 12)
        self.assertEqual(points['progress-point:3']['name'], 'Reached7')
        self.assertEqual(points['progress-point:4']['name'], 'Reached8')
        self.assertEqual(points['progress-point:4']['positionCm'][2], 201000)
        self.assertEqual(points['progress-point:peak']['name'], 'Reached9')
        self.assertEqual(points['segment-root:5']['stageIndex'], 5)
        self.assertEqual(points['segment-root:3']['positionCm'], [125, 64515, 120200])
        self.assertEqual(points['segment-root:3']['rotation'], [0, 0, 0, 1])

    def test_missing_gate_is_rejected_instead_of_guessed(self):
        source = SourceFixture()
        source.special['MountainProgressHandler']['progressPoints'] = []
        with self.assertRaisesRegex(ValueError, 'missing'):
            scene_alignment(source)

    def test_collinear_landmarks_cannot_prove_a_rigid_world_frame(self):
        source = SourceFixture()
        for matrix in source.matrices.values():
            matrix[0, 3] = matrix[1, 3] = 0
        with self.assertRaisesRegex(ValueError, 'collinear'):
            scene_alignment(source)

    def test_legacy_path_preserves_sibling_index_and_uri_escaping(self):
        self.assertEqual(native_world_path(SourceFixture(), 303), 'Map%20%E6%A0%B9/3:Stage%20%2F%203')


if __name__ == '__main__':
    unittest.main()
