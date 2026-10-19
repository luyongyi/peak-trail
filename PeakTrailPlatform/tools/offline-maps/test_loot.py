import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
import numpy as np

from export_loot_from_scene import (describe_spawner, selected_membership, export_map,
                                    spawn_list_kind, vine_spawn_transforms, merge_coincident_markers,
                                    prefab_type)


def plant(**changes):
    value = {'m_Enabled': 1, 'spawnOnStart': 1, 'spawnMode': 1,
             'baseSpawnChance': 0.15, 'spawnPool': 8, 'spawnPointMode': 0,
             'playersInRoomRequirement': 0, 'belowAscentRequirement': -1,
             'spawnSpots': [{'m_PathID': 99}], 'weightedSpawnSpots': [],
             'possibleBerries': {'x': 1, 'y': 5}}
    value.update(changes)
    return value


class SpawnSemanticsTests(unittest.TestCase):
    def test_native_chinese_names_and_distinct_egg_items_reject_unverified_aliases(self):
        for prefab, native_name in (('HealingPuffShroom', '灵药菇'), ('ShelfShroom', '踏板菇'),
                ('WarpFungus', '曲迁菇'), ('EarlyWorm', '早起虫儿'),
                ('AncientIdol', '古老玩偶'), ('Flare', '照明棒')):
            self.assertIn(native_name, prefab_type(prefab)['name'])
        self.assertEqual(prefab_type('Egg')['id'], 'item-spawn-egg-pickup')
        self.assertIn('煎蛋', prefab_type('Egg')['name'])
        self.assertEqual(prefab_type('NestEgg')['id'], 'item-spawn-large-egg-pickup')
        self.assertIn('好大蛋', prefab_type('NestEgg')['name'])
        for alias in ('AntiRopeSpool', 'Coconut', 'HealingRoot', 'PoisonDart', 'GuidebookPage_Unreviewed'):
            with self.assertRaisesRegex(ValueError, 'Unreviewed item prefab'):
                prefab_type(alias)

    def test_deterministic_single_item_is_a_fixed_spawn_transform(self):
        kind, placement, conditions = describe_spawner('SingleItemSpawner', {}, 'Backpack')
        self.assertEqual(kind['id'], 'item-spawn-backpack')
        self.assertEqual(kind['name'], '背包生成点')
        self.assertEqual(placement, 'fixed')
        self.assertEqual(conditions, {})

    def test_single_items_with_game_requirements_remain_candidates(self):
        for value in ({'playersInRoomRequirement': 2}, {'belowAscentRequirement': 3}, {'normalRunsOnly': True}):
            self.assertEqual(describe_spawner('SingleItemSpawner', value, 'Flare')[1], 'randomized-candidate')
        self.assertEqual(describe_spawner('SingleItemSpawner', {}, 'Flare', True)[1], 'randomized-candidate')

    def test_final_flare_keeps_its_extra_ascent_rule(self):
        result = describe_spawner('EndgameFlareSpawner', {}, 'Flare')
        self.assertEqual(result[1], 'randomized-candidate')
        self.assertTrue(result[2]['requiresEndgameFlare'])

    def test_fixed_plant_never_promises_random_content_or_quantity(self):
        kind, placement, conditions = describe_spawner('BerryBush', plant(), None)
        self.assertEqual(kind['id'], 'item-shore-berry-growth')
        self.assertEqual(placement, 'randomized-candidate')
        self.assertEqual(conditions['possibleBerries'], {'x': 1, 'y': 5})
        self.assertEqual(conditions['baseSpawnChance'], 0.15)
        self.assertEqual(conditions['spawnPointCount'], 1)

    def test_weighted_lists_are_one_site_with_distinct_spawn_transforms(self):
        value = plant(spawnPointMode=1, spawnSpots=[], weightedSpawnSpots=[
            {'weight': 1, 'spawnSpots': [{'m_PathID': 3}, {'m_PathID': 4}]},
            {'weight': 2, 'spawnSpots': [{'m_PathID': 4}, {'m_PathID': 5}]}])
        self.assertEqual(describe_spawner('BerryBush', value, None)[2]['spawnPointCount'], 3)

    def test_disabled_empty_and_zero_chance_automatic_spawners_are_omitted(self):
        for value in (plant(spawnOnStart=0), plant(baseSpawnChance=0),
                      plant(spawnSpots=[]), plant(possibleBerries={'x': 0, 'y': 0})):
            self.assertIsNone(describe_spawner('BerryBush', value, None))

    def test_nest_geometry_is_not_duplicated_by_its_component(self):
        for name in ('NestEgg', 'NestEgg_Raven'):
            self.assertIsNone(describe_spawner('BerryBush', plant(spawnMode=0), name))

    def test_unreviewed_pools_and_prefabs_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'Unreviewed item spawn pool'):
            describe_spawner('BerryBush', plant(spawnPool=123), None)
        with self.assertRaisesRegex(ValueError, 'Unreviewed item prefab'):
            describe_spawner('SingleItemSpawner', {}, 'UnreviewedDecorativeStatue')

    def test_ground_spawner_uses_its_spawn_list_not_inherited_prefab_fields(self):
        value = plant(spawnMode=0, spawnPool=0, possibleItems={'x': 1, 'y': 3},
                      _spawnListKind=spawn_list_kind('GroundPlaceSpawner', ['Mushroom Normie', 'Mushroom Lace Poison']))
        kind, placement, conditions = describe_spawner('GroundPlaceSpawner', value, 'Flare')
        self.assertEqual(kind['id'], 'item-ground-forage')
        self.assertEqual(placement, 'randomized-candidate')
        self.assertEqual(conditions['groundProjection'], 'raycast-down-local-up-max-100m')
        self.assertEqual(conditions['possibleItems'], {'x': 1, 'y': 3})

    def test_vine_uses_a_reviewed_spawn_list_and_preserves_spawn_offset(self):
        value = plant(spawnPool=0, spawnOffsetWorldSpace={'x': 1, 'y': 2, 'z': 3},
                      _spawnListKind=spawn_list_kind('BerryVine', ['Berrynana Yellow', 'Berrynana Blue']))
        kind, placement, conditions = describe_spawner('BerryVine', value, None)
        self.assertEqual(kind['id'], 'item-vine-fruit-growth')
        self.assertEqual(placement, 'randomized-candidate')
        self.assertEqual(conditions['spawnOffsetWorldSpace'], {'x': 1, 'y': 2, 'z': 3})
        self.assertEqual(conditions['spawnPointDerivation'], 'active-child-colliders-excluding-ends')

    def test_unreviewed_ground_or_vine_list_does_not_masquerade_as_food(self):
        for component in ('GroundPlaceSpawner', 'BerryVine'):
            with self.assertRaisesRegex(ValueError, 'Unreviewed'):
                spawn_list_kind(component, ['Dynamite'])

    def test_generic_height_based_mode_is_not_misread_as_a_single_pool(self):
        with self.assertRaisesRegex(ValueError, 'Unreviewed generic Spawner mode'):
            describe_spawner('Spawner', plant(spawnMode=2), None)
        self.assertIsNone(describe_spawner('Spawner', plant(spawnMode=3), None))
        self.assertEqual(describe_spawner('BerryBush', plant(spawnMode=2), None)[0]['id'], 'item-shore-berry-growth')

    def test_statue_reward_requires_amulets_for_the_conditional_reward(self):
        kind, placement, conditions = describe_spawner('ScoutStatue', {'_rewardPrefabName': 'ScoutsHonor'}, 'Strange Gem')
        self.assertEqual(kind['id'], 'item-scout-statue-reward')
        self.assertEqual(placement, 'randomized-candidate')
        self.assertEqual(conditions['initialGem'], 'Strange Gem')
        self.assertEqual(conditions['conditionalReward'], 'ScoutsHonor')
        self.assertEqual(conditions['requiredAmuletCount'], 4)
        self.assertTrue(conditions['requiresAllAmulets'])

    def test_coincident_same_type_sites_render_once_and_keep_all_source_conditions(self):
        def marker(pathid, chance):
            return {'layerId': 'shore', 'type': 'item-cactus-growth', 'pos': [1, 2, 3],
                    'placement': 'randomized-candidate', 'source': {'component': 'BerryBush',
                    'componentPathId': pathid, 'conditions': {'baseSpawnChance': chance}}}
        result = merge_coincident_markers([marker('101', 0.1), marker('102', 0.2)])
        self.assertEqual(len(result), 1)
        self.assertEqual([value['componentPathId'] for value in result[0]['source']['coincidentComponents']], ['101', '102'])
        self.assertEqual(result[0]['source']['coincidentComponents'][1]['conditions']['baseSpawnChance'], 0.2)

    def test_nearby_distinct_sites_and_different_layers_are_not_collapsed(self):
        values = [{'layerId': layer, 'type': 'item-cactus-growth', 'pos': point,
                   'placement': 'randomized-candidate', 'source': {'componentPathId': str(index)}}
                  for index, (layer, point) in enumerate((('shore', [1, 2, 3]),
                        ('shore', [1.01, 2, 3]), ('roots', [1, 2, 3])))]
        self.assertEqual(len(merge_coincident_markers(values)), 3)


class Fixture:
    def __init__(self, *_):
        self.nodes = {
            1: {'m_IsActive': False}, 2: {'m_IsActive': False}, 3: {'m_IsActive': True},
            10: {'m_GameObject': {'m_PathID': 1}, 'm_Father': {'m_PathID': 0},
                 'm_Children': [{'m_PathID': 11}, {'m_PathID': 12}]},
            11: {'m_GameObject': {'m_PathID': 2}, 'm_Father': {'m_PathID': 10}, 'm_Children': []},
            12: {'m_GameObject': {'m_PathID': 3}, 'm_Father': {'m_PathID': 10}, 'm_Children': []},
        }
        self.env = SimpleNamespace(typetree_generator=None)
        self.gen = object()
        script = SimpleNamespace(m_FileID=1, m_PathID=50,
                                 read=lambda: SimpleNamespace(m_ClassName='BerryBush'))
        head = SimpleNamespace(m_GameObject=SimpleNamespace(m_PathID=3), m_Script=script)
        self.objects = {900: SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'),
                        parse_monobehaviour_head=lambda: head,
                        read_typetree=lambda: plant(), path_id=900)}

    def read(self, key): return self.nodes[key]
    def transform(self, go): return {1: 10, 2: 11, 3: 12}[go]
    def layers(self): return [(0, {'_segmentParent': {'m_PathID': 1}})]
    def world(self, transform):
        self.asserted_transform = transform
        value = np.eye(4)
        value[:3, 3] = [-123.1256789, 456.1234567, -890.75]
        return value


class SceneIdentityTests(unittest.TestCase):
    def test_statue_marker_uses_referenced_gem_transform_not_component_origin(self):
        class StatueFixture(Fixture):
            def __init__(self, *_):
                super().__init__()
                head = SimpleNamespace(m_GameObject=SimpleNamespace(m_PathID=3),
                    m_Script=SimpleNamespace(m_FileID=1, m_PathID=50,
                        read=lambda: SimpleNamespace(m_ClassName='ScoutStatue')))
                self.objects[900] = SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'),
                    parse_monobehaviour_head=lambda: head, path_id=900,
                    read_typetree=lambda: {'m_Enabled': 1,
                        'gemSpot': {'m_FileID': 0, 'm_PathID': 13},
                        'gemPrefab': {'m_FileID': 3, 'm_PathID': 8001},
                        'scoutsHonorPrefab': {'m_FileID': 3, 'm_PathID': 8002}})
            def ptr(self, value):
                return SimpleNamespace(read=lambda: SimpleNamespace(m_Name={8001: 'Strange Gem', 8002: 'ScoutsHonor'}[value['m_PathID']]))
            def world(self, transform):
                matrix = super().world(transform)
                if transform == 13:
                    matrix[:3, 3] = [19.5, 1180.4632568359375, 2272.091612279415]
                return matrix
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'level5'
            path.write_bytes(b'statue fixture')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest = {'mapPackId': 'sha256-' + 'a' * 64, 'sceneName': 'Level_0', 'mapSlot': 0,
                        'source': {'sceneSha256': digest}, 'layers': [
                        {'id': 'segment-00-shore', 'segment': 0, 'geometrySha256': 'b' * 64}]}
            result, _ = export_map(path, Path(temporary), manifest, StatueFixture)
            marker = result['markers'][0]
            self.assertEqual(marker['pos'], [19.5, 1180.463257, 2272.091612])
            self.assertEqual(marker['source']['anchor'], 'referenced-transform-world-position')
            self.assertEqual(marker['source']['transformField'], 'gemSpot')
            self.assertEqual(marker['source']['transformPathId'], '13')

    def test_global_parent_keeps_scope_without_a_guessed_chapter_or_geometry(self):
        class GlobalFixture(Fixture):
            def __init__(self, *_):
                super().__init__()
                self.special = {'MapHandler': {'globalParent': {'m_PathID': 20}}}
                self.nodes.update({4: {'m_IsActive': False}, 5: {'m_IsActive': True},
                    20: {'m_GameObject': {'m_PathID': 4}, 'm_Father': {'m_PathID': 0},
                         'm_Children': [{'m_PathID': 21}]},
                    21: {'m_GameObject': {'m_PathID': 5}, 'm_Father': {'m_PathID': 20}, 'm_Children': []}})
                self.objects[20] = SimpleNamespace(type=SimpleNamespace(name='Transform'))
                head = SimpleNamespace(m_GameObject=SimpleNamespace(m_PathID=5),
                    m_Script=SimpleNamespace(m_FileID=1, m_PathID=50,
                        read=lambda: SimpleNamespace(m_ClassName='BerryBush')))
                self.objects[901] = SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'),
                    parse_monobehaviour_head=lambda: head, read_typetree=lambda: plant(), path_id=901)
            def transform(self, go):
                return {4: 20, 5: 21}.get(go) or super().transform(go)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'level5'
            path.write_bytes(b'global fixture')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest = {'mapPackId': 'sha256-' + 'a' * 64, 'sceneName': 'Level_0', 'mapSlot': 0,
                        'source': {'sceneSha256': digest}, 'layers': [
                        {'id': 'segment-00-shore', 'segment': 0, 'geometrySha256': 'b' * 64}]}
            result, _ = export_map(path, Path(temporary), manifest, GlobalFixture)
            global_marker = next(marker for marker in result['markers'] if marker.get('scope') == 'global')
            self.assertEqual(global_marker['segment'], -1)
            self.assertEqual(global_marker['layerId'], 'global')
            self.assertEqual(global_marker['source']['scopeRoot'], 'MapHandler.globalParent')
            self.assertEqual(global_marker['source']['sceneSha256'], digest)
            self.assertNotIn('geometrySha256', global_marker['source'])
            self.assertEqual(len(result['markers']), 2)

    def test_vine_reconstructs_active_child_collider_order_and_excludes_ends(self):
        fixture = Fixture()
        fixture.nodes[1]['m_Component'] = [{'component': {'m_PathID': 1001}}]
        fixture.nodes[2]['m_Component'] = [{'component': {'m_PathID': 1002}}]
        fixture.nodes[3]['m_Component'] = [{'component': {'m_PathID': 1003}}, {'component': {'m_PathID': 1004}}]
        for cid in range(1001, 1005):
            fixture.objects[cid] = SimpleNamespace(type=SimpleNamespace(name='BoxCollider'))
        self.assertEqual(vine_spawn_transforms(fixture, 1), [{'m_PathID': 12}])

    def test_selected_inactive_branch_root_is_included_but_inactive_children_are_not(self):
        membership, parents = selected_membership(Fixture())
        self.assertEqual(membership, {1: 0, 3: 0})
        self.assertEqual(parents[3], 1)

    def test_changed_scene_is_rejected_before_deserializing(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'level5'
            path.write_bytes(b'changed scene')
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                export_map(path, Path(temporary), {'sceneName': 'Level_0',
                    'source': {'sceneSha256': '0' * 64}},
                    lambda *_: self.fail('must reject source before parsing'))

    def test_component_position_binds_to_exact_map_layer_without_private_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'level5'
            path.write_bytes(b'fixture scene')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest = {'mapPackId': 'sha256-' + 'a' * 64, 'sceneName': 'Level_0',
                        'mapSlot': 0, 'source': {'sceneSha256': digest},
                        'layers': [{'id': 'segment-00-shore', 'segment': 0,
                                    'geometrySha256': 'b' * 64}]}
            result, definitions = export_map(path, Path(temporary), manifest, Fixture)
            marker = result['markers'][0]
            self.assertEqual(marker['pos'], [-123.125679, 456.123457, -890.75])
            self.assertEqual(marker['layerId'], 'segment-00-shore')
            self.assertEqual(marker['source']['sceneSha256'], digest)
            self.assertEqual(marker['source']['geometrySha256'], 'b' * 64)
            self.assertEqual(marker['source']['componentPathId'], '900')
            self.assertEqual(marker['source']['anchor'], 'component-world-position')
            self.assertNotIn(temporary, str(result))
            self.assertEqual(len(definitions), 1)


if __name__ == '__main__':
    unittest.main()
