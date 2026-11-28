"""UI additions cannot replace existing portraits or sweep private files into publication."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("navigation_ui_export", Path(__file__).with_name("export-navigation-ui.py"))
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


def entry(name, data):
    return {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class NavigationUiTests(unittest.TestCase):
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
