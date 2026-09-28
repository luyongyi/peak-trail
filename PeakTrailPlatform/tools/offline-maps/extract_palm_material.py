"""Extract reproducible palm/cutout shader evidence from the installed PEAK build.

Reads the game only. The default output is ignored local evidence; pass --output
explicitly to refresh the reviewed fixture beside this script.
"""
import argparse
import hashlib
import json
from pathlib import Path

import lz4.block
import numpy as np
import UnityPy
from UnityPy.classes import PPtr

from build_maps import game_info


BUILD_ID = 25306743
MATERIAL_NAME = 'M_Foliage_Palmtree 5'
SHADER_NAMES = {'GD/FoliageGD', 'W/Vine'}


def shader_evidence(obj):
    source = obj.read_typetree()
    parsed = source['m_ParsedForm']
    passes = []
    for sub_index, subshader in enumerate(parsed['m_SubShaders']):
        for pass_index, shader_pass in enumerate(subshader['m_Passes']):
            state = shader_pass['m_State']
            # m_NameIndices is the compiled pass parameter table, unlike the
            # material's saved properties, which retain obsolete shader fields.
            names = {index: name for name, index in shader_pass['m_NameIndices']}
            programs = {}
            for program in ('progVertex', 'progFragment'):
                common = shader_pass[program]['m_CommonParameters']
                programs[program] = {
                    'textures': [names[p['m_NameIndex']] for p in common['m_TextureParams']],
                    'constantBuffers': [
                        {'name': names[buffer['m_NameIndex']],
                         'vectorParameters': [names[p['m_NameIndex']] for p in buffer['m_VectorParams']]}
                        for buffer in common['m_ConstantBuffers']
                    ],
                }
            passes.append({
                'subShaderIndex': sub_index,
                'passIndex': pass_index,
                'name': state['m_Name'],
                'culling': state['culling'],
                'zWrite': state['zWrite'],
                'zTest': state['zTest'],
                'rtBlend0': state['rtBlend0'],
                'compiledParameterNames': sorted(names.values()),
                'commonParameters': programs,
            })
    blobs = []
    compressed = bytes(source['compressedBlob'])
    for platform, offsets, lengths, decoded_lengths in zip(
        source['platforms'], source['offsets'], source['compressedLengths'], source['decompressedLengths']
    ):
        for segment, (offset, length, decoded_length) in enumerate(zip(offsets, lengths, decoded_lengths)):
            decoded = lz4.block.decompress(compressed[offset:offset + length], uncompressed_size=decoded_length)
            blobs.append({
                'platform': platform,
                'segment': segment,
                'decodedBytes': len(decoded),
                'decodedSha256': hashlib.sha256(decoded).hexdigest(),
                'shapeOccurrences': decoded.count(b'_Shape'),
                'shapeSTOccurrences': decoded.count(b'_Shape_ST'),
            })
    return {
        'name': parsed['m_Name'],
        'sourceFile': obj.assets_file.name,
        'pathId': obj.path_id,
        'declaredProperties': [{'name': p['m_Name'], 'type': p['m_Type'], 'flags': p['m_Flags']}
                               for p in parsed['m_PropInfo']['m_Props']],
        'passes': passes,
        'compiledBlobs': blobs,
    }


def extract(game):
    if int(game_info(game)[2]) != BUILD_ID:
        raise RuntimeError(f'This evidence extractor is pinned to Steam build {BUILD_ID}')
    data = game / 'PEAK_Data'
    env = UnityPy.load(str(data / 'sharedassets1.assets'))
    material_obj = next(obj for obj in env.objects if obj.type.name == 'Material'
                        and obj.read_typetree()['m_Name'] == MATERIAL_NAME)
    material = material_obj.read_typetree()
    saved = material['m_SavedProperties']
    shader_ptr = material['m_Shader']
    shader = PPtr(m_FileID=shader_ptr['m_FileID'], m_PathID=shader_ptr['m_PathID'],
                  assetsfile=material_obj.assets_file).deref()
    properties = {p['m_Name']: p for p in shader.read_typetree()['m_ParsedForm']['m_PropInfo']['m_Props']}
    shape = dict(saved['m_TexEnvs'])['_Shape']
    texture_ptr = shape['m_Texture']
    texture_obj = PPtr(m_FileID=texture_ptr['m_FileID'], m_PathID=texture_ptr['m_PathID'],
                       assetsfile=material_obj.assets_file).deref()
    texture = texture_obj.read()
    pixels = np.asarray(texture.image.convert('RGBA'))
    texture_data = texture_obj.read_typetree()
    shader_env = UnityPy.load(str(data / 'globalgamemanagers.assets'))
    shaders = []
    for obj in shader_env.objects:
        if obj.type.name == 'Shader' and obj.read_typetree().get('m_ParsedForm', {}).get('m_Name') in SHADER_NAMES:
            shaders.append(shader_evidence(obj))
    if {s['name'] for s in shaders} != SHADER_NAMES:
        raise RuntimeError('Missing required shader evidence')
    relevant_floats = ('_AlphaClip', '_Cull', '_FlipLightOnbackFaces', '_TextureInfluence',
                       '_UVWindAmount', '_UVWorldOffset', '_UseSimpleMask', '_VertexAOAmount')
    return {
        'gameBuildId': BUILD_ID,
        'note': 'Direct installed-game shader/material evidence. Saved _Cull and _Shape scale/offset '
                'are not proof of runtime use. Both compiled shaders have fixed Cull Off and no '
                '_Shape_ST parameter in any pass or decoded program blob. Their _Shape cutout uses '
                'mesh UV rather than the saved texture transform. The palm has zero UV wind/world offset.',
        'materials': [{
            'name': material['m_Name'],
            'shader': 'GD/FoliageGD',
            'sourceFile': material_obj.assets_file.name,
            'pathId': material_obj.path_id,
            'colors': {name: {'rgba': [value[k] for k in 'rgba'], 'flags': properties[name]['m_Flags']}
                       for name, value in saved['m_Colors'] if name in ('_Tint', '_BaseColor')},
            'floats': {name: {'value': value, 'shaderDeclared': name in properties}
                       for name, value in saved['m_Floats'] if name in relevant_floats},
            'shapeTexture': {
                'property': '_Shape', 'savedScale': [shape['m_Scale'][k] for k in 'xy'],
                'savedOffset': [shape['m_Offset'][k] for k in 'xy'],
                'name': texture.m_Name, 'sourceFile': texture_obj.assets_file.name,
                'pathId': texture_obj.path_id, 'width': texture.m_Width, 'height': texture.m_Height,
                'textureSettings': texture_data['m_TextureSettings'],
                'rgbaSha256': hashlib.sha256(pixels.tobytes()).hexdigest(),
                'alphaMinimum': int(pixels[:, :, 3].min()), 'alphaMaximum': int(pixels[:, :, 3].max()),
                'alphaCoverageAtHalf': float(np.mean(pixels[:, :, 3] >= 128)),
            },
        }],
        'shaders': sorted(shaders, key=lambda s: s['name']),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[3]
                        / f'local/assets/evidence/source-palm-material.{BUILD_ID}.json')
    args = parser.parse_args()
    evidence = extract(args.game)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    print(f'{len(evidence["materials"])} material, {len(evidence["shaders"])} shaders: {args.output}')


if __name__ == '__main__':
    main()
