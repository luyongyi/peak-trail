"""Authenticate unchanged map inputs before assigning a *new* build identity.

This is deliberately separate from export_build.py: it never rewrites a pack,
changes a catalog, or silently accepts a build mismatch. The report authorizes
reuse of static derivatives only after the complete prior build is authenticated.
Raw game files and private decompiled source are not included in the report.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from concurrent.futures import ProcessPoolExecutor
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess


AUTHORITY = 'verified-map-build-equivalence'
SHA256 = re.compile(r'^[a-f0-9]{64}$')
PACK_ID = re.compile(r'^sha256-[a-f0-9]{64}$')
SCENE_PATH = re.compile(r'^Assets/8_SCENES/Generated/(Level_\d+)\.unity$')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def sha(path):
    require(path.is_file() and not path.is_symlink(), f'Expected regular source file: {path}')
    before = path.stat()
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    after = path.stat()
    require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns),
            f'Source changed while being authenticated: {path}')
    return digest


def safe_child(root, reference):
    require(isinstance(reference, str) and reference and '\\' not in reference
            and not reference.startswith('/') and ':' not in reference
            and all(part not in ('', '.', '..') for part in reference.split('/')),
            f'Unsafe source reference: {reference!r}')
    root = root.resolve()
    candidate = root
    for part in reference.split('/'):
        candidate = candidate / part
        require(not candidate.is_symlink(), f'Symbolic source path is unsupported: {candidate}')
    require(candidate.resolve().is_relative_to(root), f'Source escapes its root: {reference}')
    return candidate


def authenticate_file(path, digest, size=None):
    require(isinstance(digest, str) and SHA256.fullmatch(digest), f'Invalid expected SHA-256: {path}')
    if size is not None:
        require(path.is_file() and path.stat().st_size == size, f'Source size differs: {path}')
    require(sha(path) == digest, f'Source SHA-256 differs: {path}')


def source_entries(catalog, evidence):
    require(evidence.get('schemaVersion') == 1 and evidence.get('authority') == 'installed-game-assets-and-serialized-map-baker',
            'Expected complete installed-game map evidence with native MapBaker order')
    source_build = str(evidence['gameBuildId'])
    require(re.fullmatch(r'[1-9]\d*', source_build), 'Invalid source build ID')
    count = evidence['sceneCount']
    require(isinstance(count, int) and count > 0 and len(evidence['maps']) == count,
            'Source evidence must enumerate the complete scene set')
    maps = {item['sceneName']: item for item in evidence['maps']}
    require(len(maps) == count and set(maps) == {f'Level_{slot}' for slot in range(count)},
            'Source scene names must be unique and complete')
    for slot in range(count):
        item = maps[f'Level_{slot}']
        require(item['mapSlot'] == slot and item['scenePath'] == f'Assets/8_SCENES/Generated/Level_{slot}.unity'
                and PACK_ID.fullmatch(item['mapPackId']) and SHA256.fullmatch(item['sceneSha256']),
                'Source scene order or identity evidence is invalid')
    require(catalog.get('schemaVersion') == 1, 'Invalid source catalog schema')
    entries = [entry for entry in catalog['mapPacks'] if entry.get('enabled', True)
               and str(entry['gameBuildId']) == source_build]
    require(len(entries) == count and {entry['sceneName'] for entry in entries} == set(maps),
            'Source catalog must contain exactly one enabled pack for every source scene')
    require(len({entry['mapPackId'] for entry in entries}) == count, 'Duplicate source pack identity')
    for entry in entries:
        old = maps[entry['sceneName']]
        require(entry['mapSlot'] == old['mapSlot'] and entry['mapPackId'] == old['mapPackId']
                and entry.get('path') == f"./packs/{old['mapPackId']}/map-pack.json",
                'Source catalog differs from its complete-build evidence')
    return sorted(entries, key=lambda value: value['mapSlot']), maps


def parse_scene_order(raw, order, expected):
    require(hashlib.sha256(raw).hexdigest() == order['objectSha256'],
            'Native MapBaker object changed; cross-build reuse requires a fresh source review')
    offset = order['firstArrayOffsetBytes']
    require(isinstance(offset, int) and 0 <= offset <= len(raw) - 4, 'Invalid ScenePaths array offset')
    count, = struct.unpack_from('<i', raw, offset)
    require(count == len(expected) == order['count'], 'Native ScenePaths cardinality changed')
    offset += 4
    paths = []
    for _ in range(count):
        require(offset + 4 <= len(raw), 'Truncated ScenePaths string length')
        length, = struct.unpack_from('<i', raw, offset)
        offset += 4
        require(0 < length <= 1024 and offset + length <= len(raw), 'Invalid ScenePaths string')
        value = raw[offset:offset + length].decode('utf8')
        require(SCENE_PATH.fullmatch(value), 'Unrecognized native ScenePaths member')
        paths.append(value)
        offset = (offset + length + 3) & ~3
    require(paths == expected, 'Native ScenePaths order changed')
    return paths


def dependency_name(reference, names):
    """Resolve Unity archive references only inside this authenticated bundle."""
    require(isinstance(reference, str) and '\\' not in reference and '\0' not in reference,
            'Invalid serialized dependency reference')
    if reference == 'Library/unity default resources':
        return 'unity default resources'
    if reference.startswith('archive:/'):
        parts = reference[len('archive:/'):].split('/')
    else:
        parts = reference.split('/')
    require(parts and all(part and part not in ('.', '..') and ':' not in part for part in parts),
            f'Unsafe serialized dependency: {reference}')
    name = parts[-1]
    require(name in names, f'Dependency is outside authenticated bundle closure: {reference}')
    return name


@contextmanager
def serialized_file(path):
    # A stream reader visits metadata/object ranges without reading a GiB asset
    # into one bytes object. Imports are lazy so fixture tests need no UnityPy.
    from UnityPy.enums import FileType
    from UnityPy.files import SerializedFile
    from UnityPy.helpers.ImportHelper import check_file_type
    with path.open('rb') as stream:
        kind, reader = check_file_type(stream)
        yield SerializedFile(reader, name=path.name) if kind == FileType.AssetsFile else None


def inspect_dependencies(path, names, builtin_audit=None):
    references = set()
    serialized_count = streamed_objects = 0
    with serialized_file(path) as value:
        if value is None:
            return references, serialized_count, streamed_objects
        serialized_count = 1
        for external in value.externals:
            if external.path == 'Resources/unity_builtin_extra':
                require(builtin_audit is not None and builtin_audit.get('allObjectsEqual') is True,
                        'unity_builtin_extra requires authenticated object-level baseline evidence')
                references.add('Resources/unity_builtin_extra')
                continue
            references.add(dependency_name(external.path, names))
        # Texture and mesh streaming paths are not FileIdentifier entries.
        # They must also terminate in an authenticated bundle member.
        for obj in value.objects.values():
            if obj.type.name not in ('Mesh', 'Texture2D'):
                continue
            native = obj.read(check_read=False)
            info = getattr(native, 'm_StreamData', None)
            if info is None:
                continue
            size = getattr(info, 'size', 0)
            reference = getattr(info, 'path', '')
            if not size:
                continue
            require(reference, f'Nonempty streamed geometry/image has no resource path: {path.name}')
            references.add(dependency_name(reference, names))
            streamed_objects += 1
    return references, serialized_count, streamed_objects


def verify_unityfs_contents(bundle, expected_files):
    """Rehash actual decompressed members, never trusting cache self-attestation."""
    from UnityPy.enums import ArchiveFlags, CompressionFlags
    from UnityPy.helpers import CompressionHelper
    from UnityPy.streams import EndianBinaryReader
    before = bundle.stat()
    expected = {item['name']: item for item in expected_files}
    require(len(expected) == len(expected_files), 'Duplicate expected UnityFS member')
    with bundle.open('rb') as stream:
        reader = EndianBinaryReader(stream)
        require(reader.read_string_to_null() == 'UnityFS', 'Expected an unencrypted UnityFS bundle')
        version = reader.read_u_int()
        reader.read_string_to_null()  # player version
        reader.read_string_to_null()  # engine version
        declared_size = reader.read_long()
        compressed_size, uncompressed_size, flags = (reader.read_u_int() for _ in range(3))
        require(version >= 7 and declared_size == before.st_size, 'Unexpected UnityFS size/version')
        require(not flags & ArchiveFlags.UsesAssetBundleEncryption, 'Encrypted UnityFS input is unsupported')
        reader.align_stream(16)
        start = reader.Position
        if flags & ArchiveFlags.BlocksInfoAtTheEnd:
            reader.Position = reader.Length - compressed_size
        compressed = reader.read_bytes(compressed_size)
        metadata = CompressionHelper.DECOMPRESSION_MAP[CompressionFlags(flags & 0x3f)](compressed, uncompressed_size)
        if flags & ArchiveFlags.BlocksInfoAtTheEnd:
            reader.Position = start
        info = EndianBinaryReader(metadata)
        info.read_bytes(16)
        blocks = [(info.read_u_int(), info.read_u_int(), info.read_u_short()) for _ in range(info.read_int())]
        entries = sorted((info.read_long(), info.read_long(), info.read_u_int(), info.read_string_to_null())
                         for _ in range(info.read_int()))
        require({name for _, _, _, name in entries} == set(expected)
                and len(entries) == len(expected), 'UnityFS member set differs from extraction evidence')
        previous_end = 0
        total_bytes = sum(block[0] for block in blocks)
        for offset, size, _, name in entries:
            require('/' not in name and '\\' not in name and name not in ('.', '..')
                    and offset >= previous_end and size == expected[name]['bytes'] and size >= 0
                    and offset + size <= total_bytes, 'Unsafe, overlapping or changed UnityFS member')
            previous_end = offset + size
        if flags & ArchiveFlags.BlockInfoNeedPaddingAtStart:
            reader.align_stream(16)
        hashes = {name: hashlib.sha256() for name in expected}
        written = {name: 0 for name in expected}
        position = 0
        for raw_size, packed_size, block_flags in blocks:
            require(raw_size <= 256 * 1024 * 1024, 'UnityFS block exceeds bounded verifier memory')
            raw = CompressionHelper.DECOMPRESSION_MAP[CompressionFlags(block_flags & 0x3f)](
                reader.read_bytes(packed_size), raw_size)
            require(len(raw) == raw_size, 'Decompressed UnityFS block length mismatch')
            for offset, size, _, name in entries:
                lo, hi = max(position, offset), min(position + raw_size, offset + size)
                if lo < hi:
                    hashes[name].update(memoryview(raw)[lo - position:hi - position])
                    written[name] += hi - lo
            position += raw_size
        for name, item in expected.items():
            require(written[name] == item['bytes'] and hashes[name].hexdigest() == item['sha256'],
                    f'Actual UnityFS member differs from authenticated cache evidence: {name}')
    after = bundle.stat()
    require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns),
            'UnityFS bundle changed during member verification')


def authenticate_bundle(game_data, cache_root, bundle, default_digest, builtin_audit=None):
    source = safe_child(game_data, bundle['file'])
    authenticate_file(source, bundle['sha256'])
    root = safe_child(cache_root, source.stem)
    evidence_path = root / 'extraction-evidence.json'
    evidence = load_json(evidence_path)
    require(evidence.get('schemaVersion') == 1 and evidence['sourceBundle'] == source.name
            and evidence['sourceBundleSha256'] == bundle['sha256'], 'Cache is not bound to the authenticated installed bundle')
    files = evidence['files']
    names = {item['name'] for item in files}
    require(files and len(names) == len(files), 'Duplicate or empty bundle extraction evidence')
    require(all('/' not in name and name not in ('unity default resources', 'extraction-evidence.json') for name in names),
            'Only unambiguous bundle member basenames are supported')
    require(sum(item['bytes'] for item in files) == bundle['extractedBytes'],
            'Bundle extraction evidence is incomplete')
    # The old cache is only a convenience. Bind its *complete* hashes to the
    # current compressed source itself before accepting any metadata parsed
    # from it; a forged cache evidence file cannot establish equivalence.
    verify_unityfs_contents(source, files)
    paths = {}
    for item in files:
        path = safe_child(root, item['name'])
        authenticate_file(path, item['sha256'], item['bytes'])
        paths[item['name']] = path
    default = root / 'unity default resources'
    authenticate_file(default, default_digest)
    references = set()
    serialized_count = streamed_objects = 0
    for name, path in paths.items():
        deps, count, streams = inspect_dependencies(path, names, builtin_audit)
        references.update(deps)
        serialized_count += count
        streamed_objects += streams
    # Built-in meshes/materials are the only permitted input outside a bundle.
    default_deps, _, default_streams = inspect_dependencies(default, names, builtin_audit)
    require(not default_deps and default_streams == 0,
            'Unity built-in resource file has unreviewed dependencies')
    return {'file': bundle['file'], 'sha256': bundle['sha256'], 'bytes': source.stat().st_size,
            'extractedBytes': bundle['extractedBytes'], 'extractionEvidenceSha256': sha(evidence_path),
            'bundleContentsVerified': True,
            'memberCount': len(files), 'serializedFiles': serialized_count, 'streamedGeometryAndTextures': streamed_objects,
            'dependencies': sorted(references)}, {name: item for name, item in zip((item['name'] for item in files), files)}


def authenticate_bundles(game_data, cache_root, bundles, default_digest, builtin_audit, jobs=1,
                         worker=authenticate_bundle):
    """Read disjoint bundles in bounded workers; publish results in input order."""
    require(isinstance(jobs, int) and 1 <= jobs <= 3, 'Bundle verifier jobs must be 1, 2 or 3')
    if jobs == 1:
        for bundle in bundles:
            yield worker(game_data, cache_root, bundle, default_digest, builtin_audit)
        return
    with ProcessPoolExecutor(max_workers=jobs) as executor:
        pending = [executor.submit(worker, game_data, cache_root, bundle, default_digest, builtin_audit)
                   for bundle in bundles]
        try:
            for future in pending:
                yield future.result()
        except BaseException:
            for future in pending:
                future.cancel()
            raise


def verify_manifest_assets(entry, source_map, source_build, source_version, packs, builtin_audit=None):
    root = safe_child(packs, entry['mapPackId'])
    manifest_path = root / 'map-pack.json'
    value = load_json(manifest_path)
    require(value.get('identityVersion') == 3 and value.get('schemaVersion') == 1
            and value['mapPackId'] == entry['mapPackId'] and value['sceneName'] == source_map['sceneName']
            and value['mapSlot'] == source_map['mapSlot'] and str(value['gameBuildId']) == source_build
            and value['gameVersion'] == source_version and value['source']['sceneSha256'] == source_map['sceneSha256']
            and value['source']['sceneFile'] == source_map['sceneFile'], 'Source pack is not bound to the authenticated source scene/build')
    count = total = 0
    for layer in value['layers']:
        for key in ('texture', 'height', 'geometry'):
            path = safe_child(root, layer[key])
            authenticate_file(path, layer[key + 'Sha256'])
            if key == 'geometry' and builtin_audit is not None:
                # PreloadData and compiled shader fallbacks mention built-ins,
                # but the exporter reads only the primary shader properties.
                # Prove that none of those external shader objects supplied an
                # exported material, rather than allowing the file by name.
                opener = gzip.open if path.name.endswith('.gz') else open
                with opener(path, 'rb') as glb:
                    header = glb.read(20)
                    require(len(header) == 20 and header[:4] == b'glTF' and header[16:20] == b'JSON',
                            'Expected embedded GLB JSON metadata')
                    length, = struct.unpack_from('<I', header, 12)
                    require(length <= 128 * 1024 * 1024, 'GLB JSON exceeds metadata budget')
                    tree = json.loads(glb.read(length))
                forbidden = {item['shader'] for item in builtin_audit['objects']}
                for material in tree.get('materials', []):
                    metadata = material.get('extras', {}).get('peakTerrain', {}).get('sourceColors', {})
                    shader = metadata.get('shader')
                    require(shader or material.get('name') == 'Default',
                            'Missing exported primary-shader provenance')
                    require(shader not in forbidden,
                            f'Exported material consumes external built-in shader; fresh source review required: {shader}')
            count += 1
            total += path.stat().st_size
    return value, sha(manifest_path), count, total


def authenticate_builtin_extra(game, baseline):
    require(baseline is not None, 'Supply --builtin-baseline for authenticated unity_builtin_extra object comparison')
    evidence_path = baseline / 'extraction-evidence.json'
    evidence = load_json(evidence_path)
    candidates = [item for item in evidence['files'] if item['name'] == 'Resources/unity_builtin_extra']
    require(evidence.get('schemaVersion') == 1 and len(candidates) == 1,
            'Baseline extraction evidence must bind unity_builtin_extra')
    old_path = baseline / 'Resources/unity_builtin_extra'
    authenticate_file(old_path, candidates[0]['sha256'], candidates[0]['bytes'])
    current_path = game / 'PEAK_Data/Resources/unity_builtin_extra'
    objects = []
    with serialized_file(old_path) as old, serialized_file(current_path) as current:
        require(old is not None and current is not None and not old.externals and not current.externals,
                'Built-in shader file has unreviewed external dependencies')
        require(old.objects and set(old.objects) == set(current.objects), 'Built-in shader object inventory changed')
        for path_id, obj in current.objects.items():
            require(obj.type.name == old.objects[path_id].type.name == 'Shader',
                    'unity_builtin_extra contains geometry, images or unreviewed object types')
            raw = obj.get_raw_data()
            require(raw == old.objects[path_id].get_raw_data(), 'Built-in shader object changed')
            tree = obj.read_typetree()
            objects.append({'pathId': str(path_id), 'shader': tree['m_ParsedForm']['m_Name'],
                            'sha256': hashlib.sha256(raw).hexdigest(), 'equal': True})
    return {'file': 'Resources/unity_builtin_extra', 'sha256': sha(current_path),
            'baselineBuildId': baseline.parent.name, 'baselineFileSha256': sha(old_path),
            'baselineExtractionEvidenceSha256': sha(evidence_path), 'allObjectsEqual': True, 'objects': objects,
            'scope': 'All raw Shader objects match the authenticated archived baseline; container metadata differs. '
                     'Every reused GLB separately excludes these shaders as a primary source. Preload and compiled fallback references do not feed the static exporter.'}


def verify_external_materials(game, evidence_path):
    from contextlib import ExitStack
    expected = load_json(evidence_path)
    data = game / 'PEAK_Data'
    rows = []
    def canonical(value):
        # UnityPy emits tuple pairs and float-typed enum constants; JSON's
        # arrays and numeric 1/1.0 represent the same saved render state.
        return json.loads(json.dumps(value))
    with ExitStack() as stack:
        files = {name: stack.enter_context(serialized_file(data / name)) for name in expected['serializedInputSha256']}
        for want in expected['materials']:
            obj = files[want['sourceFile']].objects[want['pathId']]
            material = obj.read_typetree()
            pointer = material['m_Shader']
            shader_source = want['sourceFile'] if pointer['m_FileID'] == 0 else Path(
                files[want['sourceFile']].externals[pointer['m_FileID'] - 1].path).name
            require(shader_source == want['shaderSourceFile'] and pointer['m_PathID'] == want['shaderPathId'],
                    'Native material is bound to a different shader object')
            shader_obj = files[want['shaderSourceFile']].objects[want['shaderPathId']]
            shader = shader_obj.read_typetree()['m_ParsedForm']
            require(material['m_Name'] == want['name'] and shader['m_Name'] == want['shader'], 'Native effect material identity changed')
            shader_digest = hashlib.sha256(shader_obj.get_raw_data()).hexdigest()
            require(shader_digest == want['shaderObjectSha256'], f'Native effect shader changed: {want["name"]}')
            props = {item['m_Name']: item['m_Flags'] for item in shader['m_PropInfo']['m_Props']}
            colors = dict(material['m_SavedProperties']['m_Colors'])
            floats = dict(material['m_SavedProperties']['m_Floats'])
            require(props == want['shaderProperties'], f'Effect shader property declarations changed: {want["name"]}')
            for key, value in want['colors'].items():
                require([colors[key][channel] for channel in 'rgba'] == value['rgba'] and props[key] == value['flags'],
                        f'Effect material color/flags changed: {want["name"]}/{key}')
            for key, value in want['floats'].items():
                require(floats[key] == value, f'Effect material scalar changed: {want["name"]}/{key}')
            state = next(item['m_State'] for item in shader['m_SubShaders'][0]['m_Passes'] if item['m_State']['m_Name'] == 'Forward')
            require(canonical({key: state[key] for key in want['passState']}) == canonical(want['passState']),
                    f'Effect material render state changed: {want["name"]}')
            rows.append({'name': want['name'], 'sourceFile': want['sourceFile'], 'pathId': want['pathId'],
                         'materialObjectSha256': hashlib.sha256(obj.get_raw_data()).hexdigest(),
                         'shaderSourceFile': want['shaderSourceFile'], 'shaderPathId': want['shaderPathId'],
                         'shaderObjectSha256': shader_digest, 'equal': True,
                         'verifiedFields': ['name', 'shader', 'colors', 'floats', 'shaderProperties', 'passState', 'shaderObjectSha256']})
    return {'sourceEvidenceSha256': sha(evidence_path), 'materials': rows,
            'currentInputSha256': {name: sha(data / name) for name in expected['serializedInputSha256']}}


def verify_canonical_identities(manifests):
    module = Path(__file__).resolve().parents[1] / 'lib/map-pack-identity.mjs'
    program = """import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const {verifyMapPackIdentity} = await import(pathToFileURL(process.argv[1]).href);
for (const manifest of JSON.parse(readFileSync(0, 'utf8'))) verifyMapPackIdentity(manifest);
"""
    subprocess.run(['node', '--input-type=module', '-e', program, str(module)],
                   input=json.dumps(manifests), text=True, check=True, capture_output=True)


def normalize_source(value):
    return value.replace('\r\n', '\n').rstrip()


def compare_native_code(game, baseline, ilspycmd):
    comparisons = []
    assembly = game / 'PEAK_Data/Managed/Assembly-CSharp.dll'
    for name in ('MapBaker', 'MapHandler'):
        old_path = safe_child(baseline, name + '.cs')
        old = normalize_source(old_path.read_text(encoding='utf-8-sig'))
        result = subprocess.run([ilspycmd, '-t', name, str(assembly)], check=True, capture_output=True, text=True)
        new = normalize_source(result.stdout)
        require(old == new, f'Audited native {name} code differs; review runtime map selection/transform behavior')
        comparisons.append({'type': name, 'comparison': 'normalized-decompiled-text',
                            'sha256': hashlib.sha256(new.encode('utf8')).hexdigest(),
                            'baselineFileSha256': sha(old_path), 'equal': True})
    return comparisons


def read_native_identity(game, evidence):
    import UnityPy
    data = game / 'PEAK_Data'
    native = UnityPy.load(str(data / 'globalgamemanagers'))
    player = next(obj.read_typetree(check_read=False) for obj in native.objects if obj.type.name == 'PlayerSettings')
    steam = game.parent.parent / 'appmanifest_3527290.acf'
    match = re.search(r'"buildid"\s+"([1-9]\d*)"', steam.read_text(encoding='utf8'))
    require(match, 'Installed Steam build identity is missing')
    build = match.group(1)
    order = evidence['sceneOrder']
    require(order['assetFile'] == 'resources.assets' and order['componentClass'] == 'MapBaker'
            and order['field'] == 'ScenePaths', 'Unsupported MapBaker source-order evidence')
    with serialized_file(data / 'resources.assets') as resource:
        require(resource is not None, 'Native resources.assets is not serialized')
        raw = resource.objects[int(order['pathId'])].get_raw_data()
    paths = parse_scene_order(raw, order, [item['scenePath'] for item in sorted(evidence['maps'], key=lambda item: item['mapSlot'])])
    # A new assembly identity is recorded; no old MVID or static-root assertion
    # is propagated to the new landmark sidecar.
    assembly = (data / 'Managed/Assembly-CSharp.dll').resolve()
    literal = str(assembly).replace("'", "''")
    command = f"$a=[System.Reflection.Assembly]::LoadFile('{literal}'); $a.ManifestModule.ModuleVersionId.ToString('N')"
    mvid = subprocess.run(['powershell.exe', '-NoProfile', '-Command', command], check=True, capture_output=True, text=True).stdout.strip()
    require(re.fullmatch(r'[a-f0-9]{32}', mvid), 'Could not read current managed assembly MVID')
    return build, player['bundleVersion'], {'sha256': sha(assembly), 'mvid': mvid}, {
        **order, 'assetSha256': sha(data / 'resources.assets'), 'scenePaths': paths,
        'objectSha256': hashlib.sha256(raw).hexdigest(), 'equal': True}


def verify(args):
    evidence = load_json(args.source_evidence)
    catalog = load_json(args.source_catalog)
    entries, maps = source_entries(catalog, evidence)
    source_build = str(evidence['gameBuildId'])
    target_build, version, assembly, order = read_native_identity(args.game, evidence)
    require(target_build != source_build, 'Source and target build IDs must differ')
    code = compare_native_code(args.game, args.baseline_code, args.ilspycmd)
    builtin_audit = authenticate_builtin_extra(args.game, args.builtin_baseline)
    external_materials = verify_external_materials(args.game, Path(__file__).with_name(f'source-effect-materials.{source_build}.json'))
    bundles = evidence['bundles']
    require(bundles and len({item['file'] for item in bundles}) == len(bundles), 'Invalid source bundle evidence')
    installed = {str(path.relative_to(args.game / 'PEAK_Data')).replace('\\', '/')
                 for path in (args.game / 'PEAK_Data/StreamingAssets/maps').glob('levels*.assetbundle')}
    require(installed == {item['file'] for item in bundles}, 'Installed bundle set differs from source evidence')
    actual_sources = {}
    for item in bundles:
        path = safe_child(args.game / 'PEAK_Data', item['file'] + '.manifest')
        names = re.findall(r'^- (Assets/8_SCENES/Generated/Level_\d+\.unity)\s*$', path.read_text(encoding='utf8'), re.MULTILINE)
        require(names, 'Bundle has no recognized scene membership')
        for name in names:
            require(name not in actual_sources, 'Duplicate installed scene membership')
            actual_sources[name] = Path(item['file']).name
    require(set(actual_sources) == {item['scenePath'] for item in maps.values()}, 'Installed scene set changed')
    for item in maps.values():
        require(actual_sources[item['scenePath']] == item['bundle'], 'Installed scene changed bundle membership')
    default_digest = sha(args.game / 'PEAK_Data/Resources/unity default resources')
    verified_bundles, members = [], {}
    results = authenticate_bundles(args.game / 'PEAK_Data', args.source_cache, bundles,
                                   default_digest, builtin_audit, args.jobs)
    for index, (result, files) in enumerate(results):
        bundle = bundles[index]
        verified_bundles.append(result)
        members[Path(bundle['file']).stem] = files
        print(f'VERIFIED BUNDLE {index + 1}/{len(bundles)} {Path(bundle["file"]).name}', flush=True)
    manifests, verified_maps = [], []
    for entry in entries:
        item = maps[entry['sceneName']]
        parent, filename = item['sceneFile'].split('/')
        member = members.get(parent, {}).get(filename)
        require(member is not None and member['sha256'] == item['sceneSha256'] and member['bytes'] == item['bytes'],
                'Source scene is absent from the authenticated extraction')
        manifest, manifest_hash, count, size = verify_manifest_assets(entry, item, source_build, evidence['gameVersion'], args.source_packs, builtin_audit)
        manifests.append(manifest)
        verified_maps.append({'sceneName': item['sceneName'], 'mapSlot': item['mapSlot'],
                              'sourceSceneSha256': item['sceneSha256'], 'sourceMapPackId': item['mapPackId'],
                              'sourceManifestSha256': manifest_hash, 'derivativeFiles': count, 'derivativeBytes': size,
                              'bundle': item['bundle'], 'sceneFile': item['sceneFile']})
    verify_canonical_identities(manifests)
    # Detect a Steam update that occurred during this lengthy proof.
    current, current_version, current_assembly, _ = read_native_identity(args.game, evidence)
    require((current, current_version, current_assembly) == (target_build, version, assembly),
            'Installed game changed while equivalence was being proved')
    return {'schemaVersion': 1, 'authority': AUTHORITY, 'verified': True,
            'verifiedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'sourceBuildId': source_build, 'targetBuildId': target_build, 'targetGameVersion': version,
            'sourceEvidenceSha256': sha(args.source_evidence), 'sourceCatalogSha256': sha(args.source_catalog),
            'assembly': assembly, 'sceneOrder': order, 'bundles': verified_bundles, 'maps': verified_maps,
            'unityDefaultResourcesSha256': default_digest, 'codeComparisons': code,
            'externalBuiltins': builtin_audit, 'externalMaterials': external_materials,
            'scope': 'Static serialized map meshes, textures, transforms and source-bound sidecar data only.',
            'limitations': ['Current managed assembly differs and is recorded independently; this is not full game-code equivalence.',
                            'Private archived decompilations are comparison baselines; their contents are not published.',
                            'Do not propagate previous assembly MVID, expectedLegacyLayoutKey or static-root policy.',
                            'Reused derivatives require newly computed target-build canonical identities and rebinding of every sidecar.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--source-evidence', type=Path, required=True)
    parser.add_argument('--source-catalog', type=Path, required=True)
    parser.add_argument('--source-packs', type=Path, required=True)
    parser.add_argument('--source-cache', type=Path, required=True)
    parser.add_argument('--baseline-code', type=Path, required=True)
    parser.add_argument('--builtin-baseline', type=Path, required=True,
                        help='Authenticated archived PEAK_Data containing Resources/unity_builtin_extra and extraction-evidence.json')
    parser.add_argument('--ilspycmd', default='ilspycmd')
    parser.add_argument('--jobs', type=int, choices=(1, 2, 3), default=1,
                        help='Read-only bundle verification processes (default 1, maximum 3)')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), 'Select a fresh report output; an older proof must not survive a failed run')
    report = verify(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # The receipt is SHA-256-pinned and tracked; keep its bytes stable on Windows and Linux.
    with args.output.open('x', encoding='utf8', newline='\n') as output:
        output.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f'VERIFIED COMPLETE BUILD {report["sourceBuildId"]} -> {report["targetBuildId"]}: {len(report["maps"])} maps', flush=True)


if __name__ == '__main__':
    main()
