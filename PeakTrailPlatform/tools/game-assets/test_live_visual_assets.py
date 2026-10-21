"""Protect real head topology, hidden mask RGB and immutable published models."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

spec = importlib.util.spec_from_file_location("live_visual_assets", Path(__file__).with_name("prepare-live-visual-assets.py"))
visuals = importlib.util.module_from_spec(spec)
spec.loader.exec_module(visuals)


class LiveVisualAssetsTests(unittest.TestCase):
    def fixture(self, root, include_head=True):
        source = {"field": "CustomizationRefs.stoneRenderers", "mesh": {"name": "Statue head", "pathId": 1198},
                  "renderer": {"pathId": 4019}}
        head = {"name": "Statue head", "source": source, "positions": [1, 2, 3, 4, 5, 6, 7, 8, 9],
                "uv": [0, 0, 1, 0, 0, 1], "groups": [{"indices": [0, 1, 2], "material": {"color": [1, 1, 1, 1]}}]}
        stone = {"coordinateSpace": "unity-prefab-neutral-pose", "parts": [head] if include_head else []}
        third = {"parts": [{"name": "Ghost original eye", "positions": [4, 3, 2], "groups": [{"material": {"texture": "mask.png"}}]}]}
        (root / "stone.json").write_text(json.dumps(stone))
        (root / "third.json").write_text(json.dumps(third))
        image = Image.new("RGBA", (2, 1))
        image.putdata([(255, 0, 0, 0), (255, 255, 0, 0)])
        image.save(root / "mask.png")
        catalog = {"customization": {"ghost": {"thirdEyeModel": "third.json"},
                   "stateVisuals": {"petrification": {"model": "stone.json"}, "blindness": {}}},
                   "assets": [{"path": name, "bytes": (root / name).stat().st_size,
                               "sha256": hashlib.sha256((root / name).read_bytes()).hexdigest()}
                              for name in ("stone.json", "third.json", "mask.png")]}
        (root / "catalog.json").write_text(json.dumps(catalog))
        return head, third

    def test_portrait_keeps_exact_separate_source_geometry_and_existing_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source_head, source_third = self.fixture(root)
            originals = {name: (root / name).read_bytes() for name in ("stone.json", "third.json", "mask.png")}
            report = visuals.prepare(root)
            portrait = json.loads((root / report["headModel"]).read_text())
            self.assertEqual(portrait["parts"], [source_head])
            self.assertEqual(portrait["portraitScope"], "source-separate-head-renderer")
            third = json.loads((root / report["thirdEyeModel"]).read_text())
            self.assertEqual(third["parts"][0]["positions"], source_third["parts"][0]["positions"])
            for name, original in originals.items():
                self.assertEqual((root / name).read_bytes(), original)
            # RGB below zero source alpha must survive offline mask decoding.
            decoded = Image.open(root / report["decodedMasks"][0])
            pixels = [decoded.getpixel((x, 0)) for x in range(2)]
            self.assertEqual(pixels, [(255, 255, 255, 255), (0, 0, 0, 255)])

    def test_missing_real_separate_head_is_not_replaced_by_a_crop(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root, include_head=False)
            before = (root / "catalog.json").read_bytes()
            with self.assertRaisesRegex(ValueError, "separate Statue head"):
                visuals.prepare(root)
            self.assertEqual((root / "catalog.json").read_bytes(), before)
            self.assertFalse((root / "models").exists())


if __name__ == "__main__":
    unittest.main()
