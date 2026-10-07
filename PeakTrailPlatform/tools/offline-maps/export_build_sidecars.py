"""Export six exact-build source sidecars with one bounded scene cache at a time."""
from __future__ import annotations
import argparse
import gc
import json
from pathlib import Path
import tempfile
import time

from build_maps import Scene, game_data, game_info, sha
from export_enclosure import export_enclosures
from export_fog import export_fog
from export_landmarks import assembly_mvid, export_landmarks
from export_peak import export_peak
from export_routes import export_routes
from export_water import export_water


def export_build_sidecars(game, catalog_path, packs, enclosures, output):
    mapping, _, build = game_info(game)
    catalog = json.loads(catalog_path.read_text(encoding='utf8'))
    entries = [entry for entry in catalog['mapPacks'] if entry.get('enabled', True) and str(entry['gameBuildId']) == str(build)]
    if {entry['sceneName'] for entry in entries} != set(mapping) or len(entries) != len(mapping):
        raise ValueError('Finish all unique current-build canonical packs before exporting complete sidecars')
    identity = (assembly_mvid(game), sha(game / 'PEAK_Data/Managed/Assembly-CSharp.dll'))
    merged = {}
    started = time.time()
    with tempfile.TemporaryDirectory(prefix='peak-build-sidecars-') as temporary:
        temp = Path(temporary)
        for entry in sorted(entries, key=lambda value: value['mapSlot']):
            single_catalog = temp / 'catalog.json'
            single_catalog.write_text(json.dumps({**catalog, 'mapPacks': [entry]}), encoding='utf8')
            source = game_data(game) / f'level{mapping[entry["sceneName"]]}'
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
    if sum(assets.values()) > 64 * 1024 * 1024:
        raise ValueError('Source enclosure geometry exceeded its full-build 64 MiB budget')
    output.mkdir(parents=True, exist_ok=True)
    for key, value in merged.items():
        path = output / f'{key}.{build}.json'
        temporary_path = path.with_suffix('.json.tmp')
        temporary_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
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
    args = parser.parse_args()
    export_build_sidecars(args.game, args.catalog, args.packs, args.enclosures, args.output)
