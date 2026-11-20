"""Export build-keyed PEAK UI art and neutral-pose character geometry.

Only reads installed Unity files. No game process, Steam calls or game-state changes.
Uses serialized Item.UIData.icon and Customization array order, never filename guesses.
"""
import argparse
import colorsys
import hashlib
import json
import os
import re
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
from PIL import Image
import UnityPy
from UnityPy.classes import PPtr
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
from UnityPy.helpers.MeshHelper import MeshHandler


# Audited W/Character bytecode and M_CrabHat are identical in builds 26155610
# and 26542162. A different source must be audited before this bake is reused.
CRAB_MATERIAL_SHA256 = "936fdee28de161984266a506148d2f27e8efaa70ab56652f2daa1d7e6f17ae34"
CHARACTER_SHADER_SHA256 = "1c35605dc84db7077d1217f0a49d95b7d07533a578e4b167bb18685cc35a4d28"


def srgb_to_linear(values):
    values = np.asarray(values, dtype=float)
    return np.where(values <= .04045, values / 12.92, ((values + .055) / 1.055) ** 2.4)


def linear_to_srgb(values):
    values = np.asarray(values, dtype=float)
    return np.where(values <= .0031308, values * 12.92, 1.055 * np.maximum(values, 0) ** (1 / 2.4) - .055)


def crab_layer_color(colors, layer_samples):
    """The verified static fragment path, before MainTex and the hue shift.

    W/Character starts with BaseColor, lerps each masked Color1..4 in order,
    then multiplies Tint. These are HDR properties already stored in linear RGB.
    Crab uses only layers 1/2; both sample TEXCOORD1, which its mesh lacks.
    """
    color = np.array([colors["_BaseColor"][key] for key in "rgb"], dtype=float)
    weights = []
    for i, sample in enumerate(layer_samples, 1):
        remap, layer = colors[f"_Remap{i}"], colors[f"_Color{i}"]
        x = np.clip((sample - remap["r"]) / (remap["g"] - remap["r"]), 0, 1)
        weight = float(x * x * (3 - 2 * x) * layer["a"])
        color += (np.array([layer[key] for key in "rgb"]) - color) * weight
        weights.append(weight)
    color *= [colors["_Tint"][key] for key in "rgb"]
    hue_delta = sum(weight * colors["_HueShifts"][key] for weight, key in zip(weights, "rg"))
    return color, weights, hue_delta


def bake_crab_pixels(pixels, layer_color, hue_delta, hue_strength):
    """Bake albedo only; retain the native alpha and leave lighting to the viewer."""
    result = np.array(pixels, dtype=np.uint8, copy=True)
    rgb = srgb_to_linear(result[:, :, :3] / 255) * layer_color
    flat = rgb.reshape(-1, 3)
    shifted = np.empty_like(flat)
    for i, pixel in enumerate(flat):
        h, s, v = colorsys.rgb_to_hsv(*pixel)
        shifted[i] = colorsys.hsv_to_rgb((h + hue_delta) % 1, s, v)
    rgb += (shifted.reshape(rgb.shape) - rgb) * hue_strength
    result[:, :, :3] = np.rint(np.clip(linear_to_srgb(rgb), 0, 1) * 255).astype(np.uint8)
    return result


def slug(value):
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-") or "asset"


def verify_installed_build(game, build):
    if not re.fullmatch(r"[1-9]\d*", str(build)):
        raise ValueError("A numeric Steam build ID is required")
    manifest = Path(game).parent.parent / "appmanifest_3527290.acf"
    match = re.search(r'"buildid"\s+"(\d+)"', manifest.read_text(encoding="utf8"))
    if not match or match.group(1) != str(build):
        raise ValueError("Requested asset build does not match the installed Steam build")


def update_build_index(output, build):
    if not re.fullmatch(r"[1-9]\d*", str(build)):
        raise ValueError("A numeric Steam build ID is required")
    path = Path(output) / "catalog.json"
    index = json.loads(path.read_text(encoding="utf8")) if path.exists() else {"schemaVersion": 1, "builds": []}
    if index.get("schemaVersion") != 1 or not isinstance(index.get("builds"), list):
        raise ValueError("Invalid existing game-assets index")
    entries = {}
    for entry in index["builds"]:
        key = str(entry.get("gameBuildId", ""))
        if not re.fullmatch(r"[1-9]\d*", key) or key in entries or entry.get("catalog") != f"{key}/catalog.json":
            raise ValueError("Invalid existing game-assets build reference")
        entries[key] = entry
    entries[str(build)] = {"gameBuildId": str(build), "catalog": f"{build}/catalog.json"}
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps({"schemaVersion": 1, "builds": [entries[key] for key in sorted(entries, key=int)]}, indent=2), encoding="utf8")
    os.replace(temporary, path)


class Exporter:
    def __init__(self, game, output, build):
        self.game, self.output, self.build = Path(game), Path(output), str(build)
        verify_installed_build(self.game, self.build)
        self.root = self.output / self.build
        self.root.mkdir(parents=True, exist_ok=True)
        self.data = Path(os.environ.get("PEAK_TRAIL_GAME_DATA", self.game / "PEAK_Data"))
        self.env = UnityPy.load(*[str(self.data / f) for f in
            ["resources.assets", "level3", "sharedassets3.assets"]])
        generator = TypeTreeGenerator(self.env.objects[0].assets_file.unity_version)
        generator.load_local_game(str(self.game))
        self.env.typetree_generator = generator
        self.images, self.matrices, self.models = {}, {}, {}
        self.objects = list(self.env.objects)
        self.behaviours = []
        for obj in self.objects:
            if obj.type.name != "MonoBehaviour": continue
            head = obj.parse_monobehaviour_head()
            if head.m_Script.m_PathID:
                name = head.m_Script.read().m_ClassName
                self.behaviours.append((name,obj))
        self.custom = next(o for c,o in self.behaviours if c == "Customization")
        self.custom_data = self.custom.read_typetree()
        self.refs_obj = next(o for c,o in self.behaviours if c == "CustomizationRefs"
                             and o.assets_file.name == "sharedassets3.assets")
        self.refs = self.refs_obj.read_typetree()

    def resolve(self, origin, pointer):
        if not pointer or not pointer.get("m_PathID"): return None
        return PPtr(**pointer, assetsfile=origin.assets_file).deref()

    def save(self, path, obj):
        target = self.root / path
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(obj,ensure_ascii=False,separators=(",",":")),encoding="utf8")
        return path

    def image(self, origin, pointer, group="textures"):
        obj = self.resolve(origin,pointer)
        if obj is None: return None
        key = (obj.assets_file.name,obj.path_id)
        if key in self.images: return self.images[key]
        data=obj.read()
        path=f"{group}/{slug(data.m_Name)}-{slug(obj.assets_file.name)}-{obj.path_id}.png"
        target=self.root/path
        target.parent.mkdir(parents=True,exist_ok=True)
        data.image.save(target)
        self.images[key]=path
        return path

    def material(self, origin, pointer, role=None):
        obj=self.resolve(origin,pointer)
        if obj is None: return {"color":[0.6,0.6,0.6,1],"role":role}
        data=obj.read_typetree()
        props=data["m_SavedProperties"]
        colors=dict(props.get("m_Colors",[]))
        textures=dict(props.get("m_TexEnvs",[]))
        col=colors.get("_BaseColor",colors.get("_Color",{"r":1,"g":1,"b":1,"a":1}))
        tex=textures.get("_BaseMap",textures.get("_MainTex"))
        result={"name":data["m_Name"],"color":[col[k] for k in "rgba"],"role":role}
        floats=dict(props.get("m_Floats",[]))
        if role in ("eyes","mouth","accessory","third-eye"):
            result["faceScale"]=floats.get("_BaseScale",1)
            result["pupilScale"]=floats.get("_PupilScale",1)
            result["faceOffset"]=[colors.get("_EyePosition",{}).get(k,0) for k in "rg"]
        if tex:
            result["texture"]=self.image(obj,tex["m_Texture"])
            result["textureScale"]=[tex["m_Scale"][k] for k in "xy"]
            result["textureOffset"]=[tex["m_Offset"][k] for k in "xy"]
        if "_SkinColor" in colors:
            result["skinColor"]=[colors["_SkinColor"][k] for k in "rgba"]
        return result

    def bake_hat_material(self, origin, pointer, handler, material):
        """Repair only the source-verified Crab albedo, never a generic tint guess."""
        if self.build not in ("26155610", "26542162"): return material
        obj = self.resolve(origin, pointer)
        if obj is None or material.get("name") != "M_CrabHat": return material
        shader = obj.read().m_Shader.deref()
        if (hashlib.sha256(obj.get_raw_data()).hexdigest() != CRAB_MATERIAL_SHA256
                or hashlib.sha256(shader.get_raw_data()).hexdigest() != CHARACTER_SHADER_SHA256):
            raise ValueError("Crab source material/shader changed; audit its albedo before export")
        if handler.m_UV1 or handler.m_Colors:
            raise ValueError("Crab mesh gained secondary UVs/vertex colors; static albedo bake is not valid")
        props = obj.read_typetree()["m_SavedProperties"]
        colors, floats, textures = (dict(props[key]) for key in ("m_Colors", "m_Floats", "m_TexEnvs"))
        samples, sources = [], []
        for i in (1, 2):
            texture = self.resolve(obj, textures[f"_Texture{i}"]["m_Texture"])
            data = texture.read()
            settings = data.m_TextureSettings
            if (data.m_ColorSpace, settings.m_FilterMode, settings.m_WrapU, settings.m_WrapV) != (1, 1, 0, 0):
                raise ValueError("Crab layer sampler changed; expected bilinear repeat sRGB")
            pixels = np.array(data.image.convert("RGBA"))
            # At UV=(0,0), repeat bilinear filtering averages all four corners.
            # sRGB is decoded before filtering, exactly as the source GPU sampler.
            samples.append(float(srgb_to_linear(pixels[np.array([0, 0, -1, -1]), np.array([0, -1, 0, -1]), 0] / 255).mean()))
            sources.append({"property": f"_Texture{i}", "assetFile": texture.assets_file.name,
                "pathId": texture.path_id, "sampleLinear": samples[-1]})
        layer_color, weights, hue_delta = crab_layer_color(colors, samples)
        source_texture = material["texture"]
        source_pixels = np.array(Image.open(self.root / source_texture).convert("RGBA"))
        path = str(Path(source_texture).with_name(Path(source_texture).stem + "-character-albedo-v1.png")).replace("\\", "/")
        Image.fromarray(bake_crab_pixels(source_pixels, layer_color, hue_delta, floats["_HueStr"])).save(self.root / path)
        return {**material, "color": [1, 1, 1, material["color"][3]], "colorSpace": "linear", "texture": path,
            "sourceProperties": {"shader": "W/Character", "materialAsset": obj.assets_file.name,
                "materialPathId": obj.path_id, "materialSha256": CRAB_MATERIAL_SHA256,
                "shaderSha256": CHARACTER_SHADER_SHA256,
                "textures": [{"property": "_MainTex", "asset": source_texture}],
                "albedoBake": "character-crab-static-uv1-v1", "layerUv": [0, 0], "layerSamples": sources,
                "layerWeights": weights, "hueDelta": hue_delta, "hueStrength": floats["_HueStr"],
                "baseColor": [colors["_BaseColor"][key] for key in "rgba"],
                "tint": [colors["_Tint"][key] for key in "rgba"]}}

    def transform(self, obj):
        key=(obj.assets_file.name,obj.path_id)
        if key in self.matrices: return self.matrices[key]
        d=obj.read()
        q=d.m_LocalRotation; x,y,z,w=q.x,q.y,q.z,q.w
        m=np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w,0],
                    [2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w,0],
                    [2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y,0],[0,0,0,1]],dtype=float)
        m[:3,:3] *= [d.m_LocalScale.x,d.m_LocalScale.y,d.m_LocalScale.z]
        m[:3,3] = [d.m_LocalPosition.x,d.m_LocalPosition.y,d.m_LocalPosition.z]
        if d.m_Father.m_PathID: m=self.transform(d.m_Father.deref())@m
        self.matrices[key]=m
        return m

    def renderer_model(self, pointer, mesh_override=None, material_overrides=None, role=None, origin=None):
        obj=self.resolve(origin or self.refs_obj,pointer)
        d=obj.read()
        go=d.m_GameObject.read()
        comps=[c.component.deref() for c in go.m_Component]
        trans=next(c for c in comps if c.type.name=="Transform")
        if obj.type.name=="SkinnedMeshRenderer":
            mesh_obj=mesh_override or d.m_Mesh.deref()
        else:
            mf=next(c for c in comps if c.type.name=="MeshFilter").read()
            mesh_obj=mesh_override or mf.m_Mesh.deref()
        mesh=mesh_obj.read(); handler=MeshHandler(mesh); handler.process()
        verts=np.array(handler.m_Vertices,dtype=float)
        v4=np.concatenate((verts,np.ones((len(verts),1))),axis=1)
        if obj.type.name=="SkinnedMeshRenderer" and handler.m_BoneWeights and mesh.m_BindPose:
            mats=[]
            for i,b in enumerate(d.m_Bones):
                bp=mesh.m_BindPose[i]
                mat=np.array([[getattr(bp,f"e{r}{c}") for c in range(4)] for r in range(4)])
                mats.append(self.transform(b.deref())@mat)
            mats=np.array(mats)
            inds=np.array(handler.m_BoneIndices,dtype=int)
            weights=np.array(handler.m_BoneWeights,dtype=float)
            verts=np.einsum("vk,vkij,vj->vi",weights,mats[inds],v4)[:,:3]
        else: verts=(self.transform(trans)@v4.T).T[:,:3]
        # Return Unity coordinates unchanged; the web renderer uses the same axes.
        materials=material_overrides or [self.material(obj,{"m_FileID":p.m_FileID,"m_PathID":p.m_PathID},role) for p in d.m_Materials]
        if role == "hat" and not material_overrides:
            materials = [self.bake_hat_material(obj, {"m_FileID":p.m_FileID,"m_PathID":p.m_PathID}, handler, material)
                for p, material in zip(d.m_Materials, materials)]
        return {"name":go.m_Name,"role":role,"positions":np.round(verts,6).reshape(-1).tolist(),
                "uv":np.round(np.array(handler.m_UV0 or [[0,0]]*len(verts))[:,:2],6).reshape(-1).tolist(),
                "groups":[{"indices":np.array(tris,dtype=int).reshape(-1).tolist(),"material":materials[min(i,len(materials)-1)]}
                    for i,tris in enumerate(handler.get_triangles())]}

    def head_models(self):
        """Third-eye cosmetics use a separate real renderer, not the accessory card."""
        obj=self.resolve(self.refs_obj,self.refs.get("thirdEye"))
        if obj is None: return {}
        parts=[]
        for component in obj.read().m_Component:
            renderer=component.component.deref()
            if renderer.type.name not in ("MeshRenderer","SkinnedMeshRenderer"): continue
            pointer={"m_FileID":component.component.m_FileID,"m_PathID":component.component.m_PathID}
            parts.append(self.renderer_model(pointer,role="third-eye",origin=obj))
        if not parts: return {}
        for part in parts:
            for group in part["groups"]:
                material=group["material"]
                if not material.get("texture"): continue
                # Face masks keep meaningful RGB under transparent alpha. Decode
                # before browser PNG premultiplication can discard those values.
                pixels=np.array(Image.open(self.root/material["texture"]).convert("RGBA"))
                alpha=pixels[:,:,0].copy()
                shade=255-pixels[:,:,1].copy()
                pixels[:,:,:3]=shade[:,:,None]
                pixels[:,:,3]=alpha
                preview="previews/head-third-eye.png"
                (self.root/preview).parent.mkdir(parents=True,exist_ok=True)
                Image.fromarray(pixels).save(self.root/preview)
                material.update(preview=preview,textureEncoding="peak-face-mask")
        return {"thirdEyeModel":self.save("models/head-third-eye.json",{"parts":parts})}

    def update_head_models(self):
        """Add head-only resources without discarding existing decoded previews."""
        catalog_path=self.root/"catalog.json"
        catalog=json.loads(catalog_path.read_text(encoding="utf8"))
        if str(catalog.get("gameBuildId"))!=self.build:
            raise ValueError("Head export requires the exact installed build catalog")
        catalog["customization"]["avatar"].update(self.head_models())
        catalog["assets"]=[{"path":str(p.relative_to(self.root)).replace("\\","/"),
                            "sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"bytes":p.stat().st_size}
            for p in sorted(self.root.rglob("*")) if p.is_file() and p.suffix in (".png",".json") and p.name!="catalog.json"]
        self.save("catalog.json",catalog)
        print(json.dumps({"head":catalog["customization"]["avatar"],"assets":len(catalog["assets"])}))

    def complete_hat_models(self, catalog):
        """Outfit overrides also reference non-selectable playerHats entries."""
        hats = catalog["customization"]["hats"]
        indexed = {entry["index"]: entry for entry in hats}
        added = []
        for index, ref in enumerate(self.refs["playerHats"]):
            if index in indexed and indexed[index].get("model"):
                continue
            renderer = self.resolve(self.refs_obj, ref)
            if renderer is None:
                raise ValueError(f"Native hat renderer {index} is unavailable")
            option = indexed.get(index)
            if option is None:
                option = {"index": index, "name": renderer.read().m_GameObject.read().m_Name, "selectable": False}
                hats.append(option)
            option["model"] = self.save(f"models/hat-{index}.json", {"parts": [self.renderer_model(ref, role="hat")]})
            option["sourceRenderer"] = {"asset": renderer.assets_file.name, "pathId": renderer.path_id}
            added.append(option["model"])
        hats.sort(key=lambda option: option["index"])
        for outfit in catalog["customization"]["fits"]:
            if outfit.get("overrideHat") and outfit.get("overrideHatIndex") not in {entry["index"] for entry in hats}:
                raise ValueError("An outfit override refers to an unavailable native hat")
        return added

    def update_extra_hat_models(self):
        catalog = json.loads((self.root / "catalog.json").read_text(encoding="utf8"))
        if str(catalog.get("gameBuildId")) != self.build:
            raise ValueError("Hat completion requires the exact installed build catalog")
        added = self.complete_hat_models(catalog)
        allowed = {entry["path"] for entry in catalog["assets"]} | set(added) | set(self.images.values())
        catalog["assets"] = [{"path": path, "sha256": hashlib.sha256((self.root / path).read_bytes()).hexdigest(),
                              "bytes": (self.root / path).stat().st_size} for path in sorted(allowed)]
        self.save("catalog.json", catalog)
        print(json.dumps({"nativeHatRenderers": len(self.refs["playerHats"]), "added": added, "assets": len(catalog["assets"])}))

    def run(self):
        catalog={"schemaVersion":1,"gameBuildId":self.build,"source":"local-unity-assets",
                 "generatedAtUtc":datetime.now(timezone.utc).isoformat(),"items":[],"ui":{},"customization":{}}
        items={}
        database=next(o for classname,o in self.behaviours if classname=="ItemDatabase")
        canonical=database.read_typetree()["Objects"]
        for pointer in canonical:
            obj=self.resolve(database,pointer)
            data=obj.read_typetree()
            if not data.get("UIData"): continue
            ui=data["UIData"]
            icon=self.image(obj,ui["icon"],"icons")
            go=self.resolve(obj,data["m_GameObject"])
            item={"itemId":data["itemID"],"prefabName":go.read().m_Name,"name":ui["itemName"],"icon":icon}
            if not icon: item["iconUnavailableReason"]="game-item-ui-icon-is-null"
            if ui.get("hasAltIcon"): item["altIcon"]=self.image(obj,ui["altIcon"],"icons")
            items[(item["itemId"],item["prefabName"])]=item
        catalog["items"]=sorted(items.values(),key=lambda item:(item["itemId"],item["prefabName"]))
        for classname,obj in self.behaviours:
            if classname!="InventoryItemUI": continue
            data=obj.read_typetree()
            for key in ("defaultIcon","backpackIcon","carryingIcon"):
                image=self.image(obj,data.get(key),"ui")
                if image: catalog["ui"][key]=image
            for key in ("fill","outline","selectedSlotIcon"):
                image_obj=self.resolve(obj,data.get(key))
                if image_obj:
                    image=self.image(image_obj,image_obj.read_typetree().get("m_Sprite"),"ui")
                    if image: catalog["ui"][key]=image
        base=[]
        # PlayerRenderers[0] is the head; remaining PlayerRenderers include body/eyes.
        for ref,role in [(self.refs["PlayerRenderers"][0],"skin"),
                         (self.refs["EyeRenderers"][0],"eyes"),(self.refs["EyeRenderers"][1],"eyes"),
                         (self.refs["mouthRenderer"],"mouth"),(self.refs["accessoryRenderer"],"accessory")]:
            base.append(self.renderer_model(ref,role=role))
        catalog["customization"]["avatar"]={"model":self.save("models/avatar-base.json",{"parts":base}),
            "coordinateSpace":"unity-prefab-neutral-pose","rendering":"original-game-mesh-and-texture"}
        catalog["customization"]["avatar"].update(self.head_models())
        for group in ("skins","eyes","mouths","accessories","fits","hats","sashes","medals"):
            options=[]
            for index,ptr in enumerate(self.custom_data[group]):
                obj=self.resolve(self.custom,ptr); data=obj.read_typetree()
                option={"index":index,"name":data["m_Name"]}
                texture=self.image(obj,data.get("texture"),"customization")
                if texture: option["texture"]=texture
                if group=="skins": option["color"]=[data["color"][k] for k in "rgba"]
                if group=="accessories":
                    option.update({key:bool(data[key]) for key in ("isBlank","drawUnderEye","isThirdEye")})
                if group=="fits":
                    option.update({key:bool(data[key]) for key in ("isSkirt","noPants","overrideHat")})
                    option["overrideHatIndex"]=data["overrideHatIndex"]
                    mesh=self.resolve(obj,data["fitMesh"])
                    main=self.resolve(self.refs_obj,self.refs["mainRenderer"])
                    skinmat=main.read().m_Materials[0]
                    mats=[self.material(main,{"m_FileID":skinmat.m_FileID,"m_PathID":skinmat.m_PathID},"skin"),
                          self.material(obj,data["fitMaterial"],"outfit"),self.material(obj,data["fitMaterialShoes"],"shoes")]
                    parts=[self.renderer_model(self.refs["mainRenderer"],mesh,mats,"body")]
                    if not data["noPants"]:
                        pants=data["fitMaterialOverridePants"] if data["fitMaterialOverridePants"]["m_PathID"] else data["fitMaterial"]
                        parts.append(self.renderer_model(self.refs["skirt" if data["isSkirt"] else "shorts"],material_overrides=[self.material(obj,pants,"outfit")]))
                    option["model"]=self.save(f"models/fit-{index}.json",{"parts":parts})
                    hat_material=data["fitMaterialOverrideHat"] if data["fitMaterialOverrideHat"]["m_PathID"] else data["fitMaterial"]
                    option["hatMaterial"]=self.material(obj,hat_material,"hat")
                if group=="hats" and index<len(self.refs["playerHats"]):
                    option["model"]=self.save(f"models/hat-{index}.json",{"parts":[self.renderer_model(self.refs["playerHats"][index],role="hat")]})
                if group=="sashes":
                    sash=self.resolve(self.refs_obj,self.refs["sashRenderer"])
                    mat=sash.read().m_Materials[0]
                    materials=[self.material(sash,{"m_FileID":mat.m_FileID,"m_PathID":mat.m_PathID},"sash"),
                               self.material(self.refs_obj,self.refs["sashAscentMaterials"][index],"sash")]
                    option["model"]=self.save(f"models/sash-{index}.json",{"parts":[self.renderer_model(self.refs["sashRenderer"],material_overrides=materials,role="sash")]})
                if group=="medals" and index==1:
                    option["model"]=self.save(f"models/medal-{index}.json",{"parts":[self.renderer_model(self.refs["medalRenderer"],role="medal")]})
                options.append(option)
            catalog["customization"][group]=options
        self.complete_hat_models(catalog)
        # Keep generated geometry/PNGs under a strict deploy allowlist.
        catalog["assets"]=[{"path":str(p.relative_to(self.root)).replace("\\","/"),
                            "sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"bytes":p.stat().st_size}
            for p in sorted(self.root.rglob("*")) if p.is_file() and p.suffix in (".png",".json") and p.name!="catalog.json"]
        self.save("catalog.json",catalog)
        update_build_index(self.output, self.build)
        print(json.dumps({"items":len(catalog["items"]),"textures":len(self.images),"assets":len(catalog["assets"]),"output":str(self.root)}))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--game",default=r"C:\Program Files (x86)\Steam\steamapps\common\PEAK")
    parser.add_argument("--output",default=str(Path(__file__).resolve().parents[3]/"local/assets/game-assets"))
    parser.add_argument("--build",default="25306743")
    parser.add_argument("--head-only",action="store_true",help="Add separate head cosmetic models to an existing catalog")
    parser.add_argument("--extra-hats-only",action="store_true",help="Add all native outfit-override hats to an existing catalog")
    args=parser.parse_args()
    exporter=Exporter(args.game,args.output,args.build)
    if args.head_only and args.extra_hats_only:
        parser.error("Choose one additive export mode")
    if args.head_only: exporter.update_head_models()
    elif args.extra_hats_only: exporter.update_extra_hat_models()
    else: exporter.run()
