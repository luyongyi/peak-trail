"""Archive the original PlayerGhost prefab without claiming ghost telemetry.

The source has one unskinned ghost mesh, not a separately selectable head. The
portrait derivative therefore contains the whole source form and is labelled
accordingly. Owner customization is a binding contract, never a guessed owner
or the serialized prefab's default face. This additive tool preserves a pack's
existing catalog and assets. Use --standalone only for an isolated inspection.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("peak_ghost_world", HERE / "export-world-assets.py")
world = importlib.util.module_from_spec(spec)
spec.loader.exec_module(world)


def source_ref(obj):
    return {"file": obj.assets_file.name, "pathId": obj.path_id,
            "type": obj.type.name, "name": getattr(obj.read(), "m_Name", "")}


class GhostExporter(world.WorldExporter):
    def material(self, origin, ref, role=None):
        result = super().material(origin, ref, role)
        obj = self.resolve(origin, ref)
        if obj is None:
            raise ValueError("Ghost renderer references a missing material")
        data = obj.read_typetree()
        shader = self.resolve(obj, data["m_Shader"])
        saved = data["m_SavedProperties"]
        result["source"] = source_ref(obj)
        result["sourceShader"] = source_ref(shader)
        result["sourceProperties"] = {
            "floats": dict(saved.get("m_Floats", [])),
            "ints": dict(saved.get("m_Ints", [])),
            "colors": dict(saved.get("m_Colors", [])),
            "textures": [],
        }
        for property_name, texture in saved.get("m_TexEnvs", []):
            texture_obj = self.resolve(obj, texture["m_Texture"])
            if texture_obj is None:
                continue
            exported = self.image(obj, texture["m_Texture"])
            entry = {"property": property_name, "source": source_ref(texture_obj),
                     "scale": texture["m_Scale"], "offset": texture["m_Offset"]}
            if exported:
                entry["asset"] = exported
            else:
                entry["unavailableReason"] = "source-is-not-a-2d-texture-or-sprite"
            result["sourceProperties"]["textures"].append(entry)
        bindings = []
        if role == "ghost-body":
            bindings.append({"property": "_PlayerColor", "appearanceField": "skinIndex",
                             "catalogCollection": "skins", "valueField": "color"})
        if role == "eyes":
            bindings.append({"property": "_SkinColor", "appearanceField": "skinIndex",
                             "catalogCollection": "skins", "valueField": "color"})
        if role in ("eyes", "mouth", "accessory"):
            field, collection = {"eyes": ("eyesIndex", "eyes"), "mouth": ("mouthIndex", "mouths"),
                                 "accessory": ("accessoryIndex", "accessories")}[role]
            bindings.append({"property": "_MainTex", "appearanceField": field,
                             "catalogCollection": collection, "valueField": "texture"})
        result["ownerBindings"] = bindings
        result["bindingSource"] = "PlayerGhost.CustomizeGhost(PersistentPlayerData)"
        result["serializedValuesAreOwnerAppearance"] = False
        result["approximation"] = (
            "Static original mesh and face masks only; PlayerGhost procedural 3D noise, "
            "Fresnel, fading, animation and camera-dependent shader are not reproduced")
        return result

    def ghost_part(self, component, renderer_ref, role, inverse_root):
        renderer = self.resolve(component, renderer_ref)
        data = renderer.read()
        go = data.m_GameObject.deref()
        mesh = data.m_Mesh.deref() if renderer.type.name == "SkinnedMeshRenderer" else next(
            item.read().m_Mesh.deref() for item in world.components(go) if item.type.name == "MeshFilter")
        part = self.renderer_model(world.pointer(renderer), role=role, origin=renderer)
        part["positions"] = world.relative_positions(part["positions"], inverse_root)
        handler = world.module.MeshHandler(mesh.read())
        handler.process()
        colors = np.asarray(handler.m_Colors or [], dtype=float)
        if len(colors) == len(handler.m_Vertices):
            part["colors"] = np.round(colors[:, :3] / 255, 6).reshape(-1).tolist()
        part["source"] = {"renderer": source_ref(renderer), "mesh": source_ref(mesh),
                          "gameObject": source_ref(go), "vertexCount": len(handler.m_Vertices),
                          "triangleCount": sum(len(group["indices"]) // 3 for group in part["groups"])}
        if role == "accessory":
            part["visibleWhen"] = {"appearanceField": "accessoryIndex", "operator": "not-equal", "value": 20}
        if role == "third-eye":
            part["visibleWhen"] = {"appearanceField": "accessoryIndex", "operator": "equal", "value": 20}
        count = len(part["positions"]) // 3
        if not count or not np.isfinite(part["positions"]).all() or len(part["uv"]) != count * 2:
            raise ValueError("Ghost geometry is empty, non-finite, or has mismatched UVs")
        for group in part["groups"]:
            if len(group["indices"]) % 3 or any(index < 0 or index >= count for index in group["indices"]):
                raise ValueError("Ghost topology has invalid triangle indices")
        return part

    def run_ghost(self, standalone=False):
        if str(world.game_info(self.game)[2]) != self.build:
            raise ValueError("Requested build must match the installed game")
        catalog_path = self.root / "catalog.json"
        if standalone:
            if catalog_path.exists():
                raise ValueError("Standalone inspection requires an empty build catalog destination")
            catalog = {"schemaVersion": 1, "gameBuildId": self.build, "source": "local-unity-ghost-inspection",
                       "customization": {}, "assets": []}
        else:
            catalog = json.loads(catalog_path.read_text(encoding="utf8"))
            if str(catalog.get("gameBuildId")) != self.build:
                raise ValueError("Ghost extraction requires the exact installed build catalog")
        candidates = [obj for name, obj in self.behaviours if name == "PlayerGhost"]
        if len(candidates) != 1:
            raise ValueError(f"Expected one serialized PlayerGhost prefab, found {len(candidates)}")
        component = candidates[0]
        data = component.read_typetree()
        prefab = self.resolve(component, data["m_GameObject"])
        inverse_root = np.linalg.inv(self.transform(world.transform(prefab)))
        selected = [(ref, "ghost-body") for ref in data["PlayerRenderers"]]
        selected += [(ref, "eyes") for ref in data["EyeRenderers"]]
        selected += [(data["mouthRenderer"], "mouth"), (data["accessoryRenderer"], "accessory")]
        parts = [self.ghost_part(component, ref, role, inverse_root) for ref, role in selected]
        third_eye = self.resolve(component, data["thirdEye"])
        third_parts = []
        for go in world.walk(third_eye, include_inactive=True):
            for renderer in world.components(go):
                if renderer.type.name in ("MeshRenderer", "SkinnedMeshRenderer"):
                    third_parts.append(self.ghost_part(renderer, world.pointer(renderer), "third-eye", inverse_root))
        source = {"prefab": source_ref(prefab), "component": source_ref(component),
                  "customizationMethod": "PlayerGhost.CustomizeGhost",
                  "ownerMethod": "PlayerGhost.RPCA_InitGhost: character.GetComponent<Character>()",
                  "assemblySha256": hashlib.sha256((self.game / "PEAK_Data/Managed/Assembly-CSharp.dll").read_bytes()).hexdigest()}
        common = {"form": "ghost", "coordinateSpace": "unity-prefab-local-meters", "source": source,
                  "telemetrySupported": False, "availability": "archived-assets-only",
                  "telemetryUnavailableReason": "Recorder 0.8.4 has no PlayerGhost instance/owner/position telemetry; dead does not imply ghost",
                  "appearanceSource": "explicit-ghost-owner-persistent-customization",
                  "requiresOwnerAppearance": True, "retainHat": False,
                  "limitations": ["Neutral serialized geometry; no dynamic PlayerGhost shader reconstruction",
                                  "No separate source head or head bones; portrait uses the whole original ghost form",
                                  "No inferred instance, owner, position, rotation or lifetime",
                                  "Original game hides this ghost's renderers for its owning local player"]}
        model = self.save("models/forms/ghost.json", {**common, "parts": parts})
        head = self.save("models/forms/ghost-head.json", {**common, "purpose": "form-head",
                         "portraitScope": "whole-form-no-separate-head", "parts": copy.deepcopy(parts)})
        third = self.save("models/forms/ghost-third-eye.json", {**common, "purpose": "conditional-third-eye",
                          "visibleWhen": {"appearanceField": "accessoryIndex", "operator": "equal", "value": 20},
                          "parts": third_parts})
        entry = {**common, "model": model, "headModel": head, "thirdEyeModel": third,
                 "portraitScope": "whole-form-no-separate-head",
                 "ownerAppearanceFields": ["skinIndex", "eyesIndex", "mouthIndex", "accessoryIndex"],
                 "unusedOwnerAppearanceFields": ["outfitIndex", "hatIndex", "sashIndex", "medalIndex"]}
        # Deliberately outside forms[]: archived availability must not make a
        # currently unsupported telemetry form appear selectable in the viewer.
        catalog.setdefault("customization", {})["ghost"] = entry
        allowed = {asset["path"] for asset in catalog["assets"]}
        allowed.update((model, head, third))
        allowed.update(self.images.values())
        catalog["assets"] = [{"path": path, "sha256": hashlib.sha256((self.root / path).read_bytes()).hexdigest(),
                              "bytes": (self.root / path).stat().st_size} for path in sorted(allowed)]
        self.save("catalog.json", catalog)
        print(json.dumps({"build": self.build, "ghost": {"model": model, "headModel": head,
              "thirdEyeModel": third, "telemetrySupported": False, "source": source},
              "parts": len(parts), "thirdEyeParts": len(third_parts), "assets": len(catalog["assets"])}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", default=r"C:\Program Files (x86)\Steam\steamapps\common\PEAK")
    parser.add_argument("--build", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--standalone", action="store_true", help="Create an isolated inspection catalog, never overwrite a pack")
    args = parser.parse_args()
    GhostExporter(args.game, args.output, args.build).run_ghost(args.standalone)
