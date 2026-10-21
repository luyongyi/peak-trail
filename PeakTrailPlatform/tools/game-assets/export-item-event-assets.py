"""Export the small, exact-build asset pack used by static item event markers.

Only serialized icons and meshes referenced by the selected native item components
are public. No player data, game DLLs or complete extraction directories are copied.
"""
import argparse
import hashlib
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("peak_item_world", HERE / "export-world-assets.py")
world = importlib.util.module_from_spec(spec)
spec.loader.exec_module(world)

COMPONENTS = {"Constructable", "ShelfShroom", "CloudFungus", "RopeShooter", "RopeSpool", "RopeTier", "ClimbingSpikeComponent"}
SPAWN_REFS = {"Constructable": "constructedPrefab", "ShelfShroom": "instantiateOnBreak",
              "CloudFungus": "instantiateOnBreak", "RopeShooter": "ropeAnchorWithRopePref",
              "ClimbingSpikeComponent": "hammeredVersionPrefab", "RopeTier": "anchorPrefab"}


def script_name(component):
    if component.type.name != "MonoBehaviour":
        return None
    head = component.parse_monobehaviour_head()
    return head.m_Script.read().m_ClassName if head.m_Script.m_PathID else None


def export(game, output, build):
    if str(world.game_info(Path(game))[2]) != str(build):
        raise ValueError("--build must match the installed game")
    exporter = world.WorldExporter(game, output, build)
    catalog = {"schemaVersion": 1, "gameBuildId": str(build), "source": "local-unity-item-event-assets",
               "generatedAtUtc": datetime.now(timezone.utc).isoformat(), "items": [], "worldObjects": [],
               "customization": {}, "ui": {}, "assets": []}
    database = next(obj for name, obj in exporter.behaviours if name == "ItemDatabase")
    generated = {}
    for ref in database.read_typetree()["Objects"]:
        obj = exporter.resolve(database, ref)
        data = obj.read_typetree()
        go = exporter.resolve(obj, data["m_GameObject"])
        components = [(script_name(component), component) for component in world.components(go)]
        if not any(name in COMPONENTS for name, _ in components):
            continue
        ui = data.get("UIData") or {}
        name = go.read().m_Name
        entry = {"itemId": data["itemID"], "prefabName": name, "name": ui.get("itemName") or name,
                 "icon": exporter.image(obj, ui.get("icon"), "icons")}
        if not entry["icon"]:
            entry["iconUnavailableReason"] = "source-ui-icon-unavailable"
        model = exporter.model_for(go)
        if model["parts"]:
            entry["worldModel"] = exporter.save(f"models/item-{entry['itemId']}-{world.module.slug(name)}.json", model)
        else:
            entry["worldModelUnavailableReason"] = "source-has-no-solid-mesh"
        catalog["items"].append(entry)
        for component_name, component in components:
            field = SPAWN_REFS.get(component_name)
            if not field:
                continue
            spawned = exporter.resolve(component, component.read_typetree().get(field))
            if spawned:
                if spawned.type.name != "GameObject":
                    spawned = exporter.resolve(spawned, spawned.read_typetree()["m_GameObject"])
                generated[(spawned.assets_file.name, spawned.path_id)] = (spawned, entry)
    for spawned, source in generated.values():
        model = exporter.model_for(spawned)
        name = spawned.read().m_Name
        entry = {"objectId": name, "prefabName": name, "name": source["name"], "kind": "placed-object",
                 "itemId": source["itemId"], "icon": source["icon"], "source": model["source"]}
        if model["parts"]:
            entry["model"] = exporter.save(f"models/placed-{world.module.slug(name)}.json", model)
        else:
            entry["modelUnavailableReason"] = "source-has-no-solid-mesh"
        catalog["worldObjects"].append(entry)
    allowed = set(exporter.images.values())
    allowed.update(entry["worldModel"] for entry in catalog["items"] if entry.get("worldModel"))
    allowed.update(entry["model"] for entry in catalog["worldObjects"] if entry.get("model"))
    for name in sorted(allowed):
        path = exporter.root / name
        catalog["assets"].append({"path": name, "bytes": path.stat().st_size,
                                  "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    catalog["sourceAssemblySha256"] = hashlib.sha256((Path(game) / "PEAK_Data/Managed/Assembly-CSharp.dll").read_bytes()).hexdigest()
    exporter.save("catalog.json", catalog)
    (Path(output) / "catalog.json").write_text(json.dumps({"schemaVersion": 1,
        "builds": [{"gameBuildId": str(build), "catalog": f"{build}/catalog.json"}]}, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"build": str(build), "items": [{"id": entry["itemId"], "prefab": entry["prefabName"]} for entry in catalog["items"]],
                      "placed": [{"prefab": entry["prefabName"], "model": bool(entry.get("model"))} for entry in catalog["worldObjects"]],
                      "files": len(catalog["assets"]), "bytes": sum(entry["bytes"] for entry in catalog["assets"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", default=r"C:\Program Files (x86)\Steam\steamapps\common\PEAK")
    parser.add_argument("--build", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    export(args.game, args.output, args.build)
