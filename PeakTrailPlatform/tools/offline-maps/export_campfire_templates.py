"""Index complete native segmentCampfire renderer instances in the published GLBs.

Feed the private JSONL output to compile-campfire-nodes.mjs alongside the
verified published GLBs. The compiler checks mesh/submesh identities and every
instance multiplicity before emitting a compact public node/instance index.
"""
import argparse
import collections
import hashlib
import json
import struct
from pathlib import Path

from build_maps import Scene, pid


def native_translation(world):
    return [value or 0 for value in struct.unpack('<3f', struct.pack('<3f', *world[:3, 3]))]


def under_root(scene, target, ancestor):
    while target:
        if target == ancestor:
            return True
        transform = scene.read(scene.transform(target))
        parent = pid(transform['m_Father'])
        target = pid(scene.read(parent)['m_GameObject']) if parent else 0
    return False


def extract_template(scene, root):
    renderers, _, _ = scene.collect({
        '_segmentParent': {'m_PathID': root}, '_segmentCampfire': {'m_PathID': 0},
    })
    groups = collections.defaultdict(list)
    mesh_info = {}
    materials = {}
    for ptr, world, renderer in renderers:
        pointer = (ptr['m_FileID'], ptr['m_PathID'])
        if pointer not in mesh_info:
            native = scene.ptr(ptr).read()
            mesh_info[pointer] = (native.m_Name, native.m_VertexData.m_VertexCount,
                                  [sub.indexCount for sub in native.m_SubMeshes])
        name, vertex_count, counts = mesh_info[pointer]
        batch = renderer.get('m_StaticBatchInfo', {})
        first = batch.get('firstSubMesh', 0) if batch.get('subMeshCount') else 0
        count = batch.get('subMeshCount') or len(counts)
        if not vertex_count or not any(counts[first:first + count]):
            continue
        primitives = []
        slots = renderer['m_Materials']
        for i in range(first, min(first + count, len(counts))):
            if not counts[i]:
                continue
            mp = slots[min(i - first, len(slots) - 1)] if slots else {'m_FileID': 0, 'm_PathID': 0}
            key = (mp['m_FileID'], mp['m_PathID'])
            if key not in materials:
                materials[key] = scene.ptr(mp).deref().peek_name() if pid(mp) else 'Default'
            primitives.append((counts[i], materials[key]))
        groups[(name, vertex_count, tuple(primitives))].append(native_translation(world))
    return {'sourceRootName': scene.read(root)['m_Name'],
            'groups': [[name, vertex_count, primitives, sorted(values)]
                       for (name, vertex_count, primitives), values in sorted(groups.items())]}


def extract_map(scene, manifest, enclosure):
    chapters = []
    for stage, segment in scene.layers():
        if stage >= 4:
            continue
        root = pid(segment['_segmentCampfire'])
        if not root:
            raise ValueError(f'Missing native campfire root for {manifest["sceneName"]}/{stage}')
        template = extract_template(scene, root)
        if under_root(scene, root, enclosure['sourceRootPathId']):
            template['enclosureSha256'] = enclosure['geometrySha256']
        chapters.append([manifest['layers'][stage]['geometrySha256'], template])
    return {'mapPackId': manifest['mapPackId'], 'chapters': chapters}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', required=True, type=Path)
    parser.add_argument('--scenes', required=True, type=Path, help='Verified extracted scene tree from export_build.py')
    parser.add_argument('--maps', required=True, type=Path, help='PeakTrailPlatform/data/maps')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    builds = args.maps / 'verified-builds/26542162/manifests'
    receipt = json.loads((builds.parent / 'equivalence.json').read_text(encoding='utf-8'))
    if not receipt['verified'] or receipt['targetBuildId'] != '26542162':
        raise ValueError('Expected verified map build 26542162')
    source_files = {entry['sceneName']: entry['sceneFile'] for entry in receipt['maps']}
    index = json.loads((args.maps / 'enclosures.26542162.json').read_text(encoding='utf-8'))
    entries = {entry['mapPackId']: entry['enclosures'][0] for entry in index['maps']}
    rows = []
    for manifest_path in sorted(builds.glob('*/map-pack.json')):
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        path = args.scenes / source_files[manifest['sceneName']]
        with path.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != manifest['source']['sceneSha256']:
                raise ValueError(f'Scene identity mismatch: {path}')
        rows.append(extract_map(Scene(path, args.game), manifest, entries[manifest['mapPackId']]))
    if len(rows) != 208:
        raise ValueError('Expected all 208 verified 3.1 maps')
    with args.output.open('w', encoding='utf-8') as output:
        for row in rows:
            output.write(json.dumps(row, separators=(',', ':'), ensure_ascii=False, allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
