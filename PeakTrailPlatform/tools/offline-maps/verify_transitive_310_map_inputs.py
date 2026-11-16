"""Authenticate 3.1.0 inputs against the pinned, complete 3.0.1 map receipt.

No bundle extraction is repeated: the complete prior receipt is verified first,
then every shipped bundle byte and the current external/code dependencies are
rechecked. This tool never changes a catalog or writes raw game assets.
"""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

from verify_map_build_equivalence import (authenticate_builtin_extra, authenticate_file, compare_native_code,
                                         load_json, parse_scene_order, require, sha, verify_external_materials)

PARENT_RECEIPT_SHA = '045c1d36773badd69e63050ca85e1e3e0d0f6eaa08856a750a8ba8fdc0e150e7'
PARENT_PLAN_SHA = 'f6c598d5896e1c4f2910f8515b0b139f52e374427921538b867ac37d0306ef57'
TARGET_ASSEMBLY_SHA = 'a3643f11dc444d86491270b224c0a0caf9126a10b26731feb97fc85ad1d82038'
TARGET_RESOURCES_SHA = '4132cfbb2a2c859708a448b79265002a3b335c81a2a4604be869709c2959afcc'
TARGET_MVID = 'e9a4fa24a0684abd8c8d66c4b2b65471'
TARGET_MAP_BAKER_RAW_SHA = 'f06169e06c6008cdd4ee53a0a82b4222026ec45eba0e3a7eb13947178c4fcd49'

def verify(args):
    maps = args.maps.resolve()
    parent_dir = maps / 'verified-builds/26155610'
    authenticate_file(parent_dir / 'equivalence.json', PARENT_RECEIPT_SHA)
    authenticate_file(parent_dir / 'plan.json', PARENT_PLAN_SHA)
    parent = load_json(parent_dir / 'equivalence.json')
    plan = load_json(parent_dir / 'plan.json')
    require(parent['verified'] is True and parent['sourceBuildId'] == '26134529'
            and parent['targetBuildId'] == '26155610' and len(parent['maps']) == 208
            and len(parent['bundles']) == 7 and all(bundle['bundleContentsVerified'] for bundle in parent['bundles']),
            'Pinned parent receipt is incomplete')
    require(plan['equivalenceReceiptSha256'] == PARENT_RECEIPT_SHA and len(plan['packs']) == 208,
            'Pinned parent plan mismatch')
    authenticate_file(maps / 'game-build.26134529.json', parent['sourceEvidenceSha256'])
    source = load_json(maps / 'game-build.26134529.json')
    require(len(source['maps']) == 208 and source['sceneCount'] == 208, 'Original scene evidence incomplete')
    retained = load_json(maps / 'game-build.26155610.json')
    require(retained['sceneCount'] == 208 and len(retained['maps']) == 208, 'Retained source evidence incomplete')
    retained_maps = {item['sceneName']: item for item in retained['maps']}
    remapped = []
    for item in parent['maps']:
        candidates = [entry for entry in plan['packs'] if entry['sourceMapPackId'] == item['sourceMapPackId']]
        require(len(candidates) == 1, 'Parent source/target pack binding is not unique')
        entry = candidates[0]
        current = retained_maps[item['sceneName']]
        require(current['mapPackId'] == entry['mapPackId'] and current['sceneSha256'] == item['sourceSceneSha256']
                and current['mapSlot'] == item['mapSlot'], 'Retained source map differs from authenticated parent')
        authenticate_file(parent_dir / 'manifests' / entry['mapPackId'] / 'map-pack.json', entry['manifestSha256'], entry['manifestBytes'])
        remapped.append({**item, 'sourceMapPackId': entry['mapPackId'], 'sourceManifestSha256': entry['manifestSha256']})
    data = args.game / 'PEAK_Data'
    authenticate_file(data / 'Managed/Assembly-CSharp.dll', TARGET_ASSEMBLY_SHA)
    authenticate_file(data / 'resources.assets', TARGET_RESOURCES_SHA)
    build = re.search(r'"buildid"\s+"([1-9]\d*)"', (args.game.parent.parent / 'appmanifest_3527290.acf').read_text()).group(1)
    require(build == '26542162' and (args.game / 'version.txt').read_text().splitlines()[0] == '3.1.0--logFile',
            'Target installed version changed')
    code = compare_native_code(args.game, args.baseline_code, args.ilspycmd)
    # MonoBehaviour's generated tree is not valid for this SingletonAsset's
    # serialized inherited header. Independently review the pinned current raw
    # object, including its native header and all zero inherited fields. Only
    # the exact reviewed array is decoded; no offset discovery is trusted.
    import UnityPy
    resource = UnityPy.load(str(data / 'resources.assets'))
    candidates = [obj for obj in resource.objects if obj.path_id == 27846 and obj.type.name == 'MonoBehaviour']
    require(len(candidates) == 1, 'Native MapBaker source identity missing')
    raw = candidates[0].get_raw_data()
    require(hashlib.sha256(raw).hexdigest() == TARGET_MAP_BAKER_RAW_SHA and len(raw) == 40108,
            'Current MapBaker raw object changed')
    require(raw[:12] == bytes(12) and raw[12:16] == b'\x01\0\0\0'
            and struct.unpack_from('<iq', raw, 16) == (1, 5677)
            and struct.unpack_from('<i', raw, 28)[0] == 8 and raw[32:40] == b'MapBaker'
            and raw[40:80] == bytes(40), 'Current MapBaker native/inherited header differs')
    order = {**source['sceneOrder'], 'assetSha256': TARGET_RESOURCES_SHA, 'objectSha256': TARGET_MAP_BAKER_RAW_SHA}
    expected_paths = [item['scenePath'] for item in sorted(source['maps'], key=lambda item: item['mapSlot'])]
    paths = parse_scene_order(raw, order, expected_paths)
    order.update(scenePaths=paths, equal=True,
                 fieldAudit='fresh pinned 3.1.0 raw object; native name/script/zero inherited prefix; reviewed offset 80; exact bounded 208 strings')
    bundles = []
    expected_files = {bundle['file'] for bundle in parent['bundles']}
    current_files = {str(path.relative_to(data)).replace('\\', '/') for path in (data / 'StreamingAssets/maps').glob('levels*.assetbundle')}
    require(current_files == expected_files, 'Current shipped bundle set changed')
    for bundle in parent['bundles']:
        path = data / bundle['file']
        authenticate_file(path, bundle['sha256'], bundle['bytes'])
        bundles.append({**bundle, 'verificationMode': 'pinned-parent-complete-content-proof-plus-current-container-byte-equality',
                        'parentReceiptSha256': PARENT_RECEIPT_SHA, 'currentContainerBytesRechecked': True})
    default_digest = sha(data / 'Resources/unity default resources')
    require(default_digest == parent['unityDefaultResourcesSha256'], 'Native default resources changed')
    builtins = authenticate_builtin_extra(args.game, args.builtin_baseline)
    external = verify_external_materials(args.game, Path(__file__).with_name('source-effect-materials.26134529.json'))
    # These checks are repeated after all potentially long reads; no earlier
    # validation authorizes a receipt after the installed inputs are changed.
    authenticate_file(data / 'Managed/Assembly-CSharp.dll', TARGET_ASSEMBLY_SHA)
    authenticate_file(data / 'resources.assets', TARGET_RESOURCES_SHA)
    return {**parent, 'verifiedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'sourceBuildId': '26155610', 'sourceEvidenceSha256': sha(maps / 'game-build.26155610.json'),
            'sourceCatalogSha256': sha(maps / 'catalog.json'), 'maps': remapped,
            'targetBuildId': build, 'targetGameVersion': '3.1.0--logFile',
            'assembly': {'sha256': TARGET_ASSEMBLY_SHA, 'mvid': TARGET_MVID}, 'sceneOrder': order,
            'bundles': bundles, 'unityDefaultResourcesSha256': default_digest,
            'codeComparisons': code, 'externalBuiltins': builtins, 'externalMaterials': external,
            'transitiveVerification': {'parentTargetBuildId': '26155610', 'originalSourceBuildId': '26134529',
                'parentReceiptSha256': PARENT_RECEIPT_SHA, 'parentPlanSha256': PARENT_PLAN_SHA,
                'currentBundleContainersRehashed': 7, 'bundleExtractionRepeated': False,
                'derivativeRehashRepeated': False,
                'basis': 'Complete source/dependency/derivative proof inherited only through an exact pinned receipt and byte-identical bundle containers; current external dependencies and map-selection code separately re-audited.'},
            'limitations': [*parent['limitations'], 'The prior complete extraction and derivative proof is reused transitively; this run does not re-extract or rehash all derivative assets. Deployment still verifies every asset against the inherited plan.']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--maps', type=Path, required=True)
    parser.add_argument('--baseline-code', type=Path, required=True)
    parser.add_argument('--builtin-baseline', type=Path, required=True)
    parser.add_argument('--ilspycmd', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), 'Select a fresh receipt output')
    report = verify(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2); handle.write('\n')
    print(json.dumps({'verified': True, 'sourceBuildId': report['sourceBuildId'], 'targetBuildId': report['targetBuildId'],
                      'maps': len(report['maps']), 'sha256': sha(args.output), 'bundleExtractionRepeated': False}))

if __name__ == '__main__':
    main()
