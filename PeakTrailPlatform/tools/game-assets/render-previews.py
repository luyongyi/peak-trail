"""Deterministic orthographic previews from exported Unity character geometry.

No generative images. Geometry, UVs and clothing textures are the installed game
assets; neutral pose, studio lighting and face-mask interpretation are viewer
presentation. This is an outfit reference preview, not a captured player portrait.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image


class Renderer:
    def __init__(self,root,size=384):
        self.root=Path(root); self.size=size; self.cache={}
    def texture(self,path,role):
        key=(path,role)
        if key in self.cache: return self.cache[key]
        im=np.array(Image.open(self.root/path).convert("RGBA"),dtype=float)/255
        if role=="eyes":
            red,green=im[:,:,0].copy(),im[:,:,1].copy()
            im[:,:,:3]=(1-green[:,:,None])
            im[:,:,3]=red
        elif role in ("mouth","accessory"):
            im[:,:,3]=1-np.min(im[:,:,:3],axis=2)
        self.cache[key]=im
        return im
    def render(self,parts,skin=(0.94,0.68,0.40),size=None):
        n=size or self.size
        rgba=np.zeros((n,n,4),dtype=float)
        depth=np.full((n,n),-np.inf)
        rotation=np.array([[.985,0,-.174],[-.015,.996,-.087],[.173,.087,.981]])
        points=[np.array(p["positions"]).reshape(-1,3)@rotation.T for p in parts]
        allpoints=np.concatenate(points)
        low,high=allpoints.min(0),allpoints.max(0)
        center=(low+high)/2
        scale=n*.88/max(high[0]-low[0],high[1]-low[1])
        light=np.array([-.3,.75,.65]); light/=np.linalg.norm(light)
        for part,pos in zip(parts,points):
            screen=np.column_stack(((pos[:,0]-center[0])*scale+n/2,
                                   n/2-(pos[:,1]-center[1])*scale,pos[:,2]))
            uv=np.array(part["uv"]).reshape(-1,2)
            vertex_colors=np.array(part["colors"]).reshape(-1,3) if part.get("colors") else None
            for group in part["groups"]:
                mat=group["material"]; role=mat.get("role") or part.get("role")
                texture=self.texture(mat["texture"],role) if mat.get("texture") else None
                base=np.array(list(skin)+[1]) if role=="skin" else np.array(mat.get("color",[1,1,1,1]))
                if base[3]<=0: base[3]=1
                for inds in np.array(group["indices"]).reshape(-1,3):
                    p=screen[inds]; xmin,ymin=np.maximum(np.floor(p[:,:2].min(0)).astype(int),0)
                    xmax,ymax=np.minimum(np.ceil(p[:,:2].max(0)).astype(int),n-1)
                    if xmax<xmin or ymax<ymin: continue
                    denom=(p[1,1]-p[2,1])*(p[0,0]-p[2,0])+(p[2,0]-p[1,0])*(p[0,1]-p[2,1])
                    if abs(denom)<1e-10: continue
                    yy,xx=np.mgrid[ymin:ymax+1,xmin:xmax+1]; xx=xx+.5; yy=yy+.5
                    a=((p[1,1]-p[2,1])*(xx-p[2,0])+(p[2,0]-p[1,0])*(yy-p[2,1]))/denom
                    b=((p[2,1]-p[0,1])*(xx-p[2,0])+(p[0,0]-p[2,0])*(yy-p[2,1]))/denom
                    c=1-a-b; z=a*p[0,2]+b*p[1,2]+c*p[2,2]
                    area=(a>=-1e-6)&(b>=-1e-6)&(c>=-1e-6)&(z>depth[ymin:ymax+1,xmin:xmax+1])
                    if not area.any(): continue
                    color=np.broadcast_to(base,(*a.shape,4)).copy()
                    if vertex_colors is not None:
                        col=vertex_colors[inds]
                        color[:,:,:3]*=a[:,:,None]*col[0]+b[:,:,None]*col[1]+c[:,:,None]*col[2]
                    if texture is not None:
                        t=uv[inds]; tuv=a[:,:,None]*t[0]+b[:,:,None]*t[1]+c[:,:,None]*t[2]
                        if role in ("eyes","mouth","accessory"):
                            bs={"eyes":.31,"mouth":.46,"accessory":.8}[role]
                            tuv=(tuv-.5)/bs+.5
                            inside=(tuv[:,:,0]>=0)&(tuv[:,:,0]<=1)&(tuv[:,:,1]>=0)&(tuv[:,:,1]<=1)
                            area &=inside
                            tuv=np.clip(tuv,0,1)
                        else: tuv=np.mod(tuv,1)
                        tx=np.minimum((tuv[:,:,0]*texture.shape[1]).astype(int),texture.shape[1]-1)
                        ty=np.minimum(((1-tuv[:,:,1])*texture.shape[0]).astype(int),texture.shape[0]-1)
                        color*=texture[ty,tx]
                        area &= color[:,:,3]>.35
                    normal=np.cross(pos[inds[1]]-pos[inds[0]],pos[inds[2]]-pos[inds[0]])
                    normal/=max(np.linalg.norm(normal),1e-12)
                    brightness=.7+.3*abs(np.dot(normal,light))
                    if role not in ("eyes","mouth","accessory"): color[:,:,:3]*=brightness
                    target=rgba[ymin:ymax+1,xmin:xmax+1]
                    target[area]=color[area]
                    depth[ymin:ymax+1,xmin:xmax+1][area]=z[area]
        return Image.fromarray(np.uint8(np.clip(rgba,0,1)*255),"RGBA")


def main(root):
    root=Path(root); catalog=json.loads((root/"catalog.json").read_text(encoding="utf8"))
    c=catalog["customization"]; renderer=Renderer(root)
    base=json.loads((root/c["avatar"]["model"]).read_text(encoding="utf8"))["parts"]
    # Reference outfit cards use the game's first face/skin choices, not user identity.
    for p in base:
        role=p["role"]; group={"eyes":"eyes","mouth":"mouths","accessory":"accessories"}.get(role)
        if group:
            for g in p["groups"]: g["material"]["texture"]=c[group][0].get("texture")
    base=[p for p in base if p["role"]!="accessory" or not c["accessories"][0].get("isBlank")]
    (root/"previews").mkdir(exist_ok=True)
    for option in c["fits"]:
        parts=copy.deepcopy(base)+json.loads((root/option["model"]).read_text(encoding="utf8"))["parts"]
        h=option["overrideHatIndex"] if option.get("overrideHat") else 0
        if h<len(c["hats"]): parts+=json.loads((root/c["hats"][h]["model"]).read_text(encoding="utf8"))["parts"]
        if h in (0,1) and option.get("hatMaterial"):
            for group in parts[-1]["groups"]: group["material"]=option["hatMaterial"]
        path=f"previews/fit-{option['index']}.png"
        renderer.render(parts).save(root/path)
        option.update(preview=path,previewKind="neutral-pose-game-mesh")
    for group in ("eyes","mouths","accessories"):
        role={"eyes":"eyes","mouths":"mouth","accessories":"accessory"}[group]
        for option in c[group]:
            if not option.get("texture"): continue
            path=f"previews/{group}-{option['index']}.png"
            im=renderer.texture(option["texture"],role)
            Image.fromarray(np.uint8(np.clip(im,0,1)*255),"RGBA").save(root/path)
            option.update(preview=path,textureEncoding="peak-face-mask")
    catalog["assets"]=[{"path":str(p.relative_to(root)).replace("\\","/"),"sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"bytes":p.stat().st_size}
        for p in sorted(root.rglob("*")) if p.is_file() and p.suffix in (".png",".json") and p.name!="catalog.json"]
    (root/"catalog.json").write_text(json.dumps(catalog,ensure_ascii=False,separators=(",",":")),encoding="utf8")
    print(f"Rendered {len(c['fits'])} outfit previews and decoded face previews; {len(catalog['assets'])} assets.")

if __name__=="__main__":
    p=argparse.ArgumentParser(); p.add_argument("root"); args=p.parse_args(); main(args.root)
