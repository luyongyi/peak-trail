"""Reproduce the fixed-build raw effect-material evidence without scene export."""
import argparse,hashlib,json
from pathlib import Path
import UnityPy
from UnityPy.classes import PPtr
from build_maps import game_info

parser=argparse.ArgumentParser()
parser.add_argument('--game',type=Path,default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[3]/'local/assets/evidence/source-effect-materials.25306743.json')
args=parser.parse_args()
if str(game_info(args.game)[2])!='25306743':raise RuntimeError('This evidence extractor is pinned to Steam build 25306743')
sources=[args.game/'PEAK_Data/sharedassets4.assets',args.game/'PEAK_Data/resources.assets']
wanted={'M_Lava','M_Water_forest','M_Water_forest 1','M_Water_Onsen','M_Water_swamp','M_Void Water','FogSurface void','FogSurface',
    'AntiSphere','AntiSphereInterior','Jelly',
    'M_SporeShroomExplo','M_SporeShroomPoison','M_SporeShroomPoison_Ivy','M_SporeShroomSpores'}
records=[]
for source in sources:
    env=UnityPy.load(str(source))
    for obj in list(env.objects):
        if obj.type.name!='Material':continue
        mat=obj.read_typetree()
        if mat['m_Name'] not in wanted:continue
        sp=mat['m_Shader']; shader_object=PPtr(m_FileID=sp['m_FileID'],m_PathID=sp['m_PathID'],assetsfile=obj.assets_file).read_typetree()
        shader=shader_object['m_ParsedForm']
        props={p['m_Name']:p for p in shader['m_PropInfo']['m_Props']}; saved=mat['m_SavedProperties']
        forward=next(p for p in shader['m_SubShaders'][0]['m_Passes'] if p['m_State']['m_Name']=='Forward')
        state=forward['m_State']
        record={'name':mat['m_Name'],'shader':shader['m_Name'],'sourceFile':source.name,'pathId':obj.path_id,
          'colors':{name:{'rgba':[value[k] for k in 'rgba'],'flags':props[name]['m_Flags']} for name,value in saved['m_Colors'] if name in props and props[name]['m_Type']==0},
          'floats':{name:value for name,value in saved['m_Floats'] if name in props},
          'passState':{k:state[k] for k in ('rtBlend0','zTest','zWrite','culling')}}
        if mat['m_Name']=='Jelly':
            # The compiled Forward pixel program was disassembled with Windows
            # D3DDisassemble. Preserve its actual declarations and buffer offsets
            # so the documented color operation can be traced to this shader.
            record['shaderProperties']={name:{'type':prop['m_Type'],'flags':prop['m_Flags']} for name,prop in props.items()}
            record['unusedSavedColors']={name:[value[k] for k in 'rgba'] for name,value in saved['m_Colors'] if name not in props}
            record['forwardTags']=dict(state['m_Tags']['tags'])
            record['shaderCompressedBytecodeSha256']=hashlib.sha256(bytes(shader_object['compressedBlob'])).hexdigest()
            names={index:name for name,index in forward['m_NameIndices']}
            buffers=forward['progFragment']['m_CommonParameters']['m_ConstantBuffers']
            record['forwardMaterialOffsets']={names[value['m_NameIndex']]:value['m_Index'] for buffer in buffers
                if names[buffer['m_NameIndex']]=='UnityPerMaterial' for value in buffer['m_VectorParams']}
            record['textures']={}
            for name,value in saved['m_TexEnvs']:
                tp=value['m_Texture']
                if name not in props or not tp['m_PathID']:continue
                tex=PPtr(m_FileID=tp['m_FileID'],m_PathID=tp['m_PathID'],assetsfile=obj.assets_file).deref()
                data=tex.read()
                record['textures'][name]={'name':data.m_Name,'sourceFile':tex.assets_file.name,'pathId':tex.path_id,
                    'width':data.m_Width,'height':data.m_Height,'scale':value['m_Scale'],'offset':value['m_Offset']}
            record['colorComputation']={
                'evidence':'Direct3D11 Forward pixel bytecode disassembly; UnityPerMaterial offsets map _Texture2Color, _Color, _Color2 and _Remap to cb3[0..3]',
                'surface':'lerp(_Texture2Color.rgb, lerp(_Color, _Color2, smoothstep(_Remap.x, _Remap.y, _Texture.r)).rgb, _Texture2.r)',
                'alpha':'_Color.a and _Color2.a blend the tinted surface with refracted scene color; output alpha instead uses scene-depth intersection and vertex color',
                'fallback':'Use declared primary _Color for the static color-only approximation; do not use undeclared saved _BaseColor or reinterpret color alpha as opacity'}
        records.append(record)
if {r['name'] for r in records}!=wanted:raise RuntimeError('Missing required material; installed build may have changed')
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps({'gameBuildId':25306743,'note':'Direct shader-declared fields only. Colors with HDR flag16 are stored linear; ordinary Color flag0 is sRGB. Material alpha may be a shader parameter, not opacity.','materials':records},indent=2),encoding='utf-8')
print(f'{len(records)} source materials: {args.output}')
