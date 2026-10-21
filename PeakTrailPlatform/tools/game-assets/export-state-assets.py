"""Archive original character state renderers without inventing visual telemetry.

Petrification is the complete serialized CustomizationRefs.stoneRenderers layer.
It is not a new avatar form and cannot be inferred from a normal status-bar
value. Geometry is baked in the same neutral coordinate frame as normal avatar
assets; original renderer, mesh, skinning, material and shader references remain
available as provenance. No geometry is selected by height or fabricated.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("peak_state_world", HERE / "export-world-assets.py")
world = importlib.util.module_from_spec(spec)
spec.loader.exec_module(world)


def source_ref(obj):
    return {"file": obj.assets_file.name, "pathId": obj.path_id,
            "type": obj.type.name, "name": getattr(obj.read(), "m_Name", "")}


def pointer_ref(pointer):
    return source_ref(pointer.deref()) if pointer.m_PathID else None


def source_metadata(value):
    """Retain Unity's non-finite source parameters as explicit, valid JSON tags.

    This is only for source metadata. Renderable geometry is never coerced and
    strict serialization below rejects any non-finite number escaping validation.
    """
    if isinstance(value, float) and not math.isfinite(value):
        return {"nonFiniteFloat": "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")}
    if isinstance(value, dict):
        return {key: source_metadata(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [source_metadata(item) for item in value]
    return value


class StateExporter(world.WorldExporter):
    def save(self, path, obj):
        # Unity materials may serialize Infinity (e.g. Blind._CameraFadeParams).
        # Never silently emit Python's non-standard JSON numeric literals.
        encoded = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(encoded, encoding="utf8")
        return path

    def material(self, origin, ref, role=None):
        result = super().material(origin, ref, role)
        obj = self.resolve(origin, ref)
        if obj is None:
            raise ValueError("Character state renderer references a missing material")
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
        result["sourceProperties"] = source_metadata(result["sourceProperties"])
        result["approximation"] = (
            "Original neutral mesh, source color and texture resources only; layered stone, "
            "triplanar shading, sparkle, animated _Petrify edge and lighting are not reproduced"
            if role == "petrification-overlay" else
            "Original static face-card mesh and source material resources only; live visibility and custom shader are not reproduced")
        return result

    def state_part(self, ref, index, field="stoneRenderers", role="petrification-overlay"):
        renderer = self.resolve(self.refs_obj, ref)
        if renderer is None or renderer.type.name not in ("SkinnedMeshRenderer", "MeshRenderer"):
            raise ValueError(f"{field} must reference real mesh renderers")
        data = renderer.read()
        go = data.m_GameObject.deref()
        mesh = data.m_Mesh.deref() if renderer.type.name == "SkinnedMeshRenderer" else next(
            component.read().m_Mesh.deref() for component in world.components(go)
            if component.type.name == "MeshFilter")
        part = self.renderer_model(world.pointer(renderer), role=role, origin=renderer)
        handler = world.module.MeshHandler(mesh.read())
        handler.process()
        colors = np.asarray(handler.m_Colors or [], dtype=float)
        if len(colors) == len(handler.m_Vertices):
            normalized = np.round(colors / 255, 6)
            part["colors"] = normalized[:, :3].reshape(-1).tolist()
            part["sourceVertexColors"] = {"channels": normalized.shape[1], "values": normalized.reshape(-1).tolist()}
        transform = world.transform(go)
        transform_data = transform.read_typetree()
        part["source"] = {"field": "CustomizationRefs." + field, "index": index,
                          "renderer": source_ref(renderer), "mesh": source_ref(mesh),
                          "gameObject": source_ref(go), "transform": source_ref(transform),
                          "serializedTransform": {key: transform_data[key] for key in
                              ("m_LocalPosition", "m_LocalRotation", "m_LocalScale")},
                          "serializedRendererEnabled": bool(data.m_Enabled),
                          "serializedGameObjectActive": bool(go.read().m_IsActive),
                          "vertexCount": len(handler.m_Vertices),
                          "triangleCount": sum(len(group["indices"]) // 3 for group in part["groups"])}
        if renderer.type.name == "SkinnedMeshRenderer":
            part["source"]["skinBinding"] = {
                "rootBone": pointer_ref(data.m_RootBone),
                "bones": [pointer_ref(bone) for bone in data.m_Bones],
                "bindPoseCount": len(mesh.read().m_BindPose),
                "exportedPose": "source-serialized-bones-and-bind-poses-baked-into-positions",
            }
        count = len(part["positions"]) // 3
        if not count or not np.isfinite(part["positions"]).all() or len(part["uv"]) != count * 2:
            raise ValueError("State geometry is empty, non-finite, or has mismatched UVs")
        if count != len(handler.m_Vertices):
            raise ValueError("State export must preserve every source vertex")
        for group in part["groups"]:
            if len(group["indices"]) % 3 or any(index < 0 or index >= count for index in group["indices"]):
                raise ValueError("State topology has invalid triangle indices")
        return part

    def run_states(self, standalone=False):
        if str(world.game_info(self.game)[2]) != self.build:
            raise ValueError("Requested build must match the installed game")
        catalog_path = self.root / "catalog.json"
        if standalone:
            if catalog_path.exists():
                raise ValueError("Standalone inspection requires an empty build catalog destination")
            catalog = {"schemaVersion": 1, "gameBuildId": self.build, "source": "local-unity-state-inspection",
                       "customization": {}, "assets": []}
        else:
            catalog = json.loads(catalog_path.read_text(encoding="utf8"))
            if str(catalog.get("gameBuildId")) != self.build:
                raise ValueError("State extraction requires the exact installed build catalog")
        refs = self.refs.get("stoneRenderers", [])
        if not refs:
            raise ValueError("Installed CustomizationRefs has no stoneRenderers")
        parts = [self.state_part(ref, index) for index, ref in enumerate(refs)]
        customization = self.resolve(self.refs_obj, self.refs["customization"])
        customization_data = customization.read_typetree()
        if "petrifyCurve" not in customization_data:
            raise ValueError("Installed CharacterCustomization has no serialized petrifyCurve")
        source = {"refs": source_ref(self.refs_obj), "customization": source_ref(customization),
                  "field": "CustomizationRefs.stoneRenderers", "rendererCount": len(refs),
                  "methods": ["CharacterCustomization.UpdatePetrify", "CharacterCustomization.SetPetrifyAmount",
                              "CharacterCustomization.ClearPetrify"],
                  "assemblySha256": hashlib.sha256((self.game / "PEAK_Data/Managed/Assembly-CSharp.dll").read_bytes()).hexdigest()}
        common = {"state": "petrification", "kind": "character-state-overlay",
                  "coordinateSpace": "unity-prefab-neutral-pose", "source": source,
                  "telemetrySupported": False, "availability": "archived-assets-only",
                  "telemetryUnavailableReason": "Recorder 0.8.4 does not capture shouldPetrify/passOutValue/active stone renderer evidence",
                  "runtimeBinding": {"enabledWhen": "CharacterData.shouldPetrify && visualPetrify >= 0.01",
                      "visualPetrifySource": "CharacterData.shouldPetrify ? CharacterData.passOutValue : 0",
                      "shaderProperty": "_Petrify", "shaderValue": "petrifyCurve.Evaluate(visualPetrify)",
                      "petrifyCurve": source_metadata(customization_data["petrifyCurve"]),
                      "clearOn": "CharacterCustomization.ClearPetrify when CharacterData.dead first becomes true",
                      "statusBarValueIsVisualEvidence": False},
                  "limitations": ["Entire original stoneRenderers layer, without invented head selection or height cropping",
                      "Serialized neutral pose; runtime skeleton animation is not reproduced",
                      "Source shader properties and all referenced 2D textures are archived, not an implemented Unity shader",
                      "A normal Petrify status amount alone cannot select this visual or prove its active appearance"]}
        model = self.save("models/states/petrification.json", {**common, "parts": parts})
        entry = {**common, "model": model, "selection": "all-source-stoneRenderers"}
        blind_part = self.state_part(self.refs["blindRenderer"], 0, "blindRenderer", "blindness-overlay")
        blind_source = {"refs": source_ref(self.refs_obj), "field": "CustomizationRefs.blindRenderer",
                        "rendererCount": 1, "assemblySha256": source["assemblySha256"],
                        "methods": ["Peak.Afflictions.Affliction_Blind.OnApplied",
                                    "Peak.Afflictions.Affliction_Blind.OnRemoved"]}
        blind = {"state": "blindness", "kind": "character-state-overlay",
                 "coordinateSpace": "unity-prefab-neutral-pose", "source": blind_source,
                 "telemetrySupported": False, "availability": "archived-assets-only",
                 "telemetryUnavailableReason": "Recorder 0.8.4 does not capture actual blindRenderer visibility",
                 "runtimeBinding": {"enabledBy": "Affliction_Blind.OnApplied: blindRenderer.gameObject.SetActive(true)",
                                    "disabledBy": "Affliction_Blind.OnRemoved: blindRenderer.gameObject.SetActive(false)",
                                    "visualStateMustNotBeInferred": True},
                 "limitations": ["Whole original Blind Card geometry, not a generated blindfold or height-selected face",
                                  "Source asset availability is not evidence of an active affliction or visible renderer",
                                  "Static mesh and material provenance only; no live shader or animation reconstruction"]}
        blind_model = self.save("models/states/blindness.json", {**blind, "parts": [blind_part]})
        state_visuals = catalog.setdefault("customization", {}).setdefault("stateVisuals", {})
        state_visuals["petrification"] = entry
        state_visuals["blindness"] = {**blind, "model": blind_model, "selection": "source-blindRenderer"}
        allowed = {asset["path"] for asset in catalog["assets"]}
        allowed.update((model, blind_model))
        allowed.update(self.images.values())
        catalog["assets"] = [{"path": path, "sha256": hashlib.sha256((self.root / path).read_bytes()).hexdigest(),
                              "bytes": (self.root / path).stat().st_size} for path in sorted(allowed)]
        self.save("catalog.json", catalog)
        print(json.dumps({"build": self.build, "petrification": {"model": model, "parts": len(parts),
                          "telemetrySupported": False, "source": source},
                          "blindness": {"model": blind_model, "parts": 1, "source": blind_source},
                          "assets": len(catalog["assets"])}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", default=r"C:\Program Files (x86)\Steam\steamapps\common\PEAK")
    parser.add_argument("--build", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--standalone", action="store_true", help="Create an isolated inspection catalog, never overwrite a pack")
    args = parser.parse_args()
    StateExporter(args.game, args.output, args.build).run_states(args.standalone)
