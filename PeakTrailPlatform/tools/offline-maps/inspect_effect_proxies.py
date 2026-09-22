"""Read audited depth-decal source facts; no game scripts or private logs run."""
import argparse
import json
from pathlib import Path
import UnityPy
from UnityPy.classes import PPtr
from build_maps import game_info

NAMES = {'M_VFX_PetrifyDecal', 'M_VFX_FireballDecal'}


def inspect(game):
    _, version, build = game_info(game)
    env = UnityPy.load(str(game / 'PEAK_Data/sharedassets4.assets'))
    facts = []
    for obj in env.objects:
        if obj.type.name != 'Material':
            continue
        material = obj.read_typetree()
        if material['m_Name'] not in NAMES:
            continue
        pointer = material['m_Shader']
        shader = PPtr(m_FileID=pointer['m_FileID'], m_PathID=pointer['m_PathID'],
                      assetsfile=obj.assets_file).read_typetree()['m_ParsedForm']
        forward = next(p['m_State'] for p in shader['m_SubShaders'][0]['m_Passes'] if p['m_State']['m_Name'] == 'Forward')
        facts.append({'material': material['m_Name'], 'asset': obj.assets_file.name,
                      'pathId': obj.path_id, 'shader': shader['m_Name'],
                      'forward': {'srcBlend': forward['rtBlend0']['srcBlend']['val'],
                                  'dstBlend': forward['rtBlend0']['destBlend']['val'],
                                  'zWrite': forward['zWrite']['val'],
                                  'cull': forward['culling']['val'],
                                  'tags': dict(forward['m_Tags']['tags'])},
                      'opacity': dict(material['m_SavedProperties']['m_Floats']).get('_Opacity')})
    if {fact['material'] for fact in facts} != NAMES:
        raise ValueError('Both audited materials must exist; do not extend the policy to another build by guesswork')
    return {'gameBuildId': str(build), 'gameVersion': version, 'materials': sorted(facts, key=lambda f: f['material'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    args = parser.parse_args()
    print(json.dumps(inspect(args.game), indent=2))
