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
    def native_sprite(self, sprite):
        """Preserve Sprite.rect, not UnityPy's tightly cropped Sprite.image.

        Unity UI uses the logical rect, borders and trim padding when slicing.
        These audited sprites are unpacked, unrotated source textures; refuse
        atlas packing until its reconstruction has separately been verified.
        """
        data = sprite.read_typetree()
        rd = data["m_RD"]
        if data["m_SpriteAtlas"]["m_PathID"] or rd["settingsRaw"] & 1:
            raise ValueError("Packed native UI sprites need a separately audited rect reconstruction")
        texture = self.resolve(sprite, rd["texture"])
        image = texture.read().image.convert("RGBA")
        rect = data["m_Rect"]
        box = tuple(round(value) for value in (rect["x"], image.height - rect["y"] - rect["height"],
                                               rect["x"] + rect["width"], image.height - rect["y"]))
        if min(box) < 0 or box[2] > image.width or box[3] > image.height:
            raise ValueError("Native Sprite.rect exceeds its source texture")
        reference = f"ui/native/{base.slug(data['m_Name'])}-{base.slug(sprite.assets_file.name)}-{sprite.path_id}.png"
        target = self.root / reference
        target.parent.mkdir(parents=True, exist_ok=True)
        image.crop(box).save(target)
        self.native_images = getattr(self, "native_images", set()) | {reference}
        return reference

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
        texture = self.resolve(sprite, sprite_data["m_RD"]["texture"])
        image_go = self.resolve(image, data["m_GameObject"])
        image_rect = next(c for c in self.components(image_go) if c.type.name == "RectTransform").read_typetree()
        reference = self.native_sprite(sprite)
        trim, offset, rect = sprite_data["m_RD"]["textureRect"], sprite_data["m_RD"]["textureRectOffset"], sprite_data["m_Rect"]
        return reference, {
            "color": rgba(data["m_Color"]),
            "border": [sprite_data["m_Border"][key] for key in "xyzw"],
            "size": [sprite_data["m_Rect"]["width"], sprite_data["m_Rect"]["height"]],
            "pixelsPerUnitMultiplier": data.get("m_PixelsPerUnitMultiplier", 1),
            "pixelsToUnits": sprite_data["m_PixelsToUnits"],
            "spritePixelsPerUnit": sprite_data["m_PixelsToUnits"],
            "mainSrgb": texture.read_typetree().get("m_ColorSpace") == 1,
            "padding": [offset["x"], offset["y"], rect["width"] - offset["x"] - trim["width"],
                        rect["height"] - offset["y"] - trim["height"]],
            "imageType": data["m_Type"], "fillCenter": bool(data["m_FillCenter"]),
            "preserveAspect": bool(data["m_PreserveAspect"]),
            "imagePivot": [image_rect["m_Pivot"][key] for key in "xy"],
            "source": {"component": source(image), "sprite": {**source(sprite), "name": sprite_data["m_Name"]}},
        }

    def ui_material(self, image, ui):
        material = self.resolve(image, image.read_typetree()["m_Material"])
        data = material.read_typetree()
        shader = self.resolve(material, data["m_Shader"])
        properties = data["m_SavedProperties"]
        floats, colors, textures = (dict(properties.get(key, [])) for key in ("m_Floats", "m_Colors", "m_TexEnvs"))
        fields = {"step": "_Step", "stepSmooth": "_StepSmooth", "alphaStrength": "_AlphaStrength",
                  "noiseScale": "_NoiseScale", "noiseRemap": "_NoiseRemap", "texScale": "_TexScale", "wiggleTime": "_WiggleTime"}
        result = {"source": source(material), "name": data["m_Name"], "shader": shader.read_typetree()["m_ParsedForm"]["m_Name"],
                  **{key: floats[native] for key, native in fields.items()}, "texColor": rgba(colors["_TexColor"]),
                  "overlayColor": rgba(colors["_OverlayColor"]), "redIsAlpha": "_R_IS_ALPHA_ON" in data.get("m_ValidKeywords", []),
                  "noiseWrap": "repeat", "detailWrap": "mirror", "detailSrgb": True,
                  "noiseSrgb": False, "tintSrgb": True, "alphaClip": True,
                  "vertexColorAlwaysGammaSpace": False, "projectColorSpace": "linear", "frozenTime": 0}
        for key, native in (("staminaNoise", "_Noise"), ("staminaDetail", "_TextureSample1")):
            ui[key] = self.image(material, textures[native]["m_Texture"], "ui/textures")
        return result

    def rect_tree(self, transform, parent=None):
        data = transform.read_typetree()
        go = self.resolve(transform, data["m_GameObject"])
        gd = go.read_typetree()
        if parent is None:
            x, y, width, height = 0, 0, data["m_SizeDelta"]["x"], data["m_SizeDelta"]["y"]
        else:
            px, py, pw, ph = parent
            amin, amax, pivot, pos, size = (data[key] for key in
                ("m_AnchorMin", "m_AnchorMax", "m_Pivot", "m_AnchoredPosition", "m_SizeDelta"))
            width, height = pw * (amax["x"] - amin["x"]) + size["x"], ph * (amax["y"] - amin["y"]) + size["y"]
            x = px + pw * (amin["x"] + (amax["x"] - amin["x"]) * pivot["x"]) + pos["x"] - width * pivot["x"]
            y = py + ph * (1 - amin["y"] - (amax["y"] - amin["y"]) * pivot["y"]) - pos["y"] - height * (1 - pivot["y"])
        result = {"name": gd["m_Name"], "active": bool(gd["m_IsActive"]), "source": source(transform),
                  "rect": [round(value, 5) for value in (x, y, width, height)],
                  "transform": {key: data[key] for key in ("m_AnchorMin", "m_AnchorMax", "m_Pivot", "m_AnchoredPosition", "m_SizeDelta", "m_LocalScale")},
                  "components": [], "children": []}
        for comp in self.components(go):
            if comp.type.name != "MonoBehaviour":
                continue
            classname = self.component_name(comp)
            cd = comp.read_typetree()
            if classname in ("Image", "ProceduralImage"):
                if not cd["m_Sprite"]["m_PathID"]:
                    continue
                texture, style = self.export_image(comp)
                material = self.resolve(comp, cd["m_Material"])
                result["components"].append({"type": classname, "texture": texture, **style,
                    "materialName": material.read_typetree()["m_Name"] if material else "default"})
            elif classname in ("HorizontalLayoutGroup", "VerticalLayoutGroup", "UniformModifier", "Mask", "LayoutElement"):
                result["components"].append({"type": classname, **{key: value for key, value in cd.items()
                    if key not in ("m_GameObject", "m_Script", "m_Name")}})
        result["children"] = [self.rect_tree(self.resolve(transform, ptr), (x, y, width, height)) for ptr in data["m_Children"]]
        return result

    def run_ui(self):
        if self.build != "26542162":
            raise ValueError("The compact stamina layout/material contract must be audited for a different game build")
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
            "staminaOverflowLine": ("staminaBarOutlineOverflowBar", None),
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
        style["material"] = self.ui_material(self.resolve(bar, data["backing"]), ui)
        condition_fill = None
        for classname, obj in self.behaviours:
            if classname != "BarAffliction":
                continue
            affliction = obj.read_typetree()
            key = "petrificationIcon" if affliction["isPetrify"] else f"status{affliction['afflictionType']}"
            ui[key], icon = self.export_image(self.resolve(obj, affliction["icon"]))
            fill_image = self.image_component(obj, "Fill")
            outline_image = self.image_component(obj, "Outline")
            fill_key = "petrificationFill" if affliction["isPetrify"] else "staminaConditionFill"
            outline_key = "staminaConditionOutline"
            ui[fill_key], fill_style = self.export_image(fill_image)
            ui[outline_key], outline_style = self.export_image(outline_image)
            style["images"][fill_key], style["images"][outline_key] = fill_style, outline_style
            condition_fill = fill_image
            style["conditions"].append({"id": affliction["afflictionType"], "isPetrify": bool(affliction["isPetrify"]),
                                       "uiKey": key, "fillUiKey": fill_key, "outlineUiKey": outline_key,
                                       "color": icon["color"], "iconStyle": icon, "source": source(obj)})
        style["conditionMaterial"] = self.ui_material(condition_fill, ui)
        bar_go = self.resolve(bar, data["m_GameObject"])
        bar_transform = next(c for c in self.components(bar_go) if c.type.name == "RectTransform")
        group_transform = self.resolve(bar_transform, bar_transform.read_typetree()["m_Father"])
        style["nativeLayout"] = self.rect_tree(group_transform)
        canvas_transform = self.resolve(group_transform, group_transform.read_typetree()["m_Father"])
        canvas_go = self.resolve(canvas_transform, canvas_transform.read_typetree()["m_GameObject"])
        scaler = next(c for c in self.components(canvas_go) if c.type.name == "MonoBehaviour" and self.component_name(c) == "CanvasScaler")
        scaler_data = scaler.read_typetree()
        style["canvas"] = {"referencePixelsPerUnit": scaler_data["m_ReferencePixelsPerUnit"],
                           "referenceResolution": scaler_data["m_ReferenceResolution"],
                           "matchWidthOrHeight": scaler_data["m_MatchWidthOrHeight"], "source": source(scaler)}
        style["layout"] = {
            "coordinateSystem": "Unity UI units, positive y down, main bar top-left origin",
            "canvasReferencePixelsPerUnit": scaler_data["m_ReferencePixelsPerUnit"],
            "main": {"width": 600, "height": 45, "fillY": 6, "fillHeight": 33,
                     "minimumVisibleWidth": data["minStaminaBarWidth"],
                     "outlineX": -7, "outlineY": .5, "outlineHeight": 44, "outlineExtra": 14,
                     "outlineCapWidth": 44, "outlineCapRightOffset": .2,
                     "overflowX": 602, "overflowY": -7.5, "overflowWidth": 4, "overflowHeight": 60,
                     "overflowThreshold": 1.005},
            "extra": {"y": 52, "height": 45, "fillX": 46, "fillY": 6, "fillHeight": 33,
                      "minimumVisibleWidth": 6.1,
                      "outlineX": 40, "outlineY": 0, "outlineHeight": 45, "outlineExtra": 12,
                      "outlineMinWidth": 20, "iconX": -5, "iconY": 0, "iconWidth": 50, "iconHeight": 45},
            "petrification": {"rightEdge": 645, "y": 11.5, "height": 22,
                              "iconX": 654, "iconY": 2.55, "iconRectWidth": 200, "iconRectHeight": 39.1,
                              "iconWidth": 39.1, "iconHeight": 39.1, "iconPreserveAspect": True, "iconPivot": [0, .5]},
            "conditions": {"order": [7, 1, 2, 0, 3, 4, 6, 8, 5, 9, 10, 11, 12, 14], "alignment": "right", "spacing": 0,
                           "minimumWidth": data["minAfflictionWidth"], "visibleThreshold": .01, "y": 11.5, "height": 22,
                           "fillInsetX": 3, "outlineX": -.25, "outlineY": -4, "outlineExtraWidth": .5, "outlineHeight": 30,
                           "iconY": -43, "iconWidth": 34, "iconHeight": 30},
            "runtime": {"normalFill": "600*currentStamina", "maxFill": "600*GetMaxStamina()",
                        "outline": "14+600*max(1,statusSum)", "conditionWidth": "max(minimumWidth,600*statusAmount)",
                        "extraFill": "600*extraStamina", "extraOutline": "max(20,12+600*(petrifyActive?1:extraStamina))"},
        }
        catalog.setdefault("uiStyle", {})["stamina"] = style
        catalog["assets"] = extended_allowlist(self.root, existing, [*self.images.values(), *getattr(self, "native_images", ())])
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
