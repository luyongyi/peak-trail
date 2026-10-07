"""Repeatable current-build export, including privately unpacked UnityFS input.

Use disjoint --slots lists in at most two processes. Canonical registration is
serialized by the existing lock. A rerun verifies completed artifacts and skips
their expensive bake; it never relabels older geometry as a newer game build.
"""
from __future__ import annotations
import argparse
import gc
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from types import SimpleNamespace

from build_maps import build_one, game_data, game_info, sha
from export_meshes import export_one
from unpack_game_data import unpack


def prepare_input(game, cache):
    native = game / 'PEAK_Data'
    if (native / 'globalgamemanagers').is_file():
        return native
    bundle = native / 'data.unity3d'
    build = re.search(r'"buildid"\s+"(\d+)"', (game.parent.parent / 'appmanifest_3527290.acf').read_text(encoding='utf8')).group(1)
    destination = cache / build / 'PEAK_Data'
    evidence_path = destination / 'extraction-evidence.json'
    if evidence_path.exists():
        evidence = json.loads(evidence_path.read_text(encoding='utf8'))
        if evidence['sourceBundleSha256'] != sha(bundle):
            raise ValueError('Cached bundle input differs; select a fresh private --input-cache')
        for item in evidence['files']:
            path = (destination / item['name']).resolve()
            if not path.is_relative_to(destination.resolve()) or path.stat().st_size != item['bytes'] or sha(path) != item['sha256']:
                raise ValueError('Private extracted source cache is corrupt')
    else:
        unpack(bundle, destination)
    target = destination / 'Resources/unity default resources'
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(native / 'Resources/unity default resources', target)
    elif sha(target) != sha(native / 'Resources/unity default resources'):
        raise ValueError('Unity default resources differs from the installed game')
    return destination


def valid_completed_manifest(path, build, version, name, source_digest, fields):
    if not path.exists():
        return False
    value = json.loads(path.read_text(encoding='utf8'))
    if value['gameBuildId'] != build or value['gameVersion'] != version or value['sceneName'] != name or value['source']['sceneSha256'] != source_digest:
        raise ValueError('Existing working artifact is not from this installed source; select a fresh output')
    for layer in value['layers']:
        for field, hash_field in fields:
            asset = path.parent / layer[field]
            if not asset.exists() or sha(asset) != layer[hash_field]:
                raise ValueError(f'Existing working artifact has a corrupt {field}')
    return True


def register_pack(platform, pack, asset_root):
    env = os.environ.copy()
    env['PEAK_TRAIL_ASSET_ROOT'] = str(asset_root.resolve())
    for attempt in range(30):
        result = subprocess.run(['node', str(platform / 'tools/register-map-pack.mjs'), str(pack), '--activate-build'], env=env, capture_output=True, text=True)
        if result.returncode == 0:
            print(result.stdout.strip(), flush=True)
            return
        if 'Another registration is active' not in result.stderr:
            raise RuntimeError(result.stderr)
        time.sleep(1)
    raise RuntimeError('Canonical registration remained locked')


def export_build(args):
    platform = Path(__file__).resolve().parents[2]
    os.environ['PEAK_TRAIL_GAME_DATA'] = str(prepare_input(args.game, args.input_cache))
    mapping, version, build = game_info(args.game)
    slots = sorted(int(name.split('_')[1]) for name in mapping) if args.slots == 'all' else [int(value) for value in args.slots.split(',')]
    working = args.assets / 'maps/working'
    legacy, meshes = working / 'legacy', working / 'mesh-v3'
    for slot in slots:
        name = f'Level_{slot}'
        source_digest = sha(game_data(args.game) / f'level{mapping[name]}')
        legacy_manifest = legacy / str(build) / name / 'map-pack.json'
        if not valid_completed_manifest(legacy_manifest, build, version, name, source_digest,
                                        [('texture', 'textureSha256'), ('height', 'heightSha256')]):
            build_one(args.game, slot, legacy, args.texture, args.height)
            gc.collect()
        mesh_manifest = meshes / str(build) / name / 'map-pack.json'
        if not valid_completed_manifest(mesh_manifest, build, version, name, source_digest,
                                        [('texture', 'textureSha256'), ('height', 'heightSha256'), ('geometry', 'geometrySha256')]):
            export_one(SimpleNamespace(game=args.game, legacy=legacy, output=meshes, layers='all', uncompressed=False), slot)
            gc.collect()
        value = json.loads(mesh_manifest.read_text(encoding='utf8'))
        for layer in value['layers']:
            if layer['geometryFormat'] == 'glb-instanced-v1+gzip':
                continue
            source = mesh_manifest.parent / layer['geometry']
            target = source.with_suffix('.glb.gz')
            target.write_bytes(gzip.compress(source.read_bytes(), compresslevel=9, mtime=0))
            layer.update(geometry=target.name, geometryFormat='glb-instanced-v1+gzip', geometrySha256=sha(target))
        mesh_manifest.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
        subprocess.run(['node', str(platform / 'tools/offline-maps/finalize-map.mjs'), str(mesh_manifest)], check=True)
        register_pack(platform, mesh_manifest.parent, args.assets)
        print('READY', name, build, flush=True)
    if args.with_sidecars:
        from export_build_sidecars import export_build_sidecars
        export_build_sidecars(args.game, platform / 'data/maps/catalog.json', args.assets / 'maps/packs',
                              args.assets / 'maps/enclosures', platform / 'data/maps')


if __name__ == '__main__':
    repository = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--slots', default='all')
    parser.add_argument('--assets', type=Path, default=repository / 'local/assets')
    parser.add_argument('--input-cache', type=Path, default=repository / 'local/native-inputs')
    parser.add_argument('--texture', type=int, default=256)
    parser.add_argument('--height', type=int, default=256)
    parser.add_argument('--with-sidecars', action='store_true', help='Export all six source sidecars after every scene in the installed build is registered')
    args = parser.parse_args()
    if min(args.texture, args.height) < 2:
        parser.error('Planar reference dimensions must be at least two')
    export_build(args)
