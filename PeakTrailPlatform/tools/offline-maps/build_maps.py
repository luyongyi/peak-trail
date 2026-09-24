"""Bake orthographic map packs from installed Unity scene Mesh/Transform data.

The installed game is read only. No Unity code or network game is executed.
"""
from __future__ import annotations
import argparse, collections, datetime, gc, hashlib, json, math, re, subprocess, time
from pathlib import Path
import numpy as np
from PIL import Image
from numba import njit
import UnityPy
from UnityPy.classes import PPtr
from UnityPy.helpers.MeshHelper import MeshHandler
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
from route_metadata import BIOMES, resolved_segments, route_metadata

FIELDS = ('_segmentParent','_segmentCampfire','wallNext','wallPrevious')
GEOMETRY_ROOT_FIELDS = ('_segmentParent','_segmentCampfire')

def pid(ptr):
    return ptr.get('m_PathID',0)

def vec(value, names='xyz'):
    return np.array([value[n] for n in names],dtype=np.float64)

def trs(t):
    x,y,z,w = vec(t['m_LocalRotation'],'xyzw')
    rot=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                  [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                  [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    result=np.eye(4)
    result[:3,:3]=rot*vec(t['m_LocalScale'])[None,:]
    result[:3,3]=vec(t['m_LocalPosition'])
    return result

def primitive_mesh(kind,collider,world):
    center=vec(collider['m_Center'])@world[:3,:3].T+world[:3,3]
    if kind=='BoxCollider':
        vertices=np.array([(x,y,z) for x in (-.5,.5) for y in (-.5,.5) for z in (-.5,.5)])*vec(collider['m_Size'])
        vertices=vertices@world[:3,:3].T+center
        triangles=np.array([(0,1,3),(0,3,2),(4,6,7),(4,7,5),(0,4,5),(0,5,1),(2,3,7),(2,7,6),(0,2,6),(0,6,4),(1,5,7),(1,7,3)],dtype=np.int32)
    else:
        scales=np.linalg.norm(world[:3,:3],axis=0)
        direction=int(collider.get('m_Direction',1))
        radius=float(collider['m_Radius'])*(max(scales) if kind=='SphereCollider' else max(scales[i] for i in range(3) if i!=direction))
        half=0 if kind=='SphereCollider' else max(0,float(collider['m_Height'])*scales[direction]/2-radius)
        axis=world[:3,direction]/max(scales[direction],1e-12)
        up=np.array([0.,1.,0.]) if abs(axis[1])<.9 else np.array([1.,0.,0.])
        side=np.cross(axis,up); side/=np.linalg.norm(side); forward=np.cross(side,axis)
        vertices=[]; triangles=[]; rings=12; sides=16
        for j in range(rings+1):
            theta=math.pi*j/rings; axial=math.cos(theta); radial=math.sin(theta)
            for i in range(sides):
                angle=2*math.pi*i/sides
                vertices.append(center+axis*(radius*axial+(half if axial>=0 else -half))+radius*radial*(side*math.cos(angle)+forward*math.sin(angle)))
        for j in range(rings):
            for i in range(sides):
                a=j*sides+i; b=j*sides+(i+1)%sides; c=a+sides; d=b+sides
                triangles.extend([(a,c,b),(b,c,d)])
        vertices=np.asarray(vertices); triangles=np.asarray(triangles,dtype=np.int32)
    return vertices,[triangles],np.zeros((len(vertices),2)),np.ones((len(vertices),4)),kind

@njit(cache=True)
def raster(vertices, triangles, uv, colors, tex, tint, top_tint, top_settings, extent, depth, rgba, draw_color):
    rows,cols=depth.shape
    sx=cols/(extent[1]-extent[0]); sz=rows/(extent[3]-extent[2])
    tw=tex.shape[1]; th=tex.shape[0]
    for tri in triangles:
        a,b,c=vertices[tri[0]],vertices[tri[1]],vertices[tri[2]]
        ax=(a[0]-extent[0])*sx-.5; az=(a[2]-extent[2])*sz-.5
        bx=(b[0]-extent[0])*sx-.5; bz=(b[2]-extent[2])*sz-.5
        cx=(c[0]-extent[0])*sx-.5; cz=(c[2]-extent[2])*sz-.5
        den=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz)
        if abs(den)<1e-10: continue
        minx=max(0,int(math.ceil(min(ax,bx,cx)))); maxx=min(cols-1,int(math.floor(max(ax,bx,cx))))
        minz=max(0,int(math.ceil(min(az,bz,cz)))); maxz=min(rows-1,int(math.floor(max(az,bz,cz))))
        normal=np.cross(b-a,c-a)
        norm=np.sqrt(np.sum(normal*normal))
        if normal[1]<0: normal=-normal
        shade=.55+.45*max(0,(normal[0]*.3+normal[1]*.9-normal[2]*.3)/max(norm,1e-12))
        amount=max(0,min(1,(normal[1]/max(norm,1e-12)-top_settings[0])/max(1e-5,top_settings[1]-top_settings[0])))
        amount=amount*amount*(3-2*amount)*top_settings[2]*top_tint[3]
        for z in range(minz,maxz+1):
            for x in range(minx,maxx+1):
                wa=((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/den
                wb=((cz-az)*(x-cx)+(ax-cx)*(z-cz))/den
                wc=1-wa-wb
                if wa<-.000001 or wb<-.000001 or wc<-.000001: continue
                y=wa*a[1]+wb*b[1]+wc*c[1]
                if y<=depth[z,x]: continue
                if draw_color:
                    tu=wa*uv[tri[0],0]+wb*uv[tri[1],0]+wc*uv[tri[2],0]
                    tv=wa*uv[tri[0],1]+wb*uv[tri[1],1]+wc*uv[tri[2],1]
                    tx=int((tu%1)*tw)%tw; ty=int(((1-tv)%1)*th)%th
                    alpha=tex[ty,tx,3]*tint[3]
                    if alpha<100: continue
                    for channel in range(3):
                        vc=wa*colors[tri[0],channel]+wb*colors[tri[1],channel]+wc*colors[tri[2],channel]
                        surface_tint=tint[channel]*(1-amount)+top_tint[channel]*amount
                        rgba[z,x,channel]=min(255,max(0,int(tex[ty,tx,channel]*surface_tint*vc*shade)))
                    rgba[z,x,3]=255
                depth[z,x]=y

class Scene:
    def __init__(self,path,game):
        self.env=UnityPy.load(str(path)); self.file=next(iter(self.env.files.values()))
        self.objects=self.file.objects
        self.cache={}; self.matrices={}; self.go_transforms={}; self.meshes={}; self.materials={}; self.textures={}
        self.gen=TypeTreeGenerator(self.file.unity_version); self.gen.load_local_game(str(game))
        self.special={}; scripts={}
        for obj in self.objects.values():
            if obj.type.name!='MonoBehaviour': continue
            mb=obj.read(check_read=False); key=(mb.m_Script.m_FileID,mb.m_Script.m_PathID)
            if key not in scripts:
                try: scripts[key]=mb.m_Script.read().m_ClassName
                except Exception: scripts[key]='?'
            name=scripts[key]
            if name in ('MapHandler','VoidBiome'):
                self.env.typetree_generator=self.gen
                self.special[name]=obj.read_typetree()
                self.env.typetree_generator=None
        if 'MapHandler' not in self.special: raise ValueError('scene has no MapHandler')

    def read(self,pathid):
        if pathid not in self.cache: self.cache[pathid]=self.objects[pathid].read_typetree()
        return self.cache[pathid]

    def ptr(self,value):
        return PPtr(m_FileID=value['m_FileID'],m_PathID=value['m_PathID'],assetsfile=self.file)

    def transform(self,go):
        if go not in self.go_transforms:
            self.go_transforms[go]=next(pid(c['component']) for c in self.read(go)['m_Component'] if self.objects[pid(c['component'])].type.name in ('Transform','RectTransform'))
        return self.go_transforms[go]

    def world(self,transform):
        if not transform: return np.eye(4)
        if transform not in self.matrices:
            t=self.read(transform); self.matrices[transform]=self.world(pid(t['m_Father']))@trs(t)
        return self.matrices[transform]

    def layers(self):
        result=resolved_segments(self.special['MapHandler'])
        if 'VoidBiome' in self.special: result.append((len(result),self.special['VoidBiome']['segment']))
        return result

    def route(self):
        return route_metadata(self.special['MapHandler'], lambda ptr: self.read(pid(ptr))['m_Name'] if pid(ptr) else None)

    def collect(self,segment):
        # Fog wall roots are visual transition effects / blockers, not terrain.
        roots={pid(segment[f]) for f in GEOMETRY_ROOT_FIELDS if pid(segment[f])}
        nodes=[]; seen=set(); excluded=set()
        def walk(tid,dynamic=False,force=False):
            if tid in seen: return
            seen.add(tid); t=self.read(tid); goid=pid(t['m_GameObject']); go=self.read(goid)
            if not force and not go['m_IsActive']: return
            comps=[(pid(c['component']),self.objects[pid(c['component'])].type.name) for c in go['m_Component']]
            for cid,kind in comps:
                if kind=='Rigidbody' and not self.read(cid).get('m_IsKinematic',False): dynamic=True
                if kind=='LODGroup':
                    lod=self.read(cid)
                    if lod.get('m_Enabled') and lod['m_LODs']:
                        first={pid(r['renderer']) for r in lod['m_LODs'][0]['renderers']}
                        for level in lod['m_LODs'][1:]:
                            excluded.update(pid(r['renderer']) for r in level['renderers'] if pid(r['renderer']) not in first)
            if not dynamic: nodes.append((tid,go,comps))
            for child in t['m_Children']: walk(pid(child),dynamic)
        for root in roots: walk(self.transform(root),force=True)
        renders=[]; colliders=[]; stats=collections.Counter()
        for tid,go,comps in nodes:
            meshfilter=next((cid for cid,kind in comps if kind=='MeshFilter'),None)
            for cid,kind in comps:
                if kind=='MeshRenderer' and meshfilter and cid not in excluded:
                    mr=self.read(cid)
                    if not mr['m_Enabled']: continue
                    # Unity ShadowCastingMode.ShadowsOnly (3) has no visible
                    # surface. Alpine's huge light-blocking quads use it.
                    # Filter this renderer only, not its children or colliders;
                    # Off/On/TwoSided (0/1/2) still have visible surfaces.
                    if mr.get('m_CastShadows')==3:
                        stats['shadowOnlyRenderers']+=1
                        continue
                    ptr=self.read(meshfilter)['m_Mesh']
                    if not pid(ptr): continue
                    batch=mr.get('m_StaticBatchInfo',{}); world=self.world(tid)
                    if batch.get('subMeshCount',0): world=self.world(pid(mr['m_StaticBatchRoot']))
                    renders.append((ptr,world,mr)); stats['renderers']+=1
                elif kind=='MeshCollider':
                    mc=self.read(cid)
                    if mc['m_Enabled'] and not mc['m_IsTrigger'] and pid(mc['m_Mesh']):
                        colliders.append((mc['m_Mesh'],self.world(tid),None)); stats['meshColliders']+=1
                elif kind in ('BoxCollider','SphereCollider','CapsuleCollider'):
                    pc=self.read(cid)
                    if pc['m_Enabled'] and not pc['m_IsTrigger']:
                        self.meshes[(-1,cid)]=primitive_mesh(kind,pc,self.world(tid))
                        colliders.append(({'m_FileID':-1,'m_PathID':cid},np.eye(4),None)); stats[kind]+=1
        return renders,colliders,dict(stats)

    def mesh(self,ptr):
        key=(ptr['m_FileID'],ptr['m_PathID'])
        if key not in self.meshes:
            m=self.ptr(ptr).read(); h=MeshHandler(m); h.process()
            verts=np.asarray(h.m_Vertices,dtype=np.float64)
            if verts.ndim!=2: verts=np.empty((0,3),dtype=np.float64)
            uv=np.asarray(h.m_UV0,dtype=np.float64) if h.m_UV0 else np.zeros((len(verts),2))
            colors=np.asarray(h.m_Colors,dtype=np.float64) if h.m_Colors else np.ones((len(verts),4))
            if colors.size and colors.max()>1: colors=colors/255
            # Unity baseVertex is not applied by UnityPy.get_triangles().
            tris=[np.asarray(t,dtype=np.int32).reshape(-1,3)+int(sm.baseVertex or 0) for t,sm in zip(h.get_triangles(),m.m_SubMeshes)] if len(verts) and h.m_IndexBuffer else []
            self.meshes[key]=(verts,tris,uv,colors,m.m_Name)
        return self.meshes[key]

    def material(self,ptr):
        key=(ptr['m_FileID'],ptr['m_PathID'])
        if key not in self.materials:
            tex=np.full((1,1,4),255,dtype=np.uint8); tint=np.ones(4); top_tint=np.zeros(4); top_settings=np.array([0.,1.,0.]); uvscale=np.ones(2); uvoffset=np.zeros(2); vertex_tint=True
            if pid(ptr):
                mat=self.ptr(ptr).read_typetree(); props=mat['m_SavedProperties']
                colors=dict(props.get('m_Colors',[])); textures=dict(props.get('m_TexEnvs',[]))
                # PEAK's terrain shaders use vertex channels as material masks.
                # Their artist-authored _Tint and base texture are the albedo approximation.
                vertex_tint='_Color1' not in colors
                floats=dict(props.get('m_Floats',[]))
                col=colors.get('_BaseColor') if '_TopColorAmount' in floats else colors.get('_Tint',colors.get('_BaseColor',colors.get('_Color')))
                if col: tint=vec(col,'rgba')
                if '_TopColor' in colors and floats.get('_UseTopColor',0)>0:
                    top_tint=vec(colors['_TopColor'],'rgba')
                    tight=colors.get('_TopSurfaceTightness',{'r':.5,'g':1.})
                    top_settings=np.array([tight['r'],tight['g'],min(1,max(0,floats.get('_TopColorAmount',1)))])
                selected=next((textures[n] for n in ('_BaseTexture','_BaseMap','_MainTex','_Albedo') if n in textures and pid(textures[n]['m_Texture'])),None)
                if selected:
                    tp=selected['m_Texture']; matptr=self.ptr(ptr); texptr=PPtr(m_FileID=tp['m_FileID'],m_PathID=tp['m_PathID'],assetsfile=matptr.deref().assets_file)
                    tk=(texptr.assetsfile.name,texptr.m_FileID,texptr.m_PathID)
                    if tk not in self.textures:
                        image=texptr.read().image.convert('RGBA'); image.thumbnail((512,512)); self.textures[tk]=np.asarray(image)
                    tex=self.textures[tk]; uvscale=vec(selected['m_Scale'],'xy'); uvoffset=vec(selected['m_Offset'],'xy')
            self.materials[key]=(tex,tint,uvscale,uvoffset,vertex_tint,top_tint,top_settings)
        return self.materials[key]

def bounds_for(scene,instances):
    lo=np.full(3,np.inf); hi=-lo
    for ptr,world,mr in instances:
        verts,tris,uv,colors,name=scene.mesh(ptr)
        if len(verts)==0: continue
        if mr and mr.get('m_StaticBatchInfo',{}).get('subMeshCount',0):
            bi=mr['m_StaticBatchInfo']; inds=np.unique(np.concatenate(tris[bi['firstSubMesh']:bi['firstSubMesh']+bi['subMeshCount']]).ravel()); verts=verts[inds]
        vv=verts@world[:3,:3].T+world[:3,3]
        lo=np.minimum(lo,vv.min(0)); hi=np.maximum(hi,vv.max(0))
    return lo,hi

def render_instances(scene,instances,extent,resolution,color):
    depth=np.full((resolution,resolution),-np.inf); rgba=np.zeros((resolution,resolution,4),dtype=np.uint8)
    white=np.full((1,1,4),255,dtype=np.uint8); tint=np.ones(4)
    total=0
    for ptr,world,mr in instances:
        verts,submeshes,uv,colors,name=scene.mesh(ptr); vv=verts@world[:3,:3].T+world[:3,3]
        if len(verts)==0: continue
        first=0; count=len(submeshes)
        if mr and mr.get('m_StaticBatchInfo',{}).get('subMeshCount',0):
            first=mr['m_StaticBatchInfo']['firstSubMesh']; count=mr['m_StaticBatchInfo']['subMeshCount']
        for si in range(first,min(first+count,len(submeshes))):
            ts=submeshes[si]
            if len(ts)==0: continue
            tex=white; ti=tint; tuv=uv; vcs=colors; top=np.zeros(4); top_settings=np.array([0.,1.,0.])
            if color and mr and mr['m_Materials']:
                material=mr['m_Materials'][min(si-first,len(mr['m_Materials'])-1)]
                tex,ti,scale,offset,use_vertex,top,top_settings=scene.material(material); tuv=uv*scale+offset
                if not use_vertex: vcs=np.ones_like(colors)
            raster(vv,ts,tuv,vcs,tex,ti,top,top_settings,np.asarray(extent),depth,rgba,color); total+=len(ts)
    depth[~np.isfinite(depth)]=np.nan
    return depth,rgba,total

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def game_info(game):
    env=UnityPy.load(str(game/'PEAK_Data'/'globalgamemanagers'))
    build=next(o.read_typetree(check_read=False) for o in env.objects if o.type.name=='BuildSettings')
    player=next(o.read_typetree(check_read=False) for o in env.objects if o.type.name=='PlayerSettings')
    scenes={Path(s).stem:i for i,s in enumerate(build['scenes']) if re.fullmatch(r'Level_\d+',Path(s).stem)}
    steam=game.parent.parent/'appmanifest_3527290.acf'
    text=steam.read_text(encoding='utf-8'); build_id=int(re.search(r'"buildid"\s+"(\d+)"',text).group(1))
    return scenes,player['bundleVersion'],build_id

def build_one(game,slot,out,res,hres):
    started=time.time(); mapping,version,build_id=game_info(game); name=f'Level_{slot}'; scene_file=f'level{mapping[name]}'
    scene=Scene(game/'PEAK_Data'/scene_file,game); dest=out/str(build_id)/name; dest.mkdir(parents=True,exist_ok=True)
    manifest={'schemaVersion':1,'identityVersion':2,'mapPackId':'','generatedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gameVersion':version,'gameBuildId':build_id,'sceneName':name,'mapSlot':slot,'projectionVersion':1,'coordinateSpace':'unity-world-meters','textureUv':'u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)','imageOrigin':'bottom-left-in-uv;viewer-flips-for-top-left-images','layers':[], 'source':{'kind':'offline-unity-scene','sceneFile':scene_file,'sceneSha256':sha(game/'PEAK_Data'/scene_file),'unityVersion':scene.file.unity_version,'renderer':'Mesh UV/base texture; terrain _BaseColor/_TopColor with slope; prop _Tint; orthographic albedo survey rasterizer','heightSource':'highest non-trigger MeshCollider/BoxCollider/SphereCollider/CapsuleCollider surface, excluding fog wall roots','transformSource':'full serialized parent-chain TRS; static-batch root when present','limitations':['Custom game shader lighting and material-layer masks are approximated; this is an albedo survey render, not a game screenshot.','Moving props and spawned items are not baked. Sphere/capsule colliders use 16-sided tessellation.','Top-surface height field cannot preserve stacked caves/overhangs.','Void has a very large static collision plane and consequently coarser horizontal sample spacing.']}}
    print(name,scene_file,'loaded',flush=True)
    manifest['route']=scene.route()
    for index,segment in scene.layers():
        biome=BIOMES.get(segment['_biome'],str(segment['_biome'])); renders,colliders,stats=scene.collect(segment)
        print('collect',name,index,biome,stats,flush=True)
        if not renders or not colliders: raise ValueError(f'{name} segment {index} lacks geometry')
        # Visual-only horizon/fog/ocean meshes can span kilometres. The raster extent
        # follows the solid collision geometry that can actually support a player.
        lo,hi=bounds_for(scene,colliders); size=max(hi[0]-lo[0],hi[2]-lo[2])+10
        center=(lo+hi)/2; extent=np.asarray([center[0]-size/2,center[0]+size/2,center[2]-size/2,center[2]+size/2],dtype=np.float32)
        vis,rgba,triangles=render_instances(scene,renders,extent,res,True)
        height,_,collider_triangles=render_instances(scene,colliders,extent,hres,False)
        slug=f'segment-{index:02d}-{biome.lower()}'; imagepath=dest/f'{slug}.png'; heightpath=dest/f'{slug}.height.f32'
        Image.fromarray(rgba[::-1]).save(imagepath,optimize=True)
        height.astype('<f4').tofile(heightpath)
        layer={'id':slug,'name':biome,'segment':index,'biome':biome,'texture':imagepath.name,'textureSha256':sha(imagepath),'height':heightpath.name,'heightSha256':sha(heightpath),'columns':hres,'rows':hres,'minX':float(extent[0]),'maxX':float(extent[1]),'minY':float(np.float32(lo[1])),'maxY':float(np.float32(hi[1])),'minZ':float(extent[2]),'maxZ':float(extent[3]),'heightEncoding':'float32-le-row-major-minz-minx','noData':'NaN','sampleLocation':'cell-centers','validHeightSamples':int(np.isfinite(height).sum()),'geometry':{**stats,'renderTriangles':triangles,'colliderTriangles':collider_triangles,'rootGameObjects':[pid(segment[f]) for f in FIELDS if pid(segment[f])]}}
        manifest['layers'].append(layer)
        print('baked',name,index,biome,'bounds',lo,hi,'valid',layer['validHeightSamples'],'elapsed',round(time.time()-started),flush=True)
    path=dest/'map-pack.json'; path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    finalize=Path(__file__).with_name('finalize-map.mjs')
    subprocess.run(['node',str(finalize),str(path)],check=True)
    print('COMPLETE',path,round(time.time()-started),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--game',type=Path,default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK')); parser.add_argument('--slots',default='16'); parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[3]/'local/assets/maps/working/legacy'); parser.add_argument('--texture',type=int,default=1024); parser.add_argument('--height',type=int,default=512)
    args=parser.parse_args()
    if min(args.texture,args.height)<2: parser.error('raster dimensions must be at least two')
    slots=sorted(int(name.rsplit('_',1)[1]) for name in game_info(args.game)[0]) if args.slots=='all' else [int(x) for x in args.slots.split(',')]
    for slot in slots:
        build_one(args.game,slot,args.output,args.texture,args.height)
        gc.collect()
