"""Add live-state portrait derivatives without changing published source models.

Only the source's separate Statue head renderer can become the stone portrait.
The ghost third eye keeps its own geometry and decodes hidden face-mask RGB
offline, before browser image APIs can discard RGB below zero alpha.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


def child(root, reference):
    path = (root / reference).resolve()
    if not path.is_relative_to(root.resolve()) or ".." in Path(reference).parts:
        raise ValueError("Asset reference escapes build directory")
    return path


def save(root, reference, value):
    path = child(root, reference)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf8")
    return reference


def prepare(root):
    root = Path(root).resolve()
    catalog = json.loads((root / "catalog.json").read_text(encoding="utf8"))
    for asset in catalog["assets"]:
        data = child(root, asset["path"]).read_bytes()
        if len(data) != asset["bytes"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
            raise ValueError("Source asset differs from its published allowlist")
    customization = catalog["customization"]
    stone = customization["stateVisuals"]["petrification"]
    model = json.loads(child(root, stone["model"]).read_text(encoding="utf8"))
    heads = [part for part in model["parts"]
             if part.get("source", {}).get("field") == "CustomizationRefs.stoneRenderers"
             and part.get("source", {}).get("mesh", {}).get("name") == "Statue head"]
    if len(heads) != 1:
        raise ValueError("A single original, separate Statue head renderer is required")
    head = {"state": "petrification", "purpose": "state-head",
            "portraitScope": "source-separate-head-renderer", "coordinateSpace": model["coordinateSpace"],
            "source": {"selection": "original-separate-renderer", "renderer": heads[0]["source"]["renderer"],
                       "mesh": heads[0]["source"]["mesh"]}, "parts": copy.deepcopy(heads)}
    stone["headModel"] = save(root, "models/states/petrification-head.json", head)
    stone["portraitScope"] = head["portraitScope"]

    ghost = customization["ghost"]
    third = json.loads(child(root, ghost["thirdEyeModel"]).read_text(encoding="utf8"))
    previews = []
    for index, part in enumerate(third["parts"]):
        for group_index, group in enumerate(part["groups"]):
            material = group["material"]
            source = np.asarray(Image.open(child(root, material["texture"])).convert("RGBA"), dtype=np.uint8)
            rgba = np.empty_like(source)
            rgba[:, :, :3] = 255 - source[:, :, 1:2]
            rgba[:, :, 3] = source[:, :, 0]
            preview = f"previews/ghost-third-eye-{index}-{group_index}.png"
            target = child(root, preview)
            target.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(rgba).save(target)
            material.update(preview=preview, textureEncoding="peak-face-mask")
            previews.append(preview)
    if not previews:
        raise ValueError("Original ghost third-eye face cards are missing")
    ghost["thirdEyeModel"] = save(root, "models/forms/ghost-third-eye-live.json", third)

    for entry in (ghost, stone, customization["stateVisuals"]["blindness"]):
        entry.update(telemetrySupported=True, minimumRecorderVersion="0.8.5", availability="recorded-runtime-state")
        entry.pop("telemetryUnavailableReason", None)
    ghost["telemetryFields"] = ["ghostReady", "ghostActive", "ghostVisible", "ghostPosition", "ghostRotation"]
    stone["telemetryFields"] = ["petrificationReady", "petrificationActive", "petrificationTriggered", "petrificationProgress", "petrificationAmount"]
    customization["stateVisuals"]["blindness"]["telemetryFields"] = ["blindnessReady", "blindnessActive"]
    allowed = {asset["path"] for asset in catalog["assets"]}
    allowed.update((stone["headModel"], ghost["thirdEyeModel"], *previews))
    catalog["assets"] = [{"path": reference, "bytes": child(root, reference).stat().st_size,
                          "sha256": hashlib.sha256(child(root, reference).read_bytes()).hexdigest()}
                         for reference in sorted(allowed)]
    evidence = catalog.setdefault("sourceEvidence", {})
    exporters = [entry for entry in evidence.get("exporters", []) if entry["file"] != Path(__file__).name]
    exporters.append({"file": Path(__file__).name, "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
    evidence["exporters"] = exporters
    save(root, "catalog.json", catalog)
    return {"assets": len(catalog["assets"]), "headModel": stone["headModel"], "thirdEyeModel": ghost["thirdEyeModel"], "decodedMasks": previews}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", help="An exported, allowlisted build directory")
    print(json.dumps(prepare(parser.parse_args().root)))
