"""Audit installed scene routes and bind evidence to the existing exact packs.

This reads the game and canonical packs without modifying either. The output is
small checked metadata; no meshes, textures, assemblies, or player data.
"""
from __future__ import annotations
import argparse
import gc
import json
from pathlib import Path

from build_maps import Scene, game_info, sha


def export_routes(game, catalog_path, packs_path, output):
    mapping, version, build_id = game_info(game)
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    result = {
        'schemaVersion': 1,
        'gameBuildId': str(build_id),
        'gameVersion': version,
        'source': 'Read-only installed Unity MapHandler and resolved segment GameObject names; no geometry changed.',
        'maps': [],
    }
    for entry in sorted(catalog['mapPacks'], key=lambda value: value['mapSlot']):
        if not entry.get('enabled', True) or str(entry['gameBuildId']) != str(build_id):
            continue
        name = entry['sceneName']
        manifest = json.loads((packs_path / entry['mapPackId'] / 'map-pack.json').read_text(encoding='utf-8'))
        if manifest['mapPackId'] != entry['mapPackId'] or manifest['sceneName'] != name:
            raise ValueError(f'Catalog and canonical manifest disagree: {name}')
        scene_path = game / 'PEAK_Data' / f'level{mapping[name]}'
        scene_hash = sha(scene_path)
        if manifest['source']['sceneSha256'] != scene_hash:
            raise ValueError(f'{name} installed scene differs from the existing map pack; rebuild instead of assigning new labels.')
        scene = Scene(scene_path, game)
        route = scene.route()
        # This sidecar can label only geometry the pack actually contains.
        # Never use it to disguise an incorrect pack or swap in the other branch.
        for stage in route['segments']:
            layers = [layer for layer in manifest['layers'] if layer['segment'] == stage['index']]
            if len(layers) != 1 or layers[0]['biome'] != stage['biome']:
                raise ValueError(f'{name} stage {stage["index"]} source biome disagrees with the baked layer.')
        if route['branch'] == 'unknown':
            raise ValueError(f'{name} does not have a verified terminal route.')
        result['maps'].append({
            'sceneName': name,
            'mapSlot': entry['mapSlot'],
            'mapPackId': entry['mapPackId'],
            'sourceSceneSha256': scene_hash,
            'route': route,
        })
        print(name, route['branch'], [stage['name'] for stage in route['segments'][3:5]], flush=True)
        del scene
        gc.collect()
    if not result['maps']:
        raise ValueError('No canonical maps matched this installed build.')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('COMPLETE', output, len(result['maps']), flush=True)


if __name__ == '__main__':
    platform = Path(__file__).resolve().parents[2]
    repository = platform.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--catalog', type=Path, default=platform / 'data/maps/catalog.json')
    parser.add_argument('--packs', type=Path, default=repository / 'local/assets/maps/packs')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    build_id = game_info(args.game)[2]
    export_routes(args.game, args.catalog, args.packs, args.output or platform / f'data/maps/routes.{build_id}.json')
