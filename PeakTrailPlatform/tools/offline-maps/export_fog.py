"""Extract exact-scene baseline Gloom fields, not a reconstruction of a run.

Fog is not a water material and can live outside MapHandler segment roots. This
small sidecar binds source field metadata to existing canonical geometry hashes.
"""
import argparse
import gc
import json
from pathlib import Path

from build_maps import Scene, game_info, pid, sha


def ancestry(scene, go):
    result = []
    current = scene.transform(go)
    while current:
        value = scene.read(current)
        result.append(pid(value['m_GameObject']))
        current = pid(value['m_Father'])
    return result


def fog_volume(scene, obj, scene_name, segment_roots):
    data = obj.read_typetree()
    go = pid(data['m_GameObject'])
    ancestors = ancestry(scene, go)
    # A field directly under a stage is owned by that exact selected root.
    # Shared Gloom parent fields belong to its first selected descendant stage,
    # not a guessed global biome enum (Swamp and Temple reuse the same enum).
    segment = next((index for index, root in segment_roots if root in ancestors), None)
    if segment is None:
        for parent in ancestors[1:]:
            children = [index for index, root in segment_roots if parent in ancestry(scene, root)]
            if children:
                segment = min(children)
                break
    if segment is None:
        return None
    size = [float(data['size'][key]) for key in 'xyz']
    if not all(0 < value <= 10000 for value in size):
        raise ValueError('Invalid source fog field dimensions')
    top = scene.world(scene.transform(go))[:3, 3].tolist()
    # Peak.StatusFieldBounds.PointInField uses an axis-aligned size, ignoring
    # transform scale/rotation, and places its top at transform.position.y.
    center = [top[0], top[1] - size[1] / 2, top[2]]
    materials = []
    def find_materials(tid):
        value = scene.read(tid)
        node = scene.read(pid(value['m_GameObject']))
        for component in node['m_Component']:
            reader = scene.objects[pid(component['component'])]
            if reader.type.name == 'MeshRenderer':
                for ref in reader.read_typetree()['m_Materials']:
                    mat = scene.ptr(ref).read_typetree()
                    if mat['m_Name'] == 'FogSurface':
                        materials.append(mat['m_Name'])
        for child in value['m_Children']:
            find_materials(pid(child))
    find_materials(scene.transform(go))
    if 'FogSurface' not in materials:
        raise ValueError(f'{scene_name}: Gloom field has no confirmed FogSurface renderer')
    return {'objectId': f'map-fog:{scene_name}:{obj.path_id}', 'kind': 'sleep_fog',
            'prefabName': scene.read(go)['m_Name'], 'segment': segment, 'pos': center,
            'rot': [0, 0, 0, 1], 'scale': [1, 1, 1], 'shape': 'box', 'size': size,
            'radius': None, 'activationRadius': None, 'warningRadius': None,
            'topY': top[1], 'surfaceMaterial': 'FogSurface', 'surfaceShader': 'GD/FogSurface',
            'active': True, 'activity': 'source-baseline', 'authority': 'map-baseline',
            'source': 'serialized-map-StatusFieldGloom', 'sourcePathId': obj.path_id,
            'sightDistance': data['sightDistanceThreshold'],
            'statusAmountPerSecond': data['statusAmountPerSecond'],
            'statusDelaySeconds': data['delayBeforeStatusOverTime'],
            'runtimeHeightUnknown': True, 'runtimeSafeZonesUnknown': True}


def export_fog(game, catalog_path, packs_path, routes_path, output, slots=None):
    mapping, _, build = game_info(game)
    catalog = json.loads(catalog_path.read_text(encoding='utf8'))
    routes = json.loads(routes_path.read_text(encoding='utf8'))
    result = {'schemaVersion': 1, 'gameBuildId': str(build),
              'authority': 'serialized-map-baseline',
              'note': 'Source initial configuration only; actual rising height, difficulty and lamp safe zones are unknown without world telemetry.',
              'maps': []}
    for entry in sorted(catalog['mapPacks'], key=lambda value: value['mapSlot']):
        if not entry.get('enabled', True) or str(entry['gameBuildId']) != str(build):
            continue
        if slots and entry['mapSlot'] not in slots:
            continue
        manifest = json.loads((packs_path / entry['mapPackId'] / 'map-pack.json').read_text(encoding='utf8'))
        name = entry['sceneName']
        scene_path = game / 'PEAK_Data' / f'level{mapping[name]}'
        scene_hash = sha(scene_path)
        if manifest['source']['sceneSha256'] != scene_hash:
            raise ValueError(f'{name}: source scene changed; rebuild the geometry first')
        route = next(record for record in routes['maps'] if record['mapPackId'] == manifest['mapPackId'])
        if route['sourceSceneSha256'] != scene_hash:
            raise ValueError('Route sidecar does not match source scene')
        volumes = []
        if route['route']['branch'] == 'swamp-temple':
            scene = Scene(scene_path, game)
            scene.env.typetree_generator = scene.gen
            roots = [(index, pid(value['_segmentParent'])) for index, value in scene.layers() if pid(value['_segmentParent'])]
            scripts = {}
            for obj in scene.objects.values():
                if obj.type.name != 'MonoBehaviour':
                    continue
                head = obj.parse_monobehaviour_head()
                if not head.m_Script.m_PathID:
                    continue
                key = (head.m_Script.m_FileID, head.m_Script.m_PathID)
                if key not in scripts:
                    scripts[key] = head.m_Script.read().m_ClassName
                if scripts[key] != 'StatusFieldGloom':
                    continue
                value = fog_volume(scene, obj, name, roots)
                if value:
                    volumes.append(value)
            del scene
            gc.collect()
        result['maps'].append({'mapPackId': manifest['mapPackId'], 'sceneName': name,
                              'mapSlot': entry['mapSlot'], 'sourceSceneSha256': scene_hash,
                              'volumes': volumes})
        print(name, [(v['segment'], round(v['topY'], 3), v['size']) for v in volumes], flush=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print('COMPLETE', output, len(result['maps']), flush=True)


if __name__ == '__main__':
    platform = Path(__file__).resolve().parents[2]
    repository = platform.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--catalog', type=Path, default=platform / 'data/maps/catalog.json')
    parser.add_argument('--packs', type=Path, default=repository / 'local/assets/maps/packs')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--slots', nargs='+', type=int)
    args = parser.parse_args()
    build_id = game_info(args.game)[2]
    export_fog(args.game, args.catalog, args.packs, platform / f'data/maps/routes.{build_id}.json',
               args.output or platform / f'data/maps/fog.{build_id}.json', args.slots)
