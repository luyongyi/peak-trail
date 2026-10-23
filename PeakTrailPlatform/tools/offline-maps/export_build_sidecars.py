"""Export six exact-build source sidecars with one bounded scene cache at a time."""
from __future__ import annotations
import argparse
import gc
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from build_maps import Scene, game_data, game_info, sha, scene_path as source_scene_path
from export_enclosure import export_enclosures, check_enclosure_asset_budget
from export_fog import export_fog
from export_landmarks import assembly_mvid, export_landmarks
from export_peak import export_peak
from export_routes import export_routes
from export_water import export_water


def export_build_sidecars(game, catalog_path, packs, enclosures, output, slots=None, with_loot=False, split_loot=True):
    mapping, _, build = game_info(game)
    catalog = json.loads(catalog_path.read_text(encoding='utf8'))
    expected = set(mapping) if slots is None else {f'Level_{slot}' for slot in slots}
    if not expected or not expected.issubset(mapping):
        raise ValueError('Requested sidecar scenes are absent from the installed build')
    entries = [entry for entry in catalog['mapPacks'] if entry.get('enabled', True) and str(entry['gameBuildId']) == str(build)
               and entry['sceneName'] in expected]
    if {entry['sceneName'] for entry in entries} != expected or len(entries) != len(expected):
        raise ValueError('Finish all unique current-build canonical packs before exporting complete sidecars')
    if with_loot and not split_loot and len(entries) > 32:
        raise ValueError('Combined private component loot is limited to 32 maps; use the default bounded split output')
    identity = (assembly_mvid(game), sha(game / 'PEAK_Data/Managed/Assembly-CSharp.dll'))
    merged = {}
    loot_types = {}
    loot_index = None
    output.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with tempfile.TemporaryDirectory(prefix='peak-build-sidecars-') as temporary:
        temp = Path(temporary)
        for entry in sorted(entries, key=lambda value: value['mapSlot']):
            single_catalog = temp / 'catalog.json'
            single_catalog.write_text(json.dumps({**catalog, 'mapPacks': [entry]}), encoding='utf8')
            source = source_scene_path(game, mapping[entry["sceneName"]])
            scene = Scene(source, game)
            def factory(path, actual_game):
                if path != source or actual_game != game:
                    raise ValueError('Scene cache must not be reused for another source')
                return scene
            paths = {key: temp / f'{key}.json' for key in ('routes', 'landmarks', 'fog', 'water', 'peaks', 'enclosures')}
            export_routes(game, single_catalog, packs, paths['routes'], scene_factory=factory)
            export_landmarks(game, single_catalog, packs, paths['landmarks'], scene_factory=factory, assembly_identity=identity)
            export_fog(game, single_catalog, packs, paths['routes'], paths['fog'], scene_factory=factory)
            export_water(game, single_catalog, packs, paths['water'], scene_factory=factory)
            export_peak(game, single_catalog, packs, paths['peaks'], scene_factory=factory)
            export_enclosures(game, single_catalog, packs, enclosures, paths['enclosures'], scene_factory=factory)
            if with_loot:
                from export_loot_from_scene import export_map, ITEM_COVERAGE
                manifest = json.loads((packs / entry['mapPackId'] / 'map-pack.json').read_text(encoding='utf8'))
                loot_map, types = export_map(source, game, manifest, scene_factory=factory)
                types = sorted(types, key=lambda value: value['id'])
                component_source = {'kind': 'serialized-scene-item-survey', 'anchor': 'component-world-position',
                                    'itemCoverage': ITEM_COVERAGE}
                if split_loot:
                    # Only this scene's markers cross the Python/Node boundary.
                    # The final build aggregate retains small references, never
                    # all 208 scenes' component and geometry marker objects.
                    component_path = temp / 'scene-loot.json'
                    component_path.write_text(json.dumps({'schemaVersion': 1, 'gameBuildId': str(build),
                        'source': component_source, 'types': types, 'maps': [loot_map]}, ensure_ascii=False), encoding='utf8')
                    partial_index = output / f'.loot-{build}-{os.getpid()}.json'
                    try:
                        subprocess.run(['node', str(Path(__file__).with_name('export-loot-from-geometry.mjs')),
                            '--catalog', str(single_catalog), '--build', str(build), '--packs', str(packs),
                            '--scene-loot', str(component_path), '--output', str(partial_index), '--split'], check=True)
                        index = json.loads(partial_index.read_text(encoding='utf8'))
                        if len(index['maps']) != 1 or index['maps'][0]['mapPackId'] != entry['mapPackId']:
                            raise ValueError('Split loot output does not match the selected canonical map')
                        if loot_index is None:
                            loot_index = {**index, 'maps': []}
                        loot_index['maps'].extend(index['maps'])
                    finally:
                        partial_index.unlink(missing_ok=True)
                else:
                    loot_types.update((kind['id'], kind) for kind in types)
                    if 'scene-loot' not in merged:
                        merged['scene-loot'] = {'schemaVersion': 1, 'gameBuildId': str(build),
                            'source': component_source, 'maps': []}
                    merged['scene-loot']['maps'].append(loot_map)
                del loot_map, types
            for key, path in paths.items():
                value = json.loads(path.read_text(encoding='utf8'))
                if key not in merged:
                    merged[key] = {**value, 'maps': []}
                if len(value['maps']) != 1 or value['maps'][0]['mapPackId'] != entry['mapPackId']:
                    raise ValueError('Source sidecar did not return exactly the selected canonical map')
                merged[key]['maps'].extend(value['maps'])
            del scene, factory
            gc.collect()
            print('SIDECARS READY', entry['sceneName'], f'{time.time() - started:.1f}s', flush=True)
    assets = {enclosure['geometry']: enclosure['geometryBytes'] for value in merged['enclosures']['maps'] for enclosure in value['enclosures']}
    check_enclosure_asset_budget(assets, build)
    output.mkdir(parents=True, exist_ok=True)
    if with_loot and not split_loot:
        merged['scene-loot']['types'] = sorted(loot_types.values(), key=lambda value: value['id'])
    if loot_index is not None:
        merged['loot'] = loot_index
    for key, value in merged.items():
        path = output / f'{key}.{build}.json'
        temporary_path = path.with_suffix('.json.tmp')
        temporary_path.write_text(json.dumps(value, ensure_ascii=False, indent=None if key == 'scene-loot' else 2) + '\n', encoding='utf8')
        temporary_path.replace(path)
    print('COMPLETE BUILD SIDECARS', build, len(entries), 'enclosure bytes', sum(assets.values()), flush=True)


if __name__ == '__main__':
    platform = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--catalog', type=Path, default=platform / 'data/maps/catalog.json')
    parser.add_argument('--packs', type=Path, default=platform.parent / 'local/assets/maps/packs')
    parser.add_argument('--enclosures', type=Path, default=platform.parent / 'local/assets/maps/enclosures')
    parser.add_argument('--output', type=Path, default=platform / 'data/maps')
    parser.add_argument('--slots', default='all', help='Explicit subset for private verification; omit for the complete build')
    parser.add_argument('--with-loot', action='store_true', help='Also export authenticated per-map component/geometry loot with bounded memory')
    parser.add_argument('--component-loot-only', action='store_true', help='Private component-only survey for at most 32 explicitly selected maps')
    args = parser.parse_args()
    slots = None if args.slots == 'all' else set(map(int, args.slots.split(',')))
    if args.component_loot_only and slots is None:
        parser.error('--component-loot-only requires an explicit --slots subset')
    export_build_sidecars(args.game, args.catalog, args.packs, args.enclosures, args.output, slots=slots,
                          with_loot=args.with_loot or args.component_loot_only, split_loot=not args.component_loot_only)
