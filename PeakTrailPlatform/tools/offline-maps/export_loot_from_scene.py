"""Export fixed item-spawner reference points from authenticated Unity scenes.

The installed game and private scene inputs are read only. Scene SHA-256 and
canonical layer identities are verified independently for every game build.
"""
from __future__ import annotations
import argparse
import gc
import hashlib
import json
from pathlib import Path

from build_maps import Scene, game_data, pid


PREFAB_LABELS = {
    'AloeVera': ('aloe', '芦荟'), 'AncientIdol': ('ancient-idol', '古代雕像'),
    'Backpack': ('backpack', '背包'), 'Beehive': ('beehive', '蜂巢'),
    'BingBong': ('bing-bong', '宾邦'), 'Binoculars': ('binoculars', '望远镜'),
    'Bugle': ('bugle', '号角'), 'Compass': ('compass', '指南针'),
    'Dynamite': ('dynamite', '炸药'), 'Flare': ('flare', '信号棒'),
    'Frisbee': ('frisbee', '飞盘'), 'Guidebook': ('guidebook', '指南'),
    'GuidebookPageScroll Variant': ('guidebook-scroll', '指南卷轴'),
    'HealingPuffShroom': ('healing-puff', '治疗泡芙菇'), 'Lantern': ('lantern', '提灯'),
    'MagicBean': ('magic-bean', '魔豆'), 'Mushroom Normie': ('mushroom', '蘑菇'),
    'Scorpion': ('scorpion', '蝎子'), 'ShelfShroom': ('shelf-shroom-pickup', '菌台道具'),
    'Shell Big': ('shell', '大贝壳'), 'Torch': ('torch', '火把'),
    'WarpFungus': ('warp-fungus', '传送蘑菇'),
    'Winterberry Yellow': ('winterberry-yellow', '黄色冬莓'),
    'RopeShooter': ('rope-shooter', '绳索枪'), 'RopeSpool': ('rope-spool', '绳索'),
    'AntiRopeSpool': ('anti-rope-spool', '反重力绳索'),
    'ClimbingSpike': ('climbing-spike-pickup', '攀爬钉道具'),
    'Coconut': ('coconut-pickup', '椰子'), 'CactusBall': ('cactus-pickup', '仙人掌果'),
    'Egg': ('egg-pickup', '鸟蛋'), 'NestEgg': ('egg-pickup', '鸟蛋'),
    'HealingRoot': ('healing-root', '治疗根'), 'MedicinalRoot': ('medicinal-root', '药根'),
    'PortableStovetopItem': ('portable-stove', '便携炉'),
    'Frog': ('frog', '青蛙'), 'Mandrake': ('mandrake', '曼德拉草'),
    'EarlyWorm': ('early-worm', '早起虫'), 'CloudFungus': ('cloud-fungus', '云朵菇'),
    'Item_Honeycomb': ('honeycomb', '蜂窝蜜'),
    'Glizzy_CattailVariant': ('cattail-food', '香蒲食物'),
    'BounceShroom': ('bounce-shroom', '弹跳菇'), 'Cure-All': ('cure-all', '万能药'),
    'Antidote': ('antidote', '解毒剂'), 'FirstAidKit': ('first-aid', '急救包'),
    'Bandages': ('bandages', '绷带'), 'FireWood': ('firewood', '柴火'),
    'Stone': ('stone', '石头'), 'EggTurkey': ('turkey-egg', '火鸡蛋'),
    'PoisonDart': ('poison-dart', '毒镖'), 'HealingDart Variant': ('healing-dart', '治疗镖'),
    'ChainShooter': ('chain-shooter', '锁链枪'), 'RopeShooterAnti': ('anti-rope-shooter', '反重力绳索枪'),
}
POOL_LABELS = {
    4: ('ground-forage', '地面采集生成点'),
    8: ('shore-berry-growth', '海岸浆果生长点'),
    16: ('jungle-berry-growth', '丛林浆果生长点'),
    32: ('clusterberry-growth', '簇生浆果生长点'),
    64: ('coconut-growth', '椰树生长点'),
    128: ('willow-fruit-growth', '柳树果实生长点'),
    256: ('vine-fruit-growth', '藤蔓果实生长点'),
    512: ('winterberry-growth', '冬莓生长点'),
    4194304: ('cactus-growth', '仙人掌果生长点'),
    8388608: ('redwood-growth', '红杉生长点'),
    33554432: ('campfire-food', '营地食物生成点'),
}
RUNTIME_ACTIVATORS = frozenset(('EnabledRandom', 'DisableBasedOnRunSettings',
                               'VariantObject', 'VariationSwapper', 'SpecialDayZone'))
SPAWNER_CLASSES = frozenset(('SingleItemSpawner', 'EndgameFlareSpawner', 'BerryBush',
                            'BerryVine', 'GroundPlaceSpawner', 'Spawner', 'ScoutStatue'))
PICKUP_COMPONENTS = frozenset(('Item', 'Backpack', 'Guidebook', 'MobItem', 'Stone'))
ITEM_COVERAGE = ('Authenticated pickup-spawner, plant, vine, ground-forage and campfire reference '
                 'points from the selected canonical scene layers and the active MapHandler.globalParent '
                 'subtree. Ordinary anchors use controller world positions; ScoutStatue reward anchors '
                 'use the serialized gemSpot Transform. Global points retain global scope without inferred '
                 'chapter ownership. Contents, quantity, chance, ascent, player requirements and the '
                 'all-amulets reward condition remain game-controlled. Markers describe source spawn '
                 'references rather than live item state.')


def prefab_type(name):
    if name in PREFAB_LABELS:
        slug, label = PREFAB_LABELS[name]
    elif name.startswith('GuidebookPage'):
        slug, label = 'guidebook-page', '指南页'
    else:
        raise ValueError(f'Unreviewed item prefab: {name}')
    return {'id': f'item-spawn-{slug}', 'category': 'item',
            'name': f'{label}生成点', 'color': '#b9d998'}


def spawn_list_kind(component, prefab_names):
    if not prefab_names:
        return None
    if component == 'GroundPlaceSpawner' and all(name.startswith(('Mushroom ', 'Shroomberry_')) or name in ('MedicinalRoot', 'Mandrake_Hidden') for name in prefab_names):
        return 'ground-forage'
    if component == 'BerryVine' and all(name.startswith(('Berrynana ', 'Shroomberry_')) for name in prefab_names):
        return 'vine-fruit-growth'
    raise ValueError(f'Unreviewed {component} spawn list: {prefab_names}')


def describe_spawner(component, data, prefab_name, runtime_activation=False):
    """Return a reviewed point type and spawn semantics; never infer loot rolls."""
    conditions = {key: data[key] for key in ('playersInRoomRequirement',
                  'belowAscentRequirement', 'normalRunsOnly') if key in data}
    if runtime_activation:
        conditions['runtimeActivation'] = True
    if component == 'ScoutStatue':
        if prefab_name != 'Strange Gem' or data.get('_rewardPrefabName') != 'ScoutsHonor':
            raise ValueError('Unreviewed ScoutStatue reward prefabs')
        conditions.update(initialGem=prefab_name, conditionalReward='ScoutsHonor',
                          requiresAllAmulets=True, requiredAmuletCount=4)
        return {'id': 'item-scout-statue-reward', 'category': 'item',
                'name': '终局雕像奖励点', 'color': '#b9d998'}, 'randomized-candidate', conditions
    if component in ('SingleItemSpawner', 'EndgameFlareSpawner'):
        if not prefab_name:
            return None
        if component == 'EndgameFlareSpawner':
            conditions['requiresEndgameFlare'] = True
        conditional = (data.get('playersInRoomRequirement', 0) > 0 or
                       data.get('belowAscentRequirement', -1) != -1 or
                       data.get('normalRunsOnly', False) or
                       runtime_activation or component == 'EndgameFlareSpawner')
        return prefab_type(prefab_name), ('randomized-candidate' if conditional else 'fixed'), conditions
    if component not in ('BerryBush', 'BerryVine', 'GroundPlaceSpawner', 'Spawner'):
        return None
    if component == 'Spawner' and data.get('spawnMode') == 3:
        return None
    if component == 'Spawner' and data.get('spawnMode') not in (0, 1):
        raise ValueError('Unreviewed generic Spawner mode')
    # A disabled/zero-chance controller and a controller without serialized
    # spawn transforms cannot identify an automatic item placement.
    if not data.get('spawnOnStart') or data.get('baseSpawnChance', 0) <= 0:
        return None
    spots = list(data.get('spawnSpots', []))
    for entry in data.get('weightedSpawnSpots', []):
        spots.extend(entry.get('spawnSpots', []))
    if not any(pid(point) for point in spots):
        return None
    conditions.update({key: data[key] for key in ('baseSpawnChance', 'spawnMode',
                       'spawnPointMode', 'spawnPool', 'possibleBerries', 'possibleItems',
                       'spawnOffsetWorldSpace',
                       'canRepeatSpawns') if key in data})
    conditions['spawnPointCount'] = len({pid(point) for point in spots if pid(point)})
    if component in ('BerryBush', 'BerryVine') and data.get('possibleBerries', {}).get('y', 0) <= 0:
        return None
    if component == 'GroundPlaceSpawner':
        if data.get('possibleItems', {}).get('y', 0) <= 0:
            return None
        conditions['groundProjection'] = 'raycast-down-local-up-max-100m'
    if component == 'BerryVine':
        conditions['spawnPointDerivation'] = 'active-child-colliders-excluding-ends'
    if component in ('GroundPlaceSpawner', 'BerryVine'):
        # Both subclasses always use spawns.GetSpawns, even if inherited
        # spawnMode/spawnPool fields claim something else.
        content_kind = data.get('_spawnListKind')
        expected_kind = 'ground-forage' if component == 'GroundPlaceSpawner' else 'vine-fruit-growth'
        if content_kind != expected_kind:
            return None
        label = '地面采集生成点' if component == 'GroundPlaceSpawner' else '藤蔓果实生长点'
        kind = {'id': f'item-{content_kind}', 'category': 'item', 'name': label, 'color': '#98ce91'}
        conditions['spawnListContentKind'] = content_kind
    elif data.get('spawnMode') == 0:
        # Egg nests already have one authenticated static geometry marker.
        # Keeping its BerryBush as well would duplicate the same resource site.
        if prefab_name in ('NestEgg', 'NestEgg_Raven'):
            return None
        if not prefab_name:
            return None
        kind = prefab_type(prefab_name)
    else:
        pool = data.get('spawnPool', 0)
        if pool not in POOL_LABELS:
            raise ValueError(f'Unreviewed item spawn pool: {pool}')
        slug, label = POOL_LABELS[pool]
        kind = {'id': f'item-{slug}', 'category': 'item', 'name': label, 'color': '#98ce91'}
    return kind, 'randomized-candidate', conditions


def selected_membership(scene):
    """Mirror the canonical map's selected roots and active child hierarchy."""
    membership = {}
    parents = {}
    def walk(tid, index, force=False):
        if not tid:
            return
        tree = scene.read(tid)
        goid = pid(tree['m_GameObject'])
        go = scene.read(goid)
        if not force and not go.get('m_IsActive'):
            return
        previous = membership.get(goid)
        if previous is not None and previous != index:
            if index == -1:
                return
            raise ValueError('Selected canonical map layers overlap')
        membership[goid] = index
        parent = pid(tree['m_Father'])
        parents[goid] = pid(scene.read(parent)['m_GameObject']) if parent else None
        for child in tree['m_Children']:
            walk(pid(child), index)
    for index, segment in scene.layers():
        for field in ('_segmentParent', '_segmentCampfire'):
            root = pid(segment.get(field, {}))
            if root:
                walk(scene.transform(root), index, force=True)
    global_root = pid(getattr(scene, 'special', {}).get('MapHandler', {}).get('globalParent', {}))
    if global_root:
        if scene.objects[global_root].type.name not in ('Transform', 'RectTransform'):
            raise ValueError('MapHandler.globalParent must reference a Transform')
        walk(global_root, -1, force=True)
    return membership, parents


def vine_spawn_transforms(scene, goid):
    """Mirror BerryVine.GetSpawnSpots, including its first/last exclusions."""
    result = []
    def walk(tid, force=False):
        tree = scene.read(tid)
        go = scene.read(pid(tree['m_GameObject']))
        if not force and not go.get('m_IsActive'):
            return
        for entry in go.get('m_Component', []):
            cid = pid(entry['component'])
            if scene.objects[cid].type.name in ('BoxCollider', 'SphereCollider',
                    'CapsuleCollider', 'MeshCollider', 'TerrainCollider'):
                result.append({'m_PathID': tid})
        for child in tree['m_Children']:
            walk(pid(child))
    walk(scene.transform(goid), force=True)
    return result[1:-1]


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def merge_coincident_markers(markers):
    """Show a coincident candidate site once while retaining every controller."""
    result = []
    sites = {}
    for marker in markers:
        key = (marker['layerId'], marker['type'], tuple(round(value, 4) for value in marker['pos']))
        if key not in sites:
            sites[key] = marker
            result.append(marker)
            continue
        first = sites[key]
        if 'coincidentComponents' not in first['source']:
            source = first['source']
            source['coincidentComponents'] = [{key: source[key] for key in
                ('component', 'componentPathId', 'conditions') if key in source}]
        source = marker['source']
        first['source']['coincidentComponents'].append({key: source[key] for key in
                ('component', 'componentPathId', 'conditions') if key in source})
        if marker['placement'] == 'randomized-candidate':
            first['placement'] = 'randomized-candidate'
    return result


def export_map(scene_path, game, manifest, scene_factory=Scene):
    expected = manifest['source']['sceneSha256']
    if sha256(scene_path) != expected:
        raise ValueError(f'Source scene SHA-256 mismatch: {manifest["sceneName"]}')
    scene = scene_factory(scene_path, game)
    membership, parents = selected_membership(scene)
    names = {}
    candidates = []
    activators = set()
    for obj in scene.objects.values():
        if obj.type.name != 'MonoBehaviour':
            continue
        scene.env.typetree_generator = None
        head = obj.parse_monobehaviour_head()
        goid = head.m_GameObject.m_PathID
        if goid not in membership:
            continue
        script = head.m_Script
        key = (script.m_FileID, script.m_PathID)
        if key not in names:
            names[key] = script.read().m_ClassName
        component = names[key]
        if component in RUNTIME_ACTIVATORS:
            activators.add(goid)
        if component in SPAWNER_CLASSES:
            candidates.append((obj, goid, component))
    layer_by_segment = {layer['segment']: layer for layer in manifest['layers']}
    markers = []
    types = {}
    pickup_prefabs = {}
    for obj, goid, component in candidates:
        scene.env.typetree_generator = scene.gen
        data = obj.read_typetree()
        if not data.get('m_Enabled', True):
            continue
        if component == 'BerryVine':
            data = dict(data, spawnSpots=vine_spawn_transforms(scene, goid),
                        weightedSpawnSpots=[])
        list_source = None
        if component in ('BerryVine', 'GroundPlaceSpawner'):
            spawn_list = data.get('spawns', {})
            if not pid(spawn_list):
                continue
            ref = scene.ptr(spawn_list).deref()
            scene.env.typetree_generator = scene.gen
            contents = ref.read_typetree()
            from UnityPy.classes import PPtr
            prefab_names = [PPtr(m_FileID=entry['prefab']['m_FileID'],
                                m_PathID=pid(entry['prefab']),
                                assetsfile=ref.assets_file).read().m_Name
                            for entry in contents.get('items', [])
                            if entry.get('weight', 0) > 0 and pid(entry.get('prefab', {}))]
            data = dict(data, _spawnListKind=spawn_list_kind(component, prefab_names))
            list_source = {'file': ref.assets_file.name, 'pathId': str(ref.path_id)}
        prefab_ptr = data.get('gemPrefab', {}) if component == 'ScoutStatue' else data.get('prefab', data.get('spawnedObjectPrefab', {}))
        prefab_name = scene.ptr(prefab_ptr).read().m_Name if pid(prefab_ptr) else None
        if component == 'ScoutStatue':
            reward_ptr = data.get('scoutsHonorPrefab', {})
            if not pid(reward_ptr):
                continue
            data = dict(data, _rewardPrefabName=scene.ptr(reward_ptr).read().m_Name)
        # Confirm a pickup prefab rather than treating every spawnable mob as
        # an item. Spawner class identity alone is insufficient.
        if prefab_name and component in ('SingleItemSpawner', 'EndgameFlareSpawner'):
            prefab_key = (prefab_ptr.get('m_FileID', 0), pid(prefab_ptr))
            if prefab_key not in pickup_prefabs:
                prefab = scene.ptr(prefab_ptr).read_typetree()
                referenced = scene.ptr(prefab_ptr).deref()
                from UnityPy.classes import PPtr
                pickup_prefabs[prefab_key] = False
                for entry in prefab['m_Component']:
                    c = entry['component']
                    ref = PPtr(m_FileID=c['m_FileID'], m_PathID=c['m_PathID'], assetsfile=referenced.assets_file).deref()
                    if ref.type.name == 'MonoBehaviour':
                        scene.env.typetree_generator = None
                        if ref.parse_monobehaviour_head().m_Script.read().m_ClassName in PICKUP_COMPONENTS:
                            pickup_prefabs[prefab_key] = True
                            break
            if not pickup_prefabs[prefab_key]:
                continue
        current = goid
        runtime_activation = False
        while current in membership:
            if current in activators:
                runtime_activation = True
                break
            current = parents.get(current)
        description = describe_spawner(component, data, prefab_name, runtime_activation)
        if description is None:
            continue
        kind, placement, conditions = description
        types[kind['id']] = kind
        is_global = membership[goid] == -1
        layer = {'id': 'global', 'segment': -1} if is_global else layer_by_segment[membership[goid]]
        point_transform = scene.transform(goid)
        if component == 'ScoutStatue':
            gem_spot = data.get('gemSpot', {})
            if not pid(gem_spot) or gem_spot.get('m_FileID', 0) != 0:
                raise ValueError('ScoutStatue.gemSpot must reference a source-scene Transform')
            point_transform = pid(gem_spot)
        pos = scene.world(point_transform)[:3, 3]
        source = {'sourceKind': 'serialized-scene-component', 'component': component,
                  'componentPathId': str(obj.path_id), 'anchor': 'component-world-position',
                  'sceneSha256': expected,
                  'conditions': conditions}
        if is_global:
            source['scopeRoot'] = 'MapHandler.globalParent'
        else:
            source['geometrySha256'] = layer['geometrySha256']
        if component == 'ScoutStatue':
            source.update(anchor='referenced-transform-world-position',
                          transformField='gemSpot', transformPathId=str(point_transform))
        if prefab_name:
            source['prefabName'] = prefab_name
        if list_source:
            source['spawnList'] = list_source
        marker = {'id': f'{layer["id"]}:component:{obj.path_id}',
                        'type': kind['id'], 'category': 'item', 'name': kind['name'],
                        'pos': [round(float(value), 6) for value in pos],
                        'segment': layer['segment'], 'layerId': layer['id'],
                        'placement': placement, 'source': source}
        if is_global:
            marker['scope'] = 'global'
        markers.append(marker)
    markers = merge_coincident_markers(markers)
    return {'mapPackId': manifest['mapPackId'], 'sceneName': manifest['sceneName'],
            'mapSlot': manifest['mapSlot'], 'sourceSceneSha256': expected,
            'layers': [{'id': layer['id'], 'segment': layer['segment'],
                        'geometrySha256': layer['geometrySha256']} for layer in manifest['layers']],
            'markers': markers}, list(types.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--data', '--data-source', dest='data', type=Path)
    parser.add_argument('--build', required=True)
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--packs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--slots', default='all')
    args = parser.parse_args()
    data = args.data or game_data(args.game)
    catalog = json.loads(args.catalog.read_text(encoding='utf-8'))
    selected = None if args.slots == 'all' else set(map(int, args.slots.split(',')))
    entries = [entry for entry in catalog['mapPacks'] if entry.get('enabled')
               and str(entry['gameBuildId']) == args.build
               and (selected is None or entry['mapSlot'] in selected)]
    if not entries:
        raise ValueError('No enabled canonical map packs selected')
    maps = []
    types = {}
    for entry in sorted(entries, key=lambda value: value['mapSlot']):
        manifest = json.loads((args.packs / entry['mapPackId'] / 'map-pack.json').read_text(encoding='utf-8'))
        if (manifest['mapPackId'] != entry['mapPackId'] or str(manifest['gameBuildId']) != args.build
                or manifest['sceneName'] != entry['sceneName'] or manifest['mapSlot'] != entry['mapSlot']):
            raise ValueError('Canonical map identity mismatch')
        result, definitions = export_map(data / manifest['source']['sceneFile'], args.game, manifest)
        maps.append(result)
        types.update((kind['id'], kind) for kind in definitions)
        print(f'{result["sceneName"]}: {len(result["markers"])} serialized item points', flush=True)
        gc.collect()
    output = {'schemaVersion': 1, 'gameBuildId': args.build,
              'source': {'kind': 'serialized-scene-item-survey',
                         'anchor': 'component-world-position',
                         'itemCoverage': ITEM_COVERAGE},
              'types': sorted(types.values(), key=lambda value: value['id']), 'maps': maps}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
