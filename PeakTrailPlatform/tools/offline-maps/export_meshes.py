"""Export original shared Unity triangle meshes and exact instance transforms as GLB.

Unlike build_maps.py this exports no resampled geometry. A source component is
never joined to another component, and UVs stay attached to source vertices.
"""
from __future__ import annotations
import argparse, collections, datetime, gc, hashlib, io, json, math, shutil, struct, subprocess, time
from pathlib import Path
import numpy as np
from PIL import Image
from build_maps import Scene, MeshHandler, PPtr, BIOMES, GEOMETRY_ROOT_FIELDS, game_data, game_info, pid, sha, vec

FOLIAGE_TEXTURE_MAX_SIDE = 256
FUNGAL_BASE_TINT_MATERIALS = {'M_Mushroom_tree', 'M_Mushroom_tree_evil', 'Glow Shroom'}

def uses_fungal_base_tint(material_name, shader_name):
    return shader_name == 'W/Peak_Standard' and material_name in FUNGAL_BASE_TINT_MATERIALS

def linear_color(values):
    values=np.maximum(0,np.asarray(values,dtype=np.float64))
    return np.where(values<=.04045,values/12.92,((values+.055)/1.055)**2.4)

def source_base_property(material_name,shader_name,colors,floats):
    """Select the shader's actual primary albedo colour property.

    Most of PEAK's layered foliage and ice materials retain a generic ``_Tint``
    value, while their visible base colour is authored in ``_BaseColor``. The
    palm-leaf material is the source-backed exception: its orange
    ``_BaseColor`` is a layer input and its visible green is stored in
    ``_Tint``. Other shader families retain the conservative selection used by
    the existing material approximation.
    """
    if shader_name=='GD/FoliageGD' and material_name=='M_Foliage_Palmtree 5' and '_Tint' in colors:
        return '_Tint'
    # Jelly retains a white _BaseColor from a previous shader in saved data.
    # Its current shader declares _Color / _Color2, not _BaseColor.
    if shader_name=='Jelly' and '_Color' in colors:
        return '_Color'
    if shader_name in ('GD/FoliageGD','W/Peak_Ice') and '_BaseColor' in colors:
        return '_BaseColor'
    if uses_fungal_base_tint(material_name, shader_name) and '_BaseColor' in colors:
        return '_BaseColor'
    candidates=('_BaseColor',) if '_TopColorAmount' in floats else ('_Tint','_BaseColor','_Color')
    return next((name for name in candidates if name in colors),None)

def material_color_metadata(scene,ptr,source):
    """Read the *actual shader* property flags, not unused saved properties.

    Unity HDR/Gamma Color properties are already linear in serialized material
    storage. Normal Color properties are converted when passed to the shader.
    Treating the HDR base as sRGB a second time crushes Shore rock sidewalls.
    See Unity 6 Material.SetColor and ShaderPropertyFlags (HDR=16, Gamma=32).
    """
    if not pid(ptr):return {'baseProperty':None,'baseFlags':0,'topFlags':0,'shader':'Default'}
    shader_ptr=source.get('m_Shader',{})
    material_file=scene.ptr(ptr).deref().assets_file
    shader=PPtr(m_FileID=shader_ptr['m_FileID'],m_PathID=shader_ptr['m_PathID'],assetsfile=material_file)
    key=(material_file.name,shader.m_FileID,shader.m_PathID)
    if not hasattr(scene,'shader_color_properties'):scene.shader_color_properties={}
    if key not in scene.shader_color_properties:
        parsed=shader.read_typetree()['m_ParsedForm']
        properties={p['m_Name']:int(p['m_Flags']) for p in parsed['m_PropInfo']['m_Props']}
        culling=parsed['m_SubShaders'][0]['m_Passes'][0]['m_State']['culling']
        scene.shader_color_properties[key]=(parsed['m_Name'],properties,culling)
    shader_name,properties,culling=scene.shader_color_properties[key]
    saved=source['m_SavedProperties']; colors=dict(saved.get('m_Colors',[])); floats=dict(saved.get('m_Floats',[]))
    base_property=source_base_property(source.get('m_Name',''),shader_name,colors,floats)
    # Only a pass referencing a declared property can use that saved value.
    # GD/FoliageGD hardcodes Cull Off, despite a stale saved _Cull=2.
    cull_name=culling.get('name')
    shader_cull=float(floats.get(cull_name,culling['val'])) if cull_name in properties else float(culling['val'])
    return {'baseProperty':base_property,'baseFlags':properties.get(base_property,0),'topFlags':properties.get('_TopColor',0),'tintFlags':properties.get('_Tint',0),'shader':shader_name,'cull':shader_cull}

def stored_color_to_linear(values,flags):
    # No brightness correction: choose a transfer function from source metadata.
    return np.maximum(0,np.asarray(values,dtype=np.float64)) if flags & (16|32) else linear_color(values)

def fungal_albedo_color(material_name, shader_name, base, tint, tint_flags):
    """Named fungal albedo uses primary * Tint, without treating layer alpha as opacity."""
    if not uses_fungal_base_tint(material_name, shader_name):
        return base
    return base * stored_color_to_linear(tint[:3], tint_flags)

def foliage_material_contract(shader_name, textures, floats, shader_cull):
    """Return the source-backed cutout contract for PEAK's foliage shader.

    GD/FoliageGD and W/Vine do not expose their colour/shape texture under the
    standard Unity names used by the generic exporter. Their `_Shape` texture
    supplies both the visible colour and alpha silhouette, while `_AlphaClip`
    is the authored discard threshold. Falling back to a white texture turns
    every card into a solid tinted rectangle.
    """
    shape=textures.get('_Shape')
    if shader_name not in ('GD/FoliageGD','W/Vine') or not shape or not pid(shape.get('m_Texture',{})):
        return None
    cutoff=floats.get('_AlphaClip',floats.get('_AlphaCutoff',.5))
    cutoff=float(cutoff) if np.isfinite(cutoff) else .5
    return {'textureProperty':'_Shape','texture':shape,'alphaCutoff':min(1,max(0,cutoff)),'doubleSided':shader_cull==0}

def quaternion(rotation):
    # A proper orthogonal matrix only; shear is never sent through this path.
    m=rotation; trace=np.trace(m)
    if trace>0:
        s=math.sqrt(trace+1)*2
        q=np.array([(m[2,1]-m[1,2])/s,(m[0,2]-m[2,0])/s,(m[1,0]-m[0,1])/s,.25*s])
    else:
        i=int(np.argmax(np.diag(m))); j=(i+1)%3; k=(i+2)%3
        s=math.sqrt(max(0,1+m[i,i]-m[j,j]-m[k,k]))*2
        q=np.zeros(4); q[i]=.25*s; q[j]=(m[j,i]+m[i,j])/s; q[k]=(m[k,i]+m[i,k])/s; q[3]=(m[k,j]-m[j,k])/s
    return q/np.linalg.norm(q)

def decompose_exact(world):
    scale=np.linalg.norm(world[:3,:3],axis=0)
    if np.min(scale)<1e-10: return None
    rot=world[:3,:3]/scale[None,:]
    if np.linalg.det(rot)<0:
        scale[0]*=-1; rot[:,0]*=-1
    if np.max(np.abs(rot.T@rot-np.eye(3)))>1e-7: return None
    q=quaternion(rot)
    x,y,z,w=q
    r=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    if np.max(np.abs(r*scale[None,:]-world[:3,:3]))>1e-6: return None
    return world[:3,3],q,scale

class GlbBuilder:
    def __init__(self,scene):
        self.scene=scene; self.binary=bytearray(); self.gltf={'asset':{'version':'2.0','generator':'PeakTrail original Unity meshes 1','extras':{'coordinateSpace':'unity-world-meters','axisConversion':'none; raw Unity XYZ retained'}},'scene':0,'scenes':[{'nodes':[]}],'nodes':[],'meshes':[],'materials':[],'textures':[],'images':[],'samplers':[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497}],'buffers':[{'byteLength':0}],'bufferViews':[],'accessors':[],'extensionsUsed':['EXT_mesh_gpu_instancing']}
        self.mesh_sources={}; self.gltf_meshes={}; self.material_ids={}; self.image_ids={}; self.uv_ids={}
        self.min_world=np.full(3,np.inf); self.max_world=-self.min_world
        self.stats=collections.Counter()

    def buffer_view(self,data,target=None):
        while len(self.binary)%4:self.binary.append(0)
        view={'buffer':0,'byteOffset':len(self.binary),'byteLength':len(data)}
        if target:view['target']=target
        self.binary.extend(data); index=len(self.gltf['bufferViews']); self.gltf['bufferViews'].append(view); return index

    def accessor(self,array,kind,component=5126,target=None,bounds=False):
        dtype={5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[component]
        values=np.ascontiguousarray(array,dtype=dtype)
        accessor={'bufferView':self.buffer_view(values.tobytes(),target),'componentType':component,'count':len(values),'type':kind}
        if bounds:
            accessor['min']=values.min(axis=0).astype(float).tolist(); accessor['max']=values.max(axis=0).astype(float).tolist()
        index=len(self.gltf['accessors']); self.gltf['accessors'].append(accessor); return index

    def source_mesh(self,ptr):
        key=(ptr['m_FileID'],ptr['m_PathID'])
        if key not in self.mesh_sources:
            vertices,triangles,uv,colors,name=self.scene.mesh(ptr)
            if not len(vertices) or not triangles:return None
            source=self.scene.ptr(ptr).read(); helper=MeshHandler(source); helper.process()
            normals=np.asarray(helper.m_Normals,dtype=np.float64)[:,:3] if helper.m_Normals else np.zeros_like(vertices)
            if normals.shape!=vertices.shape:raise ValueError(f'Invalid normals for {name}')
            if not helper.m_Normals:
                for faces in triangles:
                    n=np.cross(vertices[faces[:,1]]-vertices[faces[:,0]],vertices[faces[:,2]]-vertices[faces[:,0]])
                    for corner in range(3):np.add.at(normals,faces[:,corner],n)
            normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-20)
            position_id=self.accessor(vertices,'VEC3',target=34962,bounds=True)
            normal_id=self.accessor(normals,'VEC3',target=34962)
            indices=[]
            for faces in triangles:
                # Raw source winding agrees with stored normals (verified for the
                # installed PEAK meshes). No global Z mirror or face reversal.
                component=5123 if int(faces.max(initial=0))<65536 else 5125
                indices.append(self.accessor(faces.reshape(-1),'SCALAR',component,target=34963))
            self.mesh_sources[key]={'vertices':vertices,'uv':uv,'positions':position_id,'normals':normal_id,'indices':indices,'triangles':triangles,'name':name}
            self.stats['uniqueMeshes']+=1; self.stats['uniqueVertices']+=len(vertices); self.stats['uniqueTriangles']+=sum(len(t) for t in triangles)
        return self.mesh_sources[key]

    def material(self,ptr):
        key=(ptr['m_FileID'],ptr['m_PathID'])
        if key not in self.material_ids:
            texture,tint,uvscale,uvoffset,use_vertex,top,settings=self.scene.material(ptr)
            source=self.scene.ptr(ptr).read_typetree() if pid(ptr) else {'m_Name':'Default'}
            color_metadata=material_color_metadata(self.scene,ptr,source)
            foliage=None
            sampler_id=0
            if pid(ptr):
                saved=source['m_SavedProperties']; colors=dict(saved.get('m_Colors',[])); textures=dict(saved.get('m_TexEnvs',[])); floats=dict(saved.get('m_Floats',[]))
                if color_metadata['baseProperty'] in colors:
                    tint=vec(colors[color_metadata['baseProperty']],'rgba')
                foliage=foliage_material_contract(color_metadata['shader'],textures,floats,color_metadata['cull'])
                if foliage:
                    selected=foliage['texture']; tp=selected['m_Texture']; matptr=self.scene.ptr(ptr)
                    texptr=PPtr(m_FileID=tp['m_FileID'],m_PathID=tp['m_PathID'],assetsfile=matptr.deref().assets_file)
                    texture_source=texptr.read()
                    wrap={0:10497,1:33071,2:33648}
                    sampler={**self.gltf['samplers'][0],
                        'wrapS':wrap.get(texture_source.m_TextureSettings.m_WrapU,33071),
                        'wrapT':wrap.get(texture_source.m_TextureSettings.m_WrapV,33071)}
                    if sampler not in self.gltf['samplers']:self.gltf['samplers'].append(sampler)
                    sampler_id=self.gltf['samplers'].index(sampler)
                    tk=(texptr.assetsfile.name,texptr.m_FileID,texptr.m_PathID)
                    if tk not in self.scene.textures:
                        image=texture_source.image.convert('RGBA')
                        # Cutout cards repeat across every chapter GLB.  A 256px
                        # source-backed silhouette keeps the authored colour and
                        # alpha edge while leaving enough headroom for the public
                        # site's fixed 1 GB deployment budget.
                        image.thumbnail((FOLIAGE_TEXTURE_MAX_SIDE,FOLIAGE_TEXTURE_MAX_SIDE),Image.Resampling.LANCZOS); self.scene.textures[tk]=np.asarray(image)
                    # Both compiled shaders sample UV0 directly: _Shape_ST is
                    # absent from their parameters. Palm's saved 12x scale is
                    # obsolete and would tile the leaf silhouette 144 times.
                    texture=self.scene.textures[tk]; uvscale=np.ones(2); uvoffset=np.zeros(2)
            base=np.minimum(1,stored_color_to_linear(tint[:3],color_metadata['baseFlags'])); top_linear=stored_color_to_linear(top[:3],color_metadata['topFlags'])
            fungal_tint=None
            if (uses_fungal_base_tint(source['m_Name'], color_metadata['shader'])
                    and color_metadata['baseProperty']=='_BaseColor' and '_Tint' in colors):
                fungal_tint=vec(colors['_Tint'],'rgba')
                base=fungal_albedo_color(source['m_Name'],color_metadata['shader'],base,fungal_tint,color_metadata['tintFlags'])
                # W/Peak_Standard does not declare the saved legacy top fields.
                settings=np.array([0.,1.,0.])
            material={'name':source['m_Name'],'doubleSided':foliage['doubleSided'] if foliage else True,'pbrMetallicRoughness':{'baseColorFactor':base.tolist()+[1.0],'metallicFactor':0.0,'roughnessFactor':.95},'extras':{'peakTerrain':{'colorSpace':'linear','baseColor':base.tolist(),'topColor':top_linear.tolist(),'topAlpha':float(top[3]),'tightness':[float(settings[0]),float(settings[1])],'amount':float(settings[2]),'formula':'smoothstep(tightness[0],tightness[1],max(worldNormal.y,0))*amount*topAlpha','sourceMaterial':source['m_Name'],'sourceUv':'Unity mesh UV0, converted v=1-v for glTF'}}}
            material['extras']['peakTerrain']['sourceColors']={**color_metadata,'baseStored':tint[:3].tolist(),'topStored':top[:3].tolist(),'conversion':'HDR/Gamma Color: already-linear stored value; ordinary Color: sRGB to linear'}
            if fungal_tint is not None:
                material['extras']['peakTerrain']['sourceTint']={'property':'_Tint','flags':color_metadata['tintFlags'],'stored':fungal_tint.tolist(),'formula':'_BaseColor.rgb * _Tint.rgb; layered masks and vertex AO remain approximated'}
            if foliage:
                material['extras']['peakTerrain']['sourceCutout']={'textureProperty':foliage['textureProperty'],'alphaCutoff':foliage['alphaCutoff'],'cull':color_metadata['cull'],'cullSource':'shader-pass','uvTransform':'mesh-uv0'}
            if texture.shape[0]>1 or texture.shape[1]>1:
                output=io.BytesIO(); Image.fromarray(texture).save(output,format='PNG',optimize=True); png=output.getvalue(); digest=hashlib.sha256(png).hexdigest()
                texture_key=(digest,sampler_id)
                if texture_key not in self.image_ids:
                    image_id=len(self.gltf['images']); self.gltf['images'].append({'bufferView':self.buffer_view(png),'mimeType':'image/png','name':digest})
                    texture_id=len(self.gltf['textures']); self.gltf['textures'].append({'source':image_id,'sampler':sampler_id}); self.image_ids[texture_key]=texture_id
                material['pbrMetallicRoughness']['baseColorTexture']={'index':self.image_ids[texture_key]}
                if np.any(texture[:,:,3]<200):material['alphaMode']='MASK'; material['alphaCutoff']=foliage['alphaCutoff'] if foliage else .4
            self.material_ids[key]=(len(self.gltf['materials']),uvscale,uvoffset); self.gltf['materials'].append(material)
        return self.material_ids[key]

    def gltf_mesh(self,ptr,mr):
        source=self.source_mesh(ptr)
        if source is None:return None
        materials=mr['m_Materials']; batch=mr.get('m_StaticBatchInfo',{})
        first=batch.get('firstSubMesh',0) if batch.get('subMeshCount',0) else 0
        count=batch.get('subMeshCount',0) or len(source['triangles'])
        key=(ptr['m_FileID'],ptr['m_PathID'],first,count,tuple((p['m_FileID'],p['m_PathID']) for p in materials))
        if key not in self.gltf_meshes:
            primitives=[]
            for index in range(first,min(first+count,len(source['triangles']))):
                if not len(source['triangles'][index]):continue
                material_ptr=materials[min(index-first,len(materials)-1)] if materials else {'m_FileID':0,'m_PathID':0}
                material_id,scale,offset=self.material(material_ptr)
                uvkey=(ptr['m_FileID'],ptr['m_PathID'],tuple(scale),tuple(offset))
                if uvkey not in self.uv_ids:
                    uv=source['uv']*scale+offset; uv[:,1]=1-uv[:,1]
                    self.uv_ids[uvkey]=self.accessor(uv,'VEC2',target=34962)
                primitives.append({'attributes':{'POSITION':source['positions'],'NORMAL':source['normals'],'TEXCOORD_0':self.uv_ids[uvkey]},'indices':source['indices'][index],'material':material_id,'mode':4})
            if not primitives:return None
            index=len(self.gltf['meshes']); self.gltf['meshes'].append({'name':source['name'],'primitives':primitives}); self.gltf_meshes[key]=index
        return self.gltf_meshes[key],source,first,count

    def add_instances(self,instances):
        groups=collections.defaultdict(list)
        for ptr,world,mr in instances:
            result=self.gltf_mesh(ptr,mr)
            if result is None:continue
            mesh,source,first,count=result
            referenced=np.unique(np.concatenate(source['triangles'][first:first+count]).reshape(-1))
            vertices=source['vertices'][referenced]; world_vertices=vertices@world[:3,:3].T+world[:3,3]
            self.min_world=np.minimum(self.min_world,world_vertices.min(0)); self.max_world=np.maximum(self.max_world,world_vertices.max(0))
            decomposition=decompose_exact(world)
            self.stats['instances']+=1; self.stats['renderedTriangles']+=sum(len(t) for t in source['triangles'][first:first+count])
            if decomposition is None:
                matrix=world.T.reshape(-1).astype(float).tolist()
                node={'name':f'{source["name"]}-affine','mesh':mesh,'matrix':matrix,'extras':{'peaktrailFullAffine':True}}
                self.add_node(node); self.stats['affineNodes']+=1
            else:groups[mesh].append(decomposition)
        for mesh,transforms in groups.items():
            if len(transforms)==1:
                t,q,s=transforms[0]; node={'mesh':mesh,'translation':t.tolist(),'rotation':q.tolist(),'scale':s.tolist()}
            else:
                t,q,s=(np.asarray([entry[i] for entry in transforms]) for i in range(3))
                node={'mesh':mesh,'extensions':{'EXT_mesh_gpu_instancing':{'attributes':{'TRANSLATION':self.accessor(t,'VEC3'),'ROTATION':self.accessor(q,'VEC4'),'SCALE':self.accessor(s,'VEC3')}}}}
                self.stats['instancedGroups']+=1; self.stats['gpuInstances']+=len(transforms)
            self.add_node(node)

    def add_node(self,node):
        index=len(self.gltf['nodes']); self.gltf['nodes'].append(node); self.gltf['scenes'][0]['nodes'].append(index)

    def write(self,path):
        while len(self.binary)%4:self.binary.append(0)
        self.gltf['buffers'][0]['byteLength']=len(self.binary)
        text=json.dumps(self.gltf,separators=(',',':'),ensure_ascii=False).encode()
        text+=b' ' *((-len(text))%4)
        payload=struct.pack('<4sII',b'glTF',2,12+8+len(text)+8+len(self.binary))+struct.pack('<II',len(text),0x4e4f534a)+text+struct.pack('<II',len(self.binary),0x004e4942)+self.binary
        path.write_bytes(payload)
        return {'bytes':len(payload),'sha256':sha(path),'bounds':{'min':self.min_world.tolist(),'max':self.max_world.tolist()},**dict(self.stats),'materials':len(self.gltf['materials']),'embeddedTextures':len(self.gltf['images']),'drawGroups':len(self.gltf['meshes'])}

def export_one(args,slot):
    mapping,version,build=game_info(args.game); name=f'Level_{slot}'; started=time.time()
    source_dir=args.legacy/str(build)/name; destination=args.output/str(build)/name; destination.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((source_dir/'map-pack.json').read_text(encoding='utf-8'))
    # A migrated canonical v3 pack may provide the reusable planar reference.
    # Drop stale geometry references before exporting, including partial runs.
    for layer in manifest['layers']:
        for key in ('geometry','geometrySha256','geometryFormat','meshBounds','meshStatistics'):
            layer.pop(key,None)
    manifest['identityVersion']=3; manifest['mapPackId']=''; manifest['generatedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    manifest['source']['kind']='offline-unity-original-mesh'; manifest['source']['geometrySource']='original indexed MeshFilter geometry, shared meshes and exact world transforms; no height-field reconstruction or decimation'
    manifest['source']['limitations']=['Game-specific custom shader effects remain approximated with source material colors and original UV/base textures.','Moving props and spawned loot are not part of the static scene model.','Legacy height/PNG data is retained only as a separate planar reference, never used to build this 3D geometry.']
    scene=Scene(game_data(args.game)/f'level{mapping[name]}',args.game)
    manifest['route']=scene.route()
    selected={int(v) for v in args.layers.split(',')} if args.layers!='all' else None
    reports=[]
    for index,segment in scene.layers():
        if selected is not None and index not in selected:continue
        layer=manifest['layers'][index]
        for key in ('texture','height'):
            target=destination/layer[key]
            if not target.exists():shutil.copy2(source_dir/layer[key],target)
        instances,_,_=scene.collect(segment); builder=GlbBuilder(scene); builder.add_instances(instances)
        path=destination/f'{layer["id"]}.glb'; report=builder.write(path)
        if not args.uncompressed:
            result=subprocess.run(['node',str(Path(__file__).with_name('compress-glb.mjs')),str(path)],check=True,text=True,capture_output=True)
            compression=json.loads(result.stdout)
            report['uncompressedBytes']=report['bytes'];report['bytes']=path.stat().st_size;report['sha256']=sha(path);report['compression']=compression
        layer['geometry']=path.name; layer['geometrySha256']=report['sha256']; layer['geometryFormat']='glb-instanced-v1'; layer['meshBounds']=report['bounds']; layer['meshStatistics']={k:v for k,v in report.items() if k not in ('sha256','bounds')}
        reports.append({'layer':index,**report})
        print(name,index,json.dumps(report),f'elapsed={time.time()-started:.1f}s',flush=True)
        # The incremental manifest is deliberately unsigned until root's v3
        # identity routine finalizes it; partial packs cannot be registered.
        completed_manifest=manifest.copy(); completed_manifest['layers']=[l for l in manifest['layers'] if l.get('geometryFormat')=='glb-instanced-v1']
        (destination/'mesh-export.json').write_text(json.dumps(completed_manifest,ensure_ascii=False,indent=2),encoding='utf-8')
        del builder; gc.collect()
    (destination/'mesh-report.json').write_text(json.dumps(reports,indent=2),encoding='utf-8')
    if selected is None or len(selected)==len(manifest['layers']):
        (destination/'map-pack.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print('COMPLETE',destination,flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--game',type=Path,default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK')); parser.add_argument('--slots',default='16'); parser.add_argument('--layers',default='all'); parser.add_argument('--legacy',type=Path,default=Path(__file__).resolve().parents[3]/'local/assets/maps/working/legacy'); parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[3]/'local/assets/maps/working/mesh-v3');parser.add_argument('--uncompressed',action='store_true')
    args=parser.parse_args(); slots=sorted(int(n.rsplit('_',1)[1]) for n in game_info(args.game)[0]) if args.slots=='all' else [int(s) for s in args.slots.split(',')]
    for slot in slots:export_one(args,slot);gc.collect()
