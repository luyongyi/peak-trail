import unittest
from types import SimpleNamespace
import numpy as np
from build_maps import Scene


class RendererScene(Scene):
    """Exercise the actual collector without loading game files or assemblies."""
    def __init__(self, shadow_mode=1, enabled=True):
        self.cache = {}
        self.objects = {}
        self.matrices = {}
        self.go_transforms = {}
        self.meshes = {}
        self.segment = {'_segmentParent': {'m_PathID': 1},
                        '_segmentCampfire': {'m_PathID': 0}}
        for goid, tid, parent in [(1, 10, 0), (2, 20, 10)]:
            components = [(tid, 'Transform'), (tid + 1, 'MeshFilter'),
                          (tid + 2, 'MeshRenderer'), (tid + 3, 'MeshCollider')]
            self.cache[goid] = {'m_Name': 'Quad', 'm_IsActive': True,
                               'm_Component': [{'component': {'m_PathID': cid}}
                                               for cid, _ in components]}
            self.cache[tid] = {'m_GameObject': {'m_PathID': goid},
                               'm_Father': {'m_PathID': parent},
                               'm_Children': [{'m_PathID': 20}] if goid == 1 else []}
            mesh = {'m_FileID': 1, 'm_PathID': 500 + goid}
            self.cache[tid + 1] = {'m_Mesh': mesh}
            self.cache[tid + 2] = {'m_Enabled': enabled if goid == 1 else True,
                                   'm_CastShadows': shadow_mode if goid == 1 else 1,
                                   'm_GameObject': {'m_PathID': goid},
                                   'm_Materials': [{'m_FileID': 1, 'm_PathID': 900}]}
            self.cache[tid + 3] = {'m_Enabled': True, 'm_IsTrigger': False,
                                   'm_Mesh': mesh}
            self.matrices[tid] = np.eye(4)
            for cid, name in components:
                self.objects[cid] = SimpleNamespace(type=SimpleNamespace(name=name))


class RendererVisibilityTests(unittest.TestCase):
    def test_off_on_and_two_sided_shadow_modes_keep_visible_surfaces(self):
        for mode in (0, 1, 2):
            with self.subTest(mode=mode):
                scene = RendererScene(mode)
                renders, colliders, stats = scene.collect(scene.segment)
                self.assertEqual(len(renders), 2)
                self.assertEqual(len(colliders), 2)
                self.assertEqual(stats['renderers'], 2)
                self.assertEqual(stats.get('shadowOnlyRenderers', 0), 0)

    def test_shadow_only_renderer_is_omitted_without_dropping_child_or_collider(self):
        scene = RendererScene(3)
        renders, colliders, stats = scene.collect(scene.segment)
        self.assertEqual([mesh['m_PathID'] for mesh, _, _ in renders], [502])
        self.assertEqual([mesh['m_PathID'] for mesh, _, _ in colliders], [501, 502])
        self.assertEqual(stats['renderers'], 1)
        self.assertEqual(stats['shadowOnlyRenderers'], 1)

    def test_absent_or_unknown_shadow_mode_is_not_guessed_invisible(self):
        for mode in (None, 4):
            with self.subTest(mode=mode):
                scene = RendererScene(mode)
                if mode is None:
                    del scene.cache[12]['m_CastShadows']
                renders, _, stats = scene.collect(scene.segment)
                self.assertEqual(len(renders), 2)
                self.assertEqual(stats.get('shadowOnlyRenderers', 0), 0)

    def test_disabled_renderer_remains_omitted_independent_of_shadow_mode(self):
        for mode in (0, 1, 2, 3):
            with self.subTest(mode=mode):
                scene = RendererScene(mode, enabled=False)
                renders, colliders, stats = scene.collect(scene.segment)
                self.assertEqual([mesh['m_PathID'] for mesh, _, _ in renders], [502])
                self.assertEqual(len(colliders), 2)
                self.assertEqual(stats.get('shadowOnlyRenderers', 0), 0)


if __name__ == '__main__':
    unittest.main()
