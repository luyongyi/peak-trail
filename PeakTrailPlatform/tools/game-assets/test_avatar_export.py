"""Regression checks for exact builds and non-selectable outfit hats."""
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location("avatar_export", Path(__file__).with_name("export-game-assets.py"))
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class AvatarExportTests(unittest.TestCase):
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
