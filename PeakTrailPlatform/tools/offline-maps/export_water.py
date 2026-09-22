"""Export source-verified global ocean planes missed by segment-only mesh export.

No scene execution and no guessed sea level. Disabled WaterMesh prototypes,
colliders without a visible renderer, and per-biome water are not candidates.
"""
import argparse
import gc
import json
from pathlib import Path

import numpy as np
from UnityPy.classes import PPtr
from build_maps import Scene, game_info, pid, sha
from export_meshes import stored_color_to_linear


def active_ancestry(scene, go):
    names = []
    current = scene.transform(go)
    while current:
        data = scene.read(current)
        parent = scene.read(pid(data['m_GameObject']))
        if not parent['m_IsActive']:
            return None
        names.append(parent['m_Name'])
        current = pid(data['m_Father'])
    return names


def rectangular_plane(vertices, triangles, world):
    """A two-triangle plane is the exact same surface, not a height-field bake."""
    if vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices):
        raise ValueError('Ocean mesh has no source vertices')
    lo, hi = vertices.min(0), vertices.max(0)
    if abs(hi[1] - lo[1]) > 1e-6 or hi[0] <= lo[0] or hi[2] <= lo[2]:
        raise ValueError('Ocean source is not a horizontal plane')
    faces = np.concatenate(triangles)
    areas = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]], vertices[faces[:, 2]] - vertices[faces[:, 0]])
    area = np.sum(np.linalg.norm(areas, axis=1)) / 2
    if not np.isclose(area, (hi[0] - lo[0]) * (hi[2] - lo[2]), rtol=1e-6):
        raise ValueError('Ocean source triangles do not cover the source rectangle')
    corners = np.array([[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]],
                        [hi[0], lo[1], hi[2]], [lo[0], lo[1], hi[2]]])
    corners = corners @ world[:3, :3].T + world[:3, 3]
    if np.ptp(corners[:, 1]) > 1e-5:
        raise ValueError('Global ocean is not horizontal in world coordinates')
    return corners.tolist()


def ocean_surface(scene, obj, segment):
    go = scene.read(obj.path_id)
    ancestry = active_ancestry(scene, obj.path_id)
    # The global Water hierarchy is separate from Map/MapHandler. Do not turn
    # disabled editor water or gameplay trigger boxes into visible geometry.
    if not ancestry or 'Water' not in ancestry or 'Misc' not in ancestry or 'Map' in ancestry:
        return None
    components = {scene.objects[pid(c['component'])].type.name: pid(c['component']) for c in go['m_Component']}
    if 'MeshRenderer' not in components or 'MeshFilter' not in components:
        return None
    renderer = scene.read(components['MeshRenderer'])
    if not renderer['m_Enabled'] or len(renderer['m_Materials']) != 1:
        return None
    matptr = renderer['m_Materials'][0]
    material_reader = scene.ptr(matptr).deref()
    material = material_reader.read_typetree()
    shaderptr = material['m_Shader']
    shader = PPtr(m_FileID=shaderptr['m_FileID'], m_PathID=shaderptr['m_PathID'],
                  assetsfile=material_reader.assets_file).read_typetree()['m_ParsedForm']
    if shader['m_Name'] != 'GD/Water-GD':
        return None
    props = {p['m_Name']: p for p in shader['m_PropInfo']['m_Props']}
    color = dict(material['m_SavedProperties']['m_Colors'])['_WaterColorPrimary']
    flags = int(props['_WaterColorPrimary']['m_Flags'])
    rgba = [float(color[key]) for key in 'rgba']
    meshptr = scene.read(components['MeshFilter'])['m_Mesh']
    vertices, triangles, _, _, mesh_name = scene.mesh(meshptr)
    corners = rectangular_plane(vertices, triangles, scene.world(scene.transform(obj.path_id)))
    return {'objectId': f'map-water:{scene.file.name}:{components["MeshRenderer"]}',
            'kind': 'ocean', 'segment': segment, 'source': 'serialized-global-water-renderer',
            'sourceRendererPathId': components['MeshRenderer'], 'sourceHierarchy': list(reversed(ancestry)),
            'sourceMesh': mesh_name, 'sourceVertices': len(vertices),
            'sourceTriangles': sum(len(t) for t in triangles), 'corners': corners,
            'material': {'name': material['m_Name'], 'shader': shader['m_Name'],
                         'asset': material_reader.assets_file.name, 'pathId': material_reader.path_id,
                         'colorProperty': '_WaterColorPrimary', 'colorFlags': flags,
                         'storedColor': rgba, 'linearColor': stored_color_to_linear(rgba[:3], flags).tolist()}}


def export_water(game, catalog_path, packs_path, output, slots=None):
    mapping, _, build = game_info(game)
    catalog = json.loads(catalog_path.read_text(encoding='utf8'))
    result = {'schemaVersion': 1, 'gameBuildId': str(build), 'authority': 'serialized-map-baseline',
              'note': 'Exact global source plane and primary material color; shore/overview presentation only. Animated waves, depth tint, refraction and foam are not reproduced.',
              'maps': []}
    for entry in sorted(catalog['mapPacks'], key=lambda value: value['mapSlot']):
        if not entry.get('enabled', True) or str(entry['gameBuildId']) != str(build) or (slots and entry['mapSlot'] not in slots):
            continue
        manifest = json.loads((packs_path / entry['mapPackId'] / 'map-pack.json').read_text(encoding='utf8'))
        name = entry['sceneName']
        path = game / 'PEAK_Data' / f'level{mapping[name]}'
        scene_hash = sha(path)
        if manifest['source']['sceneSha256'] != scene_hash:
            raise ValueError(f'{name}: source scene changed; rebuild the geometry first')
        shores = [layer['segment'] for layer in manifest['layers'] if layer['biome'] == 'Shore']
        if len(shores) != 1:
            raise ValueError(f'{name}: expected one confirmed shore chapter')
        scene = Scene(path, game)
        surfaces = []
        for obj in scene.objects.values():
            if obj.type.name != 'GameObject':
                continue
            # Only a renderer can contribute water. Avoid walking hundreds of
            # thousands of transforms for empty scene grouping nodes.
            go = scene.read(obj.path_id)
            if not any(scene.objects[pid(c['component'])].type.name == 'MeshRenderer' for c in go['m_Component']):
                continue
            water = ocean_surface(scene, obj, shores[0])
            if water:
                surfaces.append(water)
        if len(surfaces) != 1:
            raise ValueError(f'{name}: expected one enabled global ocean renderer, found {len(surfaces)}')
        result['maps'].append({'mapPackId': manifest['mapPackId'], 'sceneName': name, 'mapSlot': entry['mapSlot'],
                              'sourceSceneSha256': scene_hash, 'surfaces': surfaces})
        print(name, [(v['sourceHierarchy'], v['corners'][0][1]) for v in surfaces], flush=True)
        del scene
        gc.collect()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print('COMPLETE', output, len(result['maps']), flush=True)


if __name__ == '__main__':
    platform = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--catalog', type=Path, default=platform / 'data/maps/catalog.json')
    parser.add_argument('--packs', type=Path, default=platform.parent / 'local/assets/maps/packs')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--slots', nargs='+', type=int)
    args = parser.parse_args()
    build = game_info(args.game)[2]
    export_water(args.game, args.catalog, args.packs,
                 args.output or platform / f'data/maps/water.{build}.json', args.slots)
