"""Reproduce the fixed-build raw effect-material evidence without scene export."""
import argparse,json
from pathlib import Path
import UnityPy
from UnityPy.classes import PPtr
from build_maps import game_info

parser=argparse.ArgumentParser()
parser.add_argument('--game',type=Path,default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[3]/'local/assets/evidence/source-effect-materials.25306743.json')
args=parser.parse_args()
if str(game_info(args.game)[2])!='25306743':raise RuntimeError('This evidence extractor is pinned to Steam build 25306743')
source=args.game/'PEAK_Data/sharedassets4.assets'
env=UnityPy.load(str(source)); wanted={'M_Lava','M_Water_forest','M_Water_forest 1','M_Water_Onsen','M_Water_swamp','M_Void Water','FogSurface void','FogSurface',
    'M_SporeShroomExplo','M_SporeShroomPoison','M_SporeShroomPoison_Ivy','M_SporeShroomSpores'}
records=[]
for obj in list(env.objects):
    if obj.type.name!='Material':continue
    mat=obj.read_typetree()
    if mat['m_Name'] not in wanted:continue
    sp=mat['m_Shader']; shader=PPtr(m_FileID=sp['m_FileID'],m_PathID=sp['m_PathID'],assetsfile=obj.assets_file).read_typetree()['m_ParsedForm']
    props={p['m_Name']:p for p in shader['m_PropInfo']['m_Props']}; saved=mat['m_SavedProperties']
    state=shader['m_SubShaders'][0]['m_Passes'][0]['m_State']
    records.append({'name':mat['m_Name'],'shader':shader['m_Name'],'sourceFile':source.name,'pathId':obj.path_id,
      'colors':{name:{'rgba':[value[k] for k in 'rgba'],'flags':props[name]['m_Flags']} for name,value in saved['m_Colors'] if name in props and props[name]['m_Type']==0},
      'floats':{name:value for name,value in saved['m_Floats'] if name in props},
      'passState':{k:state[k] for k in ('rtBlend0','zTest','zWrite','culling')}})
if {r['name'] for r in records}!=wanted:raise RuntimeError('Missing required material; installed build may have changed')
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps({'gameBuildId':25306743,'note':'Direct shader-declared fields only. Colors with HDR flag16 are stored linear; ordinary Color flag0 is sRGB. Material alpha may be a shader parameter, not opacity.','materials':records},indent=2),encoding='utf-8')
print(f'{len(records)} source materials: {args.output}')
