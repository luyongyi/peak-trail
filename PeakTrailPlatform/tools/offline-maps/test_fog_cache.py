import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import export_fog


class FogSceneCacheTests(unittest.TestCase):
    def test_restores_type_tree_generator_before_reusing_scene(self):
        for fail in (False, True):
            with self.subTest(source_failure=fail), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                digest = 'a' * 64
                pack_id = 'sha256-' + 'b' * 64
                (root / pack_id).mkdir()
                (root / pack_id / 'map-pack.json').write_text(json.dumps({'mapPackId': pack_id, 'source': {'sceneSha256': digest}}), encoding='utf8')
                catalog = root / 'catalog.json'
                catalog.write_text(json.dumps({'mapPacks': [{'gameBuildId': '25739797', 'mapPackId': pack_id, 'mapSlot': 17, 'sceneName': 'Level_17'}]}), encoding='utf8')
                routes = root / 'routes.json'
                routes.write_text(json.dumps({'maps': [{'mapPackId': pack_id, 'sourceSceneSha256': digest, 'route': {'branch': 'swamp-temple'}}]}), encoding='utf8')
                script = SimpleNamespace(m_FileID=0, m_PathID=1, read=lambda: SimpleNamespace(m_ClassName='StatusFieldGloom'))
                component = SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'), parse_monobehaviour_head=lambda: SimpleNamespace(m_Script=script))
                previous = object()
                generator = object()
                scene = SimpleNamespace(env=SimpleNamespace(typetree_generator=previous), gen=generator,
                                        layers=lambda: [(3, {'_segmentParent': {'m_PathID': 1}})], objects={1: component})
                def volume(actual_scene, *args):
                    self.assertIs(actual_scene.env.typetree_generator, generator)
                    if fail:
                        raise ValueError('native source check failed')
                    return {'segment': 3, 'topY': 1, 'size': [1, 1, 1]}
                with patch.object(export_fog, 'game_info', return_value=({'Level_17': 22}, '2.6.b', 25739797)), \
                     patch.object(export_fog, 'game_data', return_value=root), \
                     patch.object(export_fog, 'sha', return_value=digest), \
                     patch.object(export_fog, 'fog_volume', side_effect=volume), contextlib.redirect_stdout(io.StringIO()):
                    if fail:
                        with self.assertRaisesRegex(ValueError, 'native source check failed'):
                            export_fog.export_fog(root, catalog, root, routes, root / 'fog.json', scene_factory=lambda *args: scene)
                    else:
                        export_fog.export_fog(root, catalog, root, routes, root / 'fog.json', scene_factory=lambda *args: scene)
                self.assertIs(scene.env.typetree_generator, previous)


if __name__ == '__main__':
    unittest.main()
