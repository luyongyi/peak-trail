"""Export omitted, active source enclosure roots without changing canonical packs.

Temple and Furnace outer structures are siblings of MapHandler's selected
segment root. Their disabled original renderer has enabled pre-split children.
No runtime script, collider reconstruction, decimation or forced activation is
used. Output GLBs are content-addressed and shared across equivalent scenes.
"""
import argparse
import gc
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

import numpy as np
from build_maps import Scene, game_info, pid, sha
from export_meshes import GlbBuilder


def parent_go(scene, go):
    parent = pid(scene.read(scene.transform(go))['m_Father'])
    return pid(scene.read(parent)['m_GameObject']) if parent else 0


def hierarchy(scene, go):
    result = []
    while go:
        node = scene.read(go)
        if not node['m_IsActive']:
            raise ValueError(f'Enclosure ancestor {node["m_Name"]} is inactive')
        result.append(node['m_Name'])
        go = parent_go(scene, go)
    return list(reversed(result))


def child_named(scene, go, name):
    children = [pid(scene.read(pid(child))['m_GameObject'])
                for child in scene.read(scene.transform(go))['m_Children']]
    matches = [child for child in children if scene.read(child)['m_Name'] == name]
    if len(matches) != 1:
        raise ValueError(f'Expected one {name!r} child, found {len(matches)}')
    return matches[0]


def source_enclosure(scene):
    route = scene.route()
    terminal = pid(dict(scene.layers())[4]['_segmentParent'])
    branch = route['branch']
    # Walk from the selected branch, never choose a similarly named object in
    # an inactive alternative or infer a route from slot parity.
    if branch == 'swamp-temple':
        root = child_named(scene, parent_go(scene, terminal), 'Gloom Temple')
        model = child_named(scene, root, 'Temple_Model')
        expected_mesh = 'Temple Structure Outer'
    elif branch == 'volcano-kiln':
        root = child_named(scene, parent_go(scene, parent_go(scene, terminal)), 'VolcanoModel')
        model = child_named(scene, root, 'VolcanoModel')
        expected_mesh = 'Pipe'
    else:
        raise ValueError(f'Unaudited terminal route: {branch}')
    root_path = hierarchy(scene, root)
    model_path = hierarchy(scene, model)
    components = {scene.objects[pid(c['component'])].type.name: pid(c['component'])
                  for c in scene.read(model)['m_Component']}
    original_renderer = scene.read(components['MeshRenderer'])
    mesh_pointer = scene.read(components['MeshFilter'])['m_Mesh']
    mesh = scene.ptr(mesh_pointer).read()
    if mesh.m_Name != expected_mesh or original_renderer['m_Enabled']:
        raise ValueError('Expected the audited disabled pre-split source enclosure mesh')
    world = scene.world(scene.transform(model))
    axis = world[:3, 2] / np.linalg.norm(world[:3, 2])
    if not np.all(np.isfinite(world)) or not np.allclose(axis, [0, 1, 0], atol=1e-5):
        raise ValueError('Original enclosure local-Z axis is not a vertical world-space axis')
    segment = {'_segmentParent': {'m_FileID': 0, 'm_PathID': root},
               '_segmentCampfire': {'m_FileID': 0, 'm_PathID': 0}}
    instances, _, stats = scene.collect(segment)
    if not instances:
        raise ValueError('Enclosure root has no active original mesh renderers')
    model_transform = scene.transform(model)
    split_children = set(pid(child) for child in scene.read(model_transform)['m_Children'])
    split_count = sum(scene.transform(pid(renderer['m_GameObject'])) in split_children
                      for _, _, renderer in instances)
    if split_count == 0:
        raise ValueError('Disabled source model has no active pre-split renderer children')
    evidence = {'segment': 4, 'objectId': f'map-enclosure:{scene.file.name}:{root}',
                'sourceRootPathId': root, 'sourceRootName': scene.read(root)['m_Name'],
                'sourceHierarchy': root_path, 'sourceModelPathId': model,
                'sourceModelName': expected_mesh, 'sourceModelHierarchy': model_path,
                'sourceModelMeshPathId': mesh_pointer['m_PathID'],
                'sourceModelAsset': scene.ptr(mesh_pointer).deref().assets_file.name,
                'interiorReference': world[:3, 3].tolist(),
                'interiorReferenceSource': 'source-model-axis',
                'interiorAxis': axis.tolist(),
                'sourceOriginalRendererEnabled': False,
                'sourceActiveSplitRenderers': split_count,
                'sourceRendererCount': stats['renderers']}
    return evidence, instances


def export_enclosures(game, catalog_path, packs_path, asset_directory, output, slots=None,
                      audit_only=False, max_asset_bytes=64 * 1024 * 1024):
    mapping, _, build = game_info(game)
    if str(build) != '25306743':
        raise ValueError('Enclosure root selection is audited only for build 25306743')
    catalog = json.loads(catalog_path.read_text(encoding='utf8'))
    result = {'schemaVersion': 1, 'gameBuildId': str(build), 'authority': 'serialized-map-enclosure',
              'note': 'Original active pre-split outer mesh roots and exact source model axes; custom shader effects remain approximated. Existing canonical map packs are unchanged.',
              'maps': []}
    sizes = {}
    for entry in sorted(catalog['mapPacks'], key=lambda value: value['mapSlot']):
        if not entry.get('enabled', True) or str(entry['gameBuildId']) != str(build) or (slots and entry['mapSlot'] not in slots):
            continue
        manifest = json.loads((packs_path / entry['mapPackId'] / 'map-pack.json').read_text(encoding='utf8'))
        path = game / 'PEAK_Data' / f'level{mapping[entry["sceneName"]]}'
        scene_hash = sha(path)
        if scene_hash != manifest['source']['sceneSha256']:
            raise ValueError(f'{entry["sceneName"]}: source hash does not match the canonical pack')
        scene = Scene(path, game)
        enclosure, instances = source_enclosure(scene)
        if not audit_only:
            asset_directory.mkdir(parents=True, exist_ok=True)
            # Temporary output is isolated from the public metadata. A failed
            # export cannot replace a previous valid enclosure manifest.
            with tempfile.TemporaryDirectory(prefix='peak-enclosure-') as temporary:
                glb = Path(temporary) / 'enclosure.glb'
                builder = GlbBuilder(scene)
                builder.add_instances(instances)
                report = builder.write(glb)
                subprocess.run(['node', str(Path(__file__).with_name('compress-glb.mjs')), str(glb)],
                               check=True, text=True, capture_output=True)
                published = gzip.compress(glb.read_bytes(), compresslevel=9, mtime=0)
                digest = hashlib.sha256(published).hexdigest()
                filename = f'{digest}.glb.gz'
                sizes[filename] = len(published)
                if sum(sizes.values()) > max_asset_bytes:
                    raise ValueError('Enclosure assets exceed the independent 64 MiB budget; do not remove or simplify other assets')
                target = asset_directory / filename
                if target.exists():
                    if sha(target) != digest:
                        raise ValueError(f'Content-addressed enclosure is corrupt: {target}')
                else:
                    target.write_bytes(published)
                enclosure.update({'geometry': filename, 'geometrySha256': digest,
                                  'geometryFormat': 'glb-instanced-v1+gzip',
                                  'meshBounds': report['bounds'],
                                  'meshStatistics': {key: value for key, value in report.items() if key not in ('sha256', 'bounds')},
                                  'geometryBytes': len(published)})
                del builder
        result['maps'].append({'mapPackId': manifest['mapPackId'], 'gameBuildId': str(build),
                              'sceneName': entry['sceneName'], 'mapSlot': entry['mapSlot'],
                              'sourceSceneSha256': scene_hash, 'enclosures': [enclosure]})
        print(entry['sceneName'], enclosure['sourceRootName'], 'renderers', enclosure['sourceRendererCount'],
              'splits', enclosure['sourceActiveSplitRenderers'], 'axis', enclosure['interiorReference'],
              'bytes', enclosure.get('geometryBytes'), flush=True)
        del scene, instances
        gc.collect()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print('COMPLETE', output, len(result['maps']), 'unique geometries', len(sizes), 'total bytes', sum(sizes.values()), flush=True)
    return result


if __name__ == '__main__':
    platform = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--catalog', type=Path, default=platform / 'data/maps/catalog.json')
    parser.add_argument('--packs', type=Path, default=platform.parent / 'local/assets/maps/packs')
    parser.add_argument('--assets', type=Path, default=platform.parent / 'local/assets/maps/enclosures')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--slots', nargs='+', type=int)
    parser.add_argument('--audit-only', action='store_true')
    args = parser.parse_args()
    if (args.audit_only or args.slots) and not args.output:
        parser.error('Partial/audit exports require an explicit --output and cannot replace the full site metadata')
    export_enclosures(args.game, args.catalog, args.packs, args.assets,
                      args.output or platform / 'data/maps/enclosures.25306743.json', args.slots, args.audit_only)
