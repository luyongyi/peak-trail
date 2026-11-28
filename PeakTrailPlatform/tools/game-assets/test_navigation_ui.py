"""UI additions cannot replace existing portraits or sweep private files into publication."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image

spec = importlib.util.spec_from_file_location("navigation_ui_export", Path(__file__).with_name("export-navigation-ui.py"))
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


def entry(name, data):
    return {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class NavigationUiTests(unittest.TestCase):
    def test_published_stamina_sprites_retain_logical_rect_and_native_shader_inputs(self):
        root = Path(__file__).resolve().parents[2] / "data/avatar-assets/26542162"
        catalog = json.loads((root / "catalog.json").read_text(encoding="utf8"))
        style = catalog["uiStyle"]["stamina"]
        # UnityPy Sprite.image trims these to239x239 and84x247. Sliced UI must
        # retain both256x256 logical canvases, otherwise the borders are wrong.
        for key, size in (("staminaOutline", (256, 256)), ("staminaOutlineCap", (256, 256)),
                          ("extraStaminaIcon", (512, 512))):
            with Image.open(root / catalog["ui"][key]) as image:
                self.assertEqual(image.size, size)
                self.assertEqual(list(image.size), style["images"][key]["size"])
        self.assertGreater(style["images"]["staminaOutlineCap"]["padding"][0], 160)
        material, condition = style["material"], style["conditionMaterial"]
        self.assertEqual(material["shader"], "Scouts/UI")
        self.assertAlmostEqual(material["step"], .95, places=5)
        self.assertAlmostEqual(material["stepSmooth"], .38, places=5)
        self.assertEqual(material["alphaStrength"], 2)
        self.assertFalse(material["redIsAlpha"])
        self.assertTrue(condition["redIsAlpha"])
        self.assertAlmostEqual(condition["step"], .55, places=5)
        for key in ("staminaNoise", "staminaDetail", "staminaConditionFill", "staminaConditionOutline"):
            self.assertTrue((root / catalog["ui"][key]).is_file())
        self.assertEqual(style["layout"]["conditions"]["order"], [7, 1, 2, 0, 3, 4, 6, 8, 5, 9, 10, 11, 12, 14])
        self.assertEqual(style["layout"]["conditions"]["minimumWidth"], 15)
        self.assertEqual(style["layout"]["canvasReferencePixelsPerUnit"], 100)
        petrify = next(item for item in style["conditions"] if item["isPetrify"])
        self.assertTrue(petrify["iconStyle"]["preserveAspect"])
        self.assertEqual(petrify["iconStyle"]["imagePivot"], [0, .5])
        self.assertEqual(style["layout"]["petrification"]["iconWidth"], 39.1)
        self.assertEqual(style["layout"]["main"]["minimumVisibleWidth"], 0)
        self.assertEqual(style["layout"]["extra"]["minimumVisibleWidth"], 6.1)

    def test_additive_assets_preserve_old_hashes_and_do_not_sweep_unreferenced_files(self):
        with tempfile.TemporaryDirectory(prefix="peak-ui-") as folder:
            root = Path(folder)
            (root / "head.png").write_bytes(b"original head")
            (root / "icon.png").write_bytes(b"native icon")
            (root / "private.json").write_text("must not publish")
            original = entry("head.png", b"original head")
            catalog = {"schemaVersion": 1, "gameBuildId": "123", "assets": [original]}
            existing = export.validate_existing(root, catalog, "123")
            result = export.extended_allowlist(root, existing, ["icon.png", "icon.png"])
            self.assertEqual(result, [original, entry("icon.png", b"native icon")])
            self.assertEqual(existing, {"head.png": original})

    def test_replacing_or_corrupting_a_published_derivative_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="peak-ui-") as folder:
            root = Path(folder)
            original = entry("head.png", b"original")
            (root / "head.png").write_bytes(b"replacement")
            catalog = {"schemaVersion": 1, "gameBuildId": "123", "assets": [original]}
            with self.assertRaisesRegex(ValueError, "published allowlist"):
                export.validate_existing(root, catalog, "123")
            with self.assertRaisesRegex(ValueError, "replace"):
                export.extended_allowlist(root, {"head.png": original}, ["head.png"])

    def test_wrong_build_duplicate_inventory_and_escaping_reference_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="peak-ui-") as folder:
            root = Path(folder)
            (root / "head.png").write_bytes(b"head")
            original = entry("head.png", b"head")
            catalog = {"schemaVersion": 1, "gameBuildId": "123", "assets": [original]}
            with self.assertRaisesRegex(ValueError, "exact installed build"):
                export.validate_existing(root, catalog, "456")
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                export.validate_existing(root, {**catalog, "assets": [original, original]}, "123")
            for reference in ("../private.png", "..\\private.png", "https://example.com/a.png", "/outside.png", None):
                with self.assertRaises(ValueError):
                    export.child(root, reference)


if __name__ == "__main__":
    unittest.main()
