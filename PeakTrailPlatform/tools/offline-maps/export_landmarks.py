"""Bind native layout landmarks to exact canonical scene hashes, in centimetres."""
from __future__ import annotations
import argparse
import gc
import json
import math
import hashlib
import subprocess
from urllib.parse import quote
from pathlib import Path
import numpy as np
from build_maps import Scene, game_data, game_info, pid, sha, BIOMES
from export_meshes import decompose_exact

STATIC_ROOT_ASSEMBLIES = {
    # Audited MapHandler.InitializeMap/JumpToSegmentLogic and
    # MountainProgressHandler.InitProgressPoints: no root TRS writes.
    '25739797': ('60e206758e5a4ad99b5ac31f273b85fc',
                 '97141b7fe9cda6ac1db3093d3579908dbff78db0b4343cb3e19429b486a46919'),
}


def centimeters(position):
    # Match C# Math.Round(value * 100, MidpointRounding.AwayFromZero).
    return [int(math.copysign(math.floor(abs(float(np.float32(value))) * 100 + .5), value)) for value in position]


def native_world_path(scene, transform):
    parts = []
    while transform:
        value = scene.read(transform)
        name = scene.read(pid(value['m_GameObject']))['m_Name']
        parent = pid(value['m_Father'])
        if parent:
            siblings = [pid(child) for child in scene.read(parent)['m_Children']]
            parts.append(f'{siblings.index(transform)}:{quote(name, safe="-_.~")}')
        else:
            parts.append(quote(name, safe='-_.~'))
        transform = parent
    return '/'.join(reversed(parts))


def expected_legacy_layout(scene, build, assembly_mvid, scene_name, alignment):
    """Authenticate older record layout hashes from original roots and gates."""
    landmarks = {value['key']: value for value in alignment['landmarks']}
    roots = []
    names = []
    route = []
    for index, segment in scene.layers():
        transform = scene.transform(pid(segment['_segmentParent']))
        position = landmarks[f'segment-root:{index}']['positionCm']
        roots.append(f'{index}:{native_world_path(scene, transform)}:' + ','.join(map(str, position)))
        biome = BIOMES[int(segment['_biome'])]
        route.append(biome)
        names.append('Temple' if index == 4 and biome == 'Swamp' else 'Kiln' if index == 4 and biome == 'Volcano' else biome)
    gates = []
    for index, name in enumerate(names):
        enter = landmarks.get(f'progress-point:{index}')
        exit_point = landmarks.get(f'progress-point:{index + 1}' if index < 4 else 'progress-point:peak')
        enter_z = str(enter['positionCm'][2]) if index < 5 and enter and exit_point and enter['positionCm'][2] < exit_point['positionCm'][2] else ''
        exit_z = str(exit_point['positionCm'][2]) if enter_z else ''
        gates.append(f'{index}:{name}:{enter_z}:{exit_z}')
    text = f'peak-memories/layout/v1/{build}/{assembly_mvid}/{scene_name}/' + ','.join(route) + '/' + ';'.join(roots) + '/' + ';'.join(gates)
    return hashlib.sha256(text.encode('utf8')).hexdigest()


def assembly_mvid(game):
    # Loading metadata does not run Character or any game method. On Windows,
    # use the same CLR ManifestModule ID that the Mod writes into its header.
    path = (game / 'PEAK_Data/Managed/Assembly-CSharp.dll').resolve()
    literal = str(path).replace("'", "''")
    command = f"$a=[System.Reflection.Assembly]::LoadFile('{literal}'); $a.ManifestModule.ModuleVersionId.ToString('N')"
    result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', command], check=True, capture_output=True, text=True).stdout.strip()
    if len(result) != 32 or any(value not in '0123456789abcdef' for value in result):
        raise ValueError('Unexpected native assembly MVID')
    return result


def transform_landmark(scene, transform, key, kind, name, stage_index=None, pose=False):
    world = scene.world(transform)
    if not np.all(np.isfinite(world)):
        raise ValueError(f'Non-finite source transform: {key}')
    result = {'key': key, 'kind': kind, 'name': name, 'positionCm': centimeters(world[:3, 3])}
    if stage_index is not None:
        result['stageIndex'] = stage_index
    if pose:
        exact = decompose_exact(world)
        if exact is None:
            raise ValueError(f'Sheared layout root is not supported: {key}')
        _, rotation, scale = exact
        result.update(rotation=rotation.tolist(), scale=scale.tolist())
    return result


def scene_alignment(scene):
    """Use the same selected roots and first-unused-biome gate rule as the Mod."""
    points = scene.special.get('MountainProgressHandler', {}).get('progressPoints', [])
    if not points:
        raise ValueError('The native mountain progress landmarks are missing')
    landmarks = []
    used = set()
    for index, segment in scene.layers():
        root = pid(segment['_segmentParent'])
        landmarks.append(transform_landmark(scene, scene.transform(root), f'segment-root:{index}',
                                            'segment-root', scene.read(root)['m_Name'], index, pose=True))
        if index >= 5:
            continue
        selected = next((i for i, point in enumerate(points)
                         if i not in used and int(point['biome']) == int(segment['_biome']) and pid(point['transform'])), None)
        if selected is None:
            raise ValueError(f'No native progress gate for stage {index}')
        used.add(selected)
        point = points[selected]
        transform = pid(point['transform'])
        name = scene.read(pid(scene.read(transform)['m_GameObject']))['m_Name']
        landmarks.append(transform_landmark(scene, transform, f'progress-point:{index}',
                                            'progress-point', name, index))
    peak = next((point for point in points if int(point['biome']) == 5 and pid(point['transform'])), None)
    if peak is None:
        raise ValueError('No native Peak progress gate')
    transform = pid(peak['transform'])
    name = scene.read(pid(scene.read(transform)['m_GameObject']))['m_Name']
    landmarks.append(transform_landmark(scene, transform, 'progress-point:peak',
                                        'progress-point', name))
    if len(landmarks) > 16 or len({point['key'] for point in landmarks}) != len(landmarks):
        raise ValueError('Invalid source landmark cardinality')
    positions = np.asarray([value['positionCm'] for value in landmarks], dtype=float)
    if np.linalg.matrix_rank(positions - positions[0], tol=1e-4) < 2:
        raise ValueError('Source layout landmarks are collinear; cannot verify a rigid alignment')
    return {'version': 1, 'coordinateSpace': 'unity-world-cm', 'landmarks': landmarks}


def export_landmarks(game, catalog_path, packs_path, output, scene_factory=Scene, assembly_identity=None):
    mapping, version, build = game_info(game)
    catalog = json.loads(catalog_path.read_text(encoding='utf8'))
    mvid, assembly_digest = assembly_identity or (assembly_mvid(game), sha(game / 'PEAK_Data/Managed/Assembly-CSharp.dll'))
    static_root_proof = STATIC_ROOT_ASSEMBLIES.get(str(build)) == (mvid, assembly_digest)
    result = {'schemaVersion': 1, 'gameBuildId': str(build), 'gameVersion': version,
              'sourceGameAssemblyMvid': mvid,
              'sourceGameAssemblySha256': assembly_digest,
              'authority': 'serialized-map-landmarks', 'maps': []}
    for entry in sorted(catalog['mapPacks'], key=lambda value: value['mapSlot']):
        if not entry.get('enabled', True) or str(entry['gameBuildId']) != str(build):
            continue
        manifest = json.loads((packs_path / entry['mapPackId'] / 'map-pack.json').read_text(encoding='utf8'))
        path = game_data(game) / f'level{mapping[entry["sceneName"]]}'
        digest = sha(path)
        if manifest['source']['sceneSha256'] != digest or manifest['mapPackId'] != entry['mapPackId']:
            raise ValueError('Source scene and canonical map identity disagree; rebuild the map')
        scene = scene_factory(path, game)
        alignment = scene_alignment(scene)
        entry_result = {'sceneName': entry['sceneName'], 'mapPackId': entry['mapPackId'],
                        'sourceSceneSha256': digest, 'alignment': alignment}
        if static_root_proof:
            entry_result.update(expectedLegacyLayoutKey=expected_legacy_layout(scene, build, mvid, entry['sceneName'], alignment),
                                legacyRootTransformPolicy='static-no-runtime-trs-writes')
        result['maps'].append(entry_result)
        print(entry['sceneName'], len(alignment['landmarks']), 'native layout landmarks', flush=True)
        del scene
        gc.collect()
    if not result['maps']:
        raise ValueError('No canonical packs for this installed build')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    return result


if __name__ == '__main__':
    platform = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--catalog', type=Path, default=platform / 'data/maps/catalog.json')
    parser.add_argument('--packs', type=Path, default=platform.parent / 'local/assets/maps/packs')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    build_id = game_info(args.game)[2]
    export_landmarks(args.game, args.catalog, args.packs, args.output or platform / f'data/maps/landmarks.{build_id}.json')
