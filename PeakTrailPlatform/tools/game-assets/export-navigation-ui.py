"""Add exact-build item and stamina UI art to an existing portrait pack.

Only ItemDatabase and StaminaBar/InventoryItemUI serialized references are
followed. Existing portrait geometry and its allowlist remain byte-for-byte
unchanged. No raw Unity resources, player state or unreferenced files are copied.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("peak_navigation_ui_base", HERE / "export-game-assets.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def child(root, reference):
    if not isinstance(reference, str) or "\\" in reference or ":" in reference:
        raise ValueError("Unsafe UI dependency")
    path = (root / reference).resolve()
    if not path.is_relative_to(root.resolve()) or ".." in Path(reference).parts:
        raise ValueError("UI dependency escapes build")
    return path


def validate_existing(root, catalog, build):
    if catalog.get("schemaVersion") != 1 or str(catalog.get("gameBuildId")) != str(build):
        raise ValueError("UI additions require an existing catalog for the exact installed build")
    assets = {}
    for entry in catalog["assets"]:
        reference = entry["path"]
        if reference in assets:
            raise ValueError("Duplicate existing asset")
        data = child(root, reference).read_bytes()
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("Existing asset differs from its published allowlist")
        assets[reference] = entry
    return assets


def extended_allowlist(root, existing, added):
    result = dict(existing)
    for reference in added:
        data = child(root, reference).read_bytes()
        entry = {"path": reference, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if reference in existing and existing[reference] != entry:
            raise ValueError("UI extraction must not replace an existing derivative")
        result[reference] = entry
    return [result[name] for name in sorted(result)]


def source(obj):
    return {"file": obj.assets_file.name, "pathId": obj.path_id}


def rgba(value):
    return [round(value[key], 8) for key in "rgba"]


class NavigationUiExporter(base.Exporter):
    def components(self, game_object):
        for entry in game_object.read_typetree()["m_Component"]:
            yield self.resolve(game_object, entry["component"])

    @staticmethod
    def component_name(obj):
        return obj.parse_monobehaviour_head().m_Script.read().m_ClassName if obj.type.name == "MonoBehaviour" else obj.type.name

    def image_component(self, obj, child_name=None):
        data = obj.read_typetree()
        game_object = obj if obj.type.name == "GameObject" else self.resolve(obj, data["m_GameObject"])
        if child_name is not None:
            transform = next(c for c in self.components(game_object) if c.type.name == "RectTransform")
            children = [self.resolve(transform, ref) for ref in transform.read_typetree()["m_Children"]]
            matches = [self.resolve(c, c.read_typetree()["m_GameObject"]) for c in children]
            game_object = next(c for c in matches if c.read_typetree()["m_Name"] == child_name)
        return next(c for c in self.components(game_object) if self.component_name(c) in ("Image", "ProceduralImage"))

    def export_image(self, image):
        data = image.read_typetree()
        sprite = self.resolve(image, data["m_Sprite"])
        if sprite is None:
            raise ValueError("Required native UI image has no sprite")
        sprite_data = sprite.read_typetree()
        reference = self.image(image, data["m_Sprite"], "ui")
        return reference, {
            "color": rgba(data["m_Color"]),
            "border": [sprite_data["m_Border"][key] for key in "xyzw"],
            "size": [sprite_data["m_Rect"]["width"], sprite_data["m_Rect"]["height"]],
            "pixelsPerUnitMultiplier": data.get("m_PixelsPerUnitMultiplier", 1),
            "source": {"component": source(image), "sprite": {**source(sprite), "name": sprite_data["m_Name"]}},
        }

    def run_ui(self):
        catalog_path = self.root / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf8"))
        existing = validate_existing(self.root, catalog, self.build)
        database = next(o for classname, o in self.behaviours if classname == "ItemDatabase")
        items = {}
        for pointer in database.read_typetree()["Objects"]:
            obj = self.resolve(database, pointer)
            data = obj.read_typetree()
            ui = data.get("UIData")
            if not ui:
                continue
            go = self.resolve(obj, data["m_GameObject"])
            item = {"itemId": data["itemID"], "prefabName": go.read().m_Name, "name": ui["itemName"],
                    "icon": self.image(obj, ui["icon"], "icons")}
            if item["icon"] is None:
                item["iconUnavailableReason"] = "game-item-ui-icon-is-null"
            if ui.get("hasAltIcon"):
                item["altIcon"] = self.image(obj, ui["altIcon"], "icons")
            items[(item["itemId"], item["prefabName"])] = item
        catalog["items"] = sorted(items.values(), key=lambda item: (item["itemId"], item["prefabName"]))
        ui = catalog.setdefault("ui", {})
        for classname, obj in self.behaviours:
            if classname != "InventoryItemUI":
                continue
            data = obj.read_typetree()
            for key in ("defaultIcon", "backpackIcon", "carryingIcon"):
                image = self.image(obj, data.get(key), "ui")
                if image:
                    ui[key] = image
            for key in ("fill", "outline", "selectedSlotIcon"):
                image_obj = self.resolve(obj, data.get(key))
                if image_obj:
                    image = self.image(image_obj, image_obj.read_typetree().get("m_Sprite"), "ui")
                    if image:
                        ui[key] = image
        bars = [o for classname, o in self.behaviours if classname == "StaminaBar"]
        if len(bars) != 1:
            raise ValueError("Expected one native scene StaminaBar")
        bar = bars[0]
        data = bar.read_typetree()
        roles = {
            "staminaBacking": ("backing", None), "staminaFill": ("staminaBar", "Fill"),
            "staminaOutline": ("staminaBarOutline", "OutlineImage"),
            "staminaOutlineCap": ("staminaBarOutline", "OutlineCap"),
            "extraStaminaFill": ("extraBarStamina", None), "extraStaminaOutline": ("extraBarOutline", None),
            "extraStaminaIcon": ("extraStaminaIcon", None),
        }
        full = self.resolve(bar, data["fullBar"]).read_typetree()
        main = self.resolve(bar, data["staminaBar"]).read_typetree()
        style = {"source": source(bar), "sourceWidth": full["m_SizeDelta"]["x"],
                 "sourceHeight": main["m_SizeDelta"]["y"], "images": {}, "conditions": [],
                 "outOfStaminaBackingColor": rgba(data["outOfStaminaBackingColor"])}
        for key, (field, descendant) in roles.items():
            image = self.image_component(self.resolve(bar, data[field]), descendant)
            ui[key], style["images"][key] = self.export_image(image)
        for classname, obj in self.behaviours:
            if classname != "BarAffliction":
                continue
            affliction = obj.read_typetree()
            key = "petrificationIcon" if affliction["isPetrify"] else f"status{affliction['afflictionType']}"
            ui[key], icon = self.export_image(self.resolve(obj, affliction["icon"]))
            style["conditions"].append({"id": affliction["afflictionType"], "isPetrify": bool(affliction["isPetrify"]),
                                       "uiKey": key, "color": icon["color"], "source": source(obj)})
        catalog.setdefault("uiStyle", {})["stamina"] = style
        catalog["assets"] = extended_allowlist(self.root, existing, self.images.values())
        # Verify old art again after extraction; an accidental path collision cannot be published.
        validate_existing(self.root, {**catalog, "assets": list(existing.values())}, self.build)
        evidence = catalog.setdefault("sourceEvidence", {})
        exporters = [entry for entry in evidence.get("exporters", []) if entry["file"] != Path(__file__).name]
        exporters.append({"file": Path(__file__).name, "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
        evidence["exporters"] = exporters
        evidence["navigationUi"] = {"itemDatabase": source(database), "staminaBar": source(bar),
                                    "selection": "canonical-item-icons-and-serialized-ui-references"}
        self.save("catalog.json", catalog)
        print(json.dumps({"build": self.build, "items": len(catalog["items"]), "uiKeys": len(ui),
                          "addedAssets": len(catalog["assets"]) - len(existing),
                          "addedBytes": sum(a["bytes"] for a in catalog["assets"] if a["path"] not in existing),
                          "existingAssetsRetained": len(existing)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", default=r"C:\Program Files (x86)\Steam\steamapps\common\PEAK")
    parser.add_argument("--output", required=True, help="Existing build-index root containing BUILD/catalog.json")
    parser.add_argument("--build", required=True)
    args = parser.parse_args()
    NavigationUiExporter(args.game, args.output, args.build).run_ui()
