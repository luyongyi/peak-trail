"""Export source-bound PeakHandler view metadata for existing canonical packs.

This never launches PEAK and does not modify canonical map geometry.  The summit
boundary is the GameObject carrying the serialized PeakHandler component, not a
name, coordinate range, or the MapHandler respawn marker.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from build_maps import Scene, bounds_for, game_data, game_info, pid


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def peak_handler_root(scene: Scene) -> tuple[int, int]:
    found = []
    for obj in scene.objects.values():
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            if obj.read(check_read=False).m_Script.read().m_ClassName != "PeakHandler":
                continue
            found.append((obj.read(check_read=False).m_GameObject.path_id, obj.path_id))
        except Exception:
            continue
    if len(found) != 1:
        raise ValueError(f"expected exactly one PeakHandler, found {len(found)}")
    return found[0]


def direct_peak_gate(scene: Scene, root: int) -> int:
    """Return the authored Temple Peak Gate sibling, or zero for Kiln maps."""
    root_transform = scene.read(scene.transform(root))
    parent_transform = pid(root_transform["m_Father"])
    matches = []
    for child in scene.read(parent_transform)["m_Children"]:
        game_object = pid(scene.read(pid(child))["m_GameObject"])
        value = scene.read(game_object)
        if value["m_Name"] != "Peak Gate" or not value["m_IsActive"]:
            continue
        kinds = {scene.objects[pid(component["component"])].type.name for component in value["m_Component"]}
        if {"MeshFilter", "MeshRenderer", "MeshCollider"}.issubset(kinds):
            matches.append(game_object)
    if len(matches) > 1:
        raise ValueError("multiple enabled direct Peak Gate siblings")
    return matches[0] if matches else 0


def export_peak(game: Path, catalog_path: Path, packs_path: Path, output: Path, scene_factory=Scene) -> None:
    mapping, version, build = game_info(game)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    maps = []
    for catalog_entry in catalog["mapPacks"]:
        if str(catalog_entry.get("gameBuildId")) != str(build):
            continue
        map_pack_id = catalog_entry["mapPackId"]
        manifest = json.loads((packs_path / map_pack_id / "map-pack.json").read_text(encoding="utf-8"))
        scene_name = manifest["sceneName"]
        scene_path = game_data(game) / f"level{mapping[scene_name]}"
        source_hash = sha(scene_path)
        if source_hash != manifest.get("source", {}).get("sceneSha256"):
            raise ValueError(f"{scene_name}: installed source scene does not match canonical pack")
        terminal = [layer for layer in manifest["layers"] if layer.get("segment") == 4]
        if len(terminal) != 1 or not terminal[0].get("geometrySha256"):
            raise ValueError(f"{scene_name}: expected one original-mesh terminal layer")

        scene = scene_factory(scene_path, game)
        root, handler = peak_handler_root(scene)
        gate = direct_peak_gate(scene, root)
        instances, colliders, stats = scene.collect({
            "_segmentParent": {"m_FileID": 0, "m_PathID": root},
            "_segmentCampfire": {"m_FileID": 0, "m_PathID": gate},
        })
        if not instances or not colliders:
            raise ValueError(f"{scene_name}: PeakHandler root has no static geometry")
        render_min, render_max = bounds_for(scene, instances)
        collision_min, collision_max = bounds_for(scene, colliders)
        root_name = scene.read(root)["m_Name"]
        maps.append({
            "mapPackId": map_pack_id,
            "sceneName": scene_name,
            "mapSlot": manifest["mapSlot"],
            "sourceSceneSha256": source_hash,
            "geometrySha256": terminal[0]["geometrySha256"],
            "segment": 4,
            "biome": terminal[0]["biome"],
            "rootGameObject": root,
            "gateGameObject": gate or None,
            "peakHandler": handler,
            "rootName": root_name,
            "bounds": {"min": render_min.tolist(), "max": render_max.tolist()},
            "collisionBounds": {"min": collision_min.tolist(), "max": collision_max.tolist()},
            "statistics": stats,
        })
        print(scene_name, root_name, root, maps[-1]["bounds"], flush=True)

    expected = sum(1 for entry in catalog["mapPacks"] if str(entry.get("gameBuildId")) == str(build))
    if len(maps) != expected:
        raise ValueError(f"exported {len(maps)} of {expected} build-matching maps")
    payload = {
        "schemaVersion": 1,
        "gameBuildId": str(build),
        "gameVersion": version,
        "authority": "serialized-peak-handler",
        "source": "Unique serialized PeakHandler GameObject subtree; static enabled source renderers only.",
        "maps": maps,
    }
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    platform = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", type=Path, default=Path(r"C:\Program Files (x86)\Steam\steamapps\common\PEAK"))
    parser.add_argument("--catalog", type=Path, default=platform / "data/maps/catalog.json")
    parser.add_argument("--packs", type=Path, default=platform.parent / "local/assets/maps/packs")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    _, _, build_id = game_info(args.game)
    export_peak(args.game, args.catalog, args.packs,
                args.output or platform / f"data/maps/peaks.{build_id}.json")
