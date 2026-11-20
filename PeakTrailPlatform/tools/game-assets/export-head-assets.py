"""Export exact-installed-build portrait art without items, outfits or world models.

The source exporter supplies native geometry, UVs and materials. This profile
keeps every selectable face/hat and outfit hat metadata, then closes the explicit
dependency graph. No player profile or current Steam cosmetics are read.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("peak_head_base", HERE / "export-game-assets.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

REFERENCE_KEYS = {"icon", "altIcon", "preview", "texture", "model", "worldModel", "headModel", "thirdEyeModel"}


def references(value):
    if isinstance(value, list):
        for child in value:
            yield from references(child)
    elif isinstance(value, dict):
        for key, child in value.items():
            if key in REFERENCE_KEYS and isinstance(child, str):
                yield child
            elif key == "sourceProperties" and isinstance(child, dict):
                for texture in child.get("textures", []):
                    if "asset" in texture:
                        yield texture["asset"]
            else:
                yield from references(child)


def dependency_allowlist(root, customization):
    """Close references recursively; never sweep extraction output into a build."""
    root = Path(root).resolve()
    pending = list(references(customization))
    allowed = {}
    while pending:
        reference = pending.pop()
        if not isinstance(reference, str) or "\\" in reference or ":" in reference:
            raise ValueError("Invalid portrait dependency")
        if reference in allowed:
            continue
        path = (root / reference).resolve()
        if not path.is_relative_to(root) or ".." in Path(reference).parts or Path(reference).is_absolute():
            raise ValueError("Portrait dependency escapes output")
        data = path.read_bytes()
        allowed[reference] = {"path": reference, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if path.suffix == ".json":
            pending.extend(references(json.loads(data)))
    return [allowed[key] for key in sorted(allowed)]


def source_fingerprint(path):
    with path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"file": path.name, "bytes": path.stat().st_size, "sha256": checksum}


class HeadExporter(base.Exporter):
    def run_heads(self):
        if (self.root / "catalog.json").exists():
            raise ValueError("Use a new portrait output directory; an existing catalog is never overwritten")
        customization = {"sashes": [], "medals": []}
        parts = [self.renderer_model(ref, role=role) for ref, role in (
            (self.refs["PlayerRenderers"][0], "skin"),
            (self.refs["EyeRenderers"][0], "eyes"), (self.refs["EyeRenderers"][1], "eyes"),
            (self.refs["mouthRenderer"], "mouth"), (self.refs["accessoryRenderer"], "accessory"))]
        customization["avatar"] = {
            "model": self.save("models/avatar-base.json", {"purpose": "cosmetic-head", "parts": parts}),
            "coordinateSpace": "unity-prefab-neutral-pose", "rendering": "original-game-mesh-and-texture",
            **self.head_models(),
        }
        for group in ("skins", "eyes", "mouths", "accessories", "fits", "hats"):
            options = []
            for index, pointer in enumerate(self.custom_data[group]):
                obj = self.resolve(self.custom, pointer)
                data = obj.read_typetree()
                option = {"index": index, "name": data["m_Name"]}
                if group == "skins":
                    option["color"] = [data["color"][key] for key in "rgba"]
                if group in ("eyes", "mouths", "accessories"):
                    texture = self.image(obj, data.get("texture"), "customization")
                    if texture:
                        option["texture"] = texture
                        pixels = np.array(Image.open(self.root / texture).convert("RGBA"))
                        if group == "eyes":
                            alpha = pixels[:, :, 0].copy()
                            pixels[:, :, :3] = 255 - pixels[:, :, 1:2].copy()
                            pixels[:, :, 3] = alpha
                        else:
                            pixels[:, :, 3] = 255 - pixels[:, :, :3].min(axis=2)
                        preview = f"previews/{group}-{index}.png"
                        (self.root / preview).parent.mkdir(parents=True, exist_ok=True)
                        Image.fromarray(pixels).save(self.root / preview)
                        option.update(preview=preview, textureEncoding="peak-face-mask")
                if group == "accessories":
                    option.update({key: bool(data[key]) for key in ("isBlank", "drawUnderEye", "isThirdEye")})
                if group == "fits":
                    option.update(overrideHat=bool(data["overrideHat"]), overrideHatIndex=data["overrideHatIndex"])
                    material = data["fitMaterialOverrideHat"] if data["fitMaterialOverrideHat"]["m_PathID"] else data["fitMaterial"]
                    option["hatMaterial"] = self.material(obj, material, "hat")
                options.append(option)
            customization[group] = options
        catalog = {"schemaVersion": 1, "gameBuildId": self.build, "source": "local-unity-assets",
            "profile": "head-portraits", "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
            "items": [], "ui": {}, "customization": customization}
        self.complete_hat_models(catalog)
        source_names = ["resources.assets", "resources.assets.resS", "level3", "sharedassets3.assets", "sharedassets3.assets.resS"]
        catalog["sourceEvidence"] = {"installedSteamBuildId": self.build,
            "assembly": source_fingerprint(self.game / "PEAK_Data/Managed/Assembly-CSharp.dll"),
            "packaging": "direct-serialized-files", "serializedInputs": [source_fingerprint(self.data / name) for name in source_names],
            "exporters": [source_fingerprint(HERE / name) for name in ("export-head-assets.py", "export-game-assets.py")]}
        catalog["assets"] = dependency_allowlist(self.root, customization)
        self.save("catalog.json", catalog)
        base.update_build_index(self.output, self.build)
        print(json.dumps({"build": self.build, "profile": catalog["profile"],
            "options": {key: len(customization[key]) for key in ("skins", "eyes", "mouths", "accessories", "fits", "hats")},
            "assets": len(catalog["assets"]), "bytes": sum(item["bytes"] for item in catalog["assets"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", default=r"C:\Program Files (x86)\Steam\steamapps\common\PEAK")
    parser.add_argument("--output", required=True)
    parser.add_argument("--build", required=True)
    args = parser.parse_args()
    HeadExporter(args.game, args.output, args.build).run_heads()
