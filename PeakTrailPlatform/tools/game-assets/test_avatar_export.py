"""Regression checks for exact builds and non-selectable outfit hats."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("avatar_export", Path(__file__).with_name("export-game-assets.py"))
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class AvatarExportTests(unittest.TestCase):
    def test_crab_albedo_matches_audited_shader_layers_tint_and_hue(self):
        # Independent source/bytecode audit: missing UV1 means constant bilinear
        # corner samples, not noise painted with the Crab's unrelated UV0.
        colors = {
            "_BaseColor": dict(zip("rgba", [1, 1, 1, 1])),
            "_Tint": dict(zip("rgba", [.3679245114326477, .02739599719643593, .019090425223112106, 1])),
            "_Color1": dict(zip("rgba", [.6037735939025879, .3218227028846741, .3218227028846741, 1])),
            "_Color2": dict(zip("rgba", [1, .5638936161994934, .46698111295700073, .95686274766922])),
            "_Remap1": {"r": .15870501101016998, "g": .35496652126312256},
            "_Remap2": {"r": .1770167350769043, "g": .4555090069770813},
            "_HueShifts": {"r": -.019999999552965164, "g": 0},
        }
        samples = [float(export.srgb_to_linear(140 / 255)),
            float(export.srgb_to_linear(np.array([173, 148, 159, 165]) / 255).mean())]
        color, weights, hue = export.crab_layer_color(colors, samples)
        np.testing.assert_allclose(weights, [.54134327332, .69292822316], atol=1e-10)
        np.testing.assert_allclose(color, [.343691087, .016028722, .009887350], atol=1e-9)
        self.assertAlmostEqual(hue, -.01082686522, places=10)
        # Native eye pixels remain black, alpha survives, white becomes source red.
        pixels = np.array([[[255, 255, 255, 255], [0, 0, 0, 37]]], dtype=np.uint8)
        actual = export.bake_crab_pixels(pixels, color, hue, .30000001192092896)
        self.assertEqual(actual.tolist(), [[[158, 32, 32, 255], [0, 0, 0, 37]]])

    def test_crab_bake_is_scoped_and_rejects_changed_source_or_mesh(self):
        exporter = export.Exporter.__new__(export.Exporter)
        exporter.build = "25739797"
        unverified = {"name": "M_CrabHat", "color": [1, 1, 1, 1]}
        self.assertIs(exporter.bake_hat_material(None, None, None, unverified), unverified)
        exporter.build = "26542162"
        shader = types.SimpleNamespace(get_raw_data=lambda: b"shader")
        native = types.SimpleNamespace(get_raw_data=lambda: b"material",
            read=lambda: types.SimpleNamespace(m_Shader=types.SimpleNamespace(deref=lambda: shader)))
        exporter.resolve = lambda *_: native
        glass = {"name": "SunVisor_Glass", "color": [0, .5, 1, 1]}
        self.assertIs(exporter.bake_hat_material(None, None, None, glass), glass)
        with self.assertRaisesRegex(ValueError, "source material/shader changed"):
            exporter.bake_hat_material(None, None, None, {"name": "M_CrabHat"})
        with patch.object(export, "CRAB_MATERIAL_SHA256", hashlib.sha256(b"material").hexdigest()), \
                patch.object(export, "CHARACTER_SHADER_SHA256", hashlib.sha256(b"shader").hexdigest()):
            for mesh in (types.SimpleNamespace(m_UV1=[[0, 0]], m_Colors=[]),
                         types.SimpleNamespace(m_UV1=[], m_Colors=[[1, 1, 1, 1]])):
                with self.assertRaisesRegex(ValueError, "mesh gained"):
                    exporter.bake_hat_material(None, None, mesh, {"name": "M_CrabHat"})

    def test_verified_published_crab_packs_keep_native_geometry_and_texture_evidence(self):
        asset_root = Path(__file__).resolve().parents[2] / "data/avatar-assets"
        for build in ("26155610", "26542162"):
            root = asset_root / build
            catalog = json.loads((root / "catalog.json").read_text())
            model = json.loads((root / "models/hat-10.json").read_text())
            part = model["parts"][0]
            self.assertEqual(len(part["positions"]), 6876)
            self.assertEqual(len(part["uv"]), 4584)
            geometry = [{**{key: value for key, value in source_part.items() if key != "groups"},
                "groups": [{"indices": group["indices"]} for group in source_part["groups"]]}
                for source_part in model["parts"]]
            self.assertEqual(hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                "d3722231b46d2bea36739f1948b3e9d74b904f326307d387fa156da8a2890e18")
            material = part["groups"][0]["material"]
            self.assertEqual(material["color"], [1, 1, 1, 1])
            source = material["sourceProperties"]
            self.assertEqual(source["albedoBake"], "character-crab-static-uv1-v1")
            self.assertEqual(source["materialSha256"], export.CRAB_MATERIAL_SHA256)
            original = source["textures"][0]["asset"]
            self.assertEqual(hashlib.sha256((root / original).read_bytes()).hexdigest(),
                "ffc7c731901892d3f9d97ac2dd2d397cbfe27904b3d8037dc2ee9acc9f8c499a")
            pixels = np.array(Image.open(root / material["texture"]))
            self.assertEqual(pixels[0, 0, :3].tolist(), [158, 32, 32])
            allowed = {entry["path"]: entry for entry in catalog["assets"]}
            for path in (original, material["texture"], "models/hat-10.json"):
                data = (root / path).read_bytes()
                self.assertEqual(allowed[path]["sha256"], hashlib.sha256(data).hexdigest())
                self.assertEqual(allowed[path]["bytes"], len(data))

    def test_index_addition_preserves_old_build_and_rejects_unsafe_references(self):
        with tempfile.TemporaryDirectory(prefix="peak-avatar-index-") as folder:
            export.update_build_index(folder, "25306743")
            export.update_build_index(folder, "25739797")
            export.update_build_index(folder, "25739797")
            path = Path(folder) / "catalog.json"
            self.assertEqual([entry["gameBuildId"] for entry in json.loads(path.read_text())["builds"]], ["25306743", "25739797"])
            with self.assertRaises(ValueError):
                export.update_build_index(folder, "../25739797")
            path.write_text(json.dumps({"schemaVersion": 1, "builds": [{"gameBuildId": "1", "catalog": "../secret"}]}))
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, "Invalid existing"):
                export.update_build_index(folder, "2")
            self.assertEqual(path.read_bytes(), before)

    def test_requested_build_matches_steam_before_export(self):
        with tempfile.TemporaryDirectory(prefix="peak-avatar-build-") as folder:
            game = Path(folder) / "common" / "PEAK"
            (Path(folder) / "appmanifest_3527290.acf").write_text('"buildid" "25739797"')
            export.verify_installed_build(game, "25739797")
            for bad in ("25306743", "../25739797"):
                with self.assertRaises(ValueError):
                    export.verify_installed_build(game, bad)

    def test_all_native_renderer_indices_include_outfit_only_hats(self):
        exporter = export.Exporter.__new__(export.Exporter)
        exporter.refs, exporter.refs_obj = {"playerHats": [0, 1, 2]}, None
        renderer = types.SimpleNamespace(assets_file=types.SimpleNamespace(name="source.assets"), path_id=77,
            read=lambda: types.SimpleNamespace(m_GameObject=types.SimpleNamespace(read=lambda: types.SimpleNamespace(m_Name="Native Hood"))))
        exporter.resolve = lambda _origin, _ref: renderer
        exporter.renderer_model = lambda ref, role: {"sourceRef": ref, "role": role}
        saved = {}
        exporter.save = lambda path, model: saved.setdefault(path, model) and path
        catalog = {"customization": {"hats": [{"index": 0, "model": "models/hat-0.json"}],
                                     "fits": [{"overrideHat": True, "overrideHatIndex": 2}]}}
        added = exporter.complete_hat_models(catalog)
        self.assertEqual(added, ["models/hat-1.json", "models/hat-2.json"])
        self.assertEqual([hat["index"] for hat in catalog["customization"]["hats"]], [0, 1, 2])
        self.assertFalse(catalog["customization"]["hats"][2]["selectable"])
        self.assertEqual(saved["models/hat-2.json"]["parts"][0]["sourceRef"], 2)


if __name__ == "__main__":
    unittest.main()
