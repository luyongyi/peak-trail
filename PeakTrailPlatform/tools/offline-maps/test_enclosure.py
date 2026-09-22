import unittest
from types import SimpleNamespace
import numpy as np
from export_enclosure import child_named, hierarchy, source_enclosure


class SourceScene:
    """Small serialized hierarchy with the same sibling relationship as PEAK."""
    def __init__(self, branch='swamp-temple'):
        self.branch = branch
        temple = branch == 'swamp-temple'
        self.nodes = {}
        # Map -> biome -> optional Volcano branch -> selected segment.
        self.go(1, 'Map', 0)
        self.go(2, 'Gloom' if temple else 'Caldera', 1)
        self.go(3, 'Temple_Segment' if temple else 'Volcano', 2)
        if not temple:
            self.go(4, 'Volcano_Segment', 3)
        self.go(5, 'Gloom Temple' if temple else 'VolcanoModel', 2)
        self.go(6, 'Temple_Model' if temple else 'VolcanoModel', 5)
        self.go(7, 'Splitmesh 0,0,0', 6)
        self.nodes[6]['m_Component'] = [{'component': {'m_PathID': 201}}, {'component': {'m_PathID': 202}}]
        self.nodes[201] = {'m_Enabled': False}
        self.nodes[202] = {'m_Mesh': {'m_FileID': 2, 'm_PathID': 829 if temple else 373}}
        self.objects = {201: SimpleNamespace(type=SimpleNamespace(name='MeshRenderer')),
                        202: SimpleNamespace(type=SimpleNamespace(name='MeshFilter'))}
        self.world_matrix = np.array([[1., 0, 0, 7], [0, 0, 1, 805.1], [0, -1, 0, 2092.5], [0, 0, 0, 1]])
        self.file = SimpleNamespace(name='level22')

    def go(self, key, name, parent):
        self.nodes[key] = {'m_Name': name, 'm_IsActive': True, 'm_Component': []}
        self.nodes[key + 100] = {'m_GameObject': {'m_PathID': key}, 'm_Father': {'m_PathID': parent + 100 if parent else 0}, 'm_Children': []}
        if parent:
            self.nodes[parent + 100]['m_Children'].append({'m_PathID': key + 100})

    def read(self, key): return self.nodes[key]
    def transform(self, key): return key + 100
    def world(self, key): return self.world_matrix
    def route(self): return {'branch': self.branch}
    def layers(self): return [(4, {'_segmentParent': {'m_PathID': 3 if self.branch == 'swamp-temple' else 4}})]
    def ptr(self, pointer):
        name = 'Temple Structure Outer' if self.branch == 'swamp-temple' else 'Pipe'
        return SimpleNamespace(read=lambda: SimpleNamespace(m_Name=name),
                               deref=lambda: SimpleNamespace(assets_file=SimpleNamespace(name='sharedassets4.assets')))
    def collect(self, segment):
        self.collected = segment['_segmentParent']['m_PathID']
        return [(None, None, {'m_GameObject': {'m_PathID': 7}})], [], {'renderers': 1}


class EnclosureSourceTests(unittest.TestCase):
    def test_selected_branch_walks_to_its_real_sibling_enclosure(self):
        for branch in ('swamp-temple', 'volcano-kiln'):
            scene = SourceScene(branch)
            evidence, instances = source_enclosure(scene)
            self.assertEqual(scene.collected, 5)
            self.assertEqual(evidence['segment'], 4)
            self.assertEqual(evidence['sourceModelPathId'], 6)
            self.assertEqual(evidence['sourceActiveSplitRenderers'], 1)
            self.assertFalse(evidence['sourceOriginalRendererEnabled'])
            self.assertEqual(evidence['interiorReference'], [7, 805.1, 2092.5])
            self.assertEqual(evidence['interiorReferenceSource'], 'source-model-axis')
            self.assertEqual(evidence['interiorAxis'], [0, 1, 0])

    def test_inactive_enclosure_or_ancestor_is_rejected_not_force_enabled(self):
        for key in (1, 2, 5, 6):
            scene = SourceScene(); scene.nodes[key]['m_IsActive'] = False
            with self.assertRaisesRegex(ValueError, 'inactive'):
                source_enclosure(scene)

    def test_ambiguous_sibling_fails_instead_of_choosing_by_name(self):
        scene = SourceScene(); scene.go(8, 'Gloom Temple', 2)
        with self.assertRaisesRegex(ValueError, 'found 2'):
            child_named(scene, 2, 'Gloom Temple')

    def test_unknown_route_or_changed_model_convention_fails_closed(self):
        scene = SourceScene(); scene.branch = 'unknown'
        with self.assertRaisesRegex(ValueError, 'Unaudited'):
            source_enclosure(scene)
        scene = SourceScene(); scene.nodes[201]['m_Enabled'] = True
        with self.assertRaisesRegex(ValueError, 'pre-split'):
            source_enclosure(scene)
        scene = SourceScene(); scene.world_matrix = np.eye(4)
        with self.assertRaisesRegex(ValueError, 'vertical'):
            source_enclosure(scene)


if __name__ == '__main__':
    unittest.main()
