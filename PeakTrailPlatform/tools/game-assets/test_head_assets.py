"""Portrait packaging closes actual references and excludes unrelated files."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("head_export", Path(__file__).with_name("export-head-assets.py"))
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class HeadAssetTests(unittest.TestCase):
    def test_dependency_closure_includes_face_and_hat_textures_but_not_private_or_body_files(self):
        with tempfile.TemporaryDirectory(prefix="peak-head-") as folder:
            root = Path(folder)
            (root / "face.png").write_bytes(b"face")
            (root / "hat.png").write_bytes(b"hat")
            (root / "private.json").write_text("private")
            (root / "body.json").write_text("unused")
            (root / "head.json").write_text(json.dumps({"parts": [{"groups": [{"material": {"texture": "face.png"}}]}]}))
            result = export.dependency_allowlist(root, {"avatar": {"model": "head.json"},
                "fits": [{"hatMaterial": {"texture": "hat.png"}}]})
            self.assertEqual([row["path"] for row in result], ["face.png", "hat.png", "head.json"])
            self.assertTrue(all(len(row["sha256"]) == 64 and row["bytes"] > 0 for row in result))

    def test_missing_escaping_and_invalid_dependencies_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="peak-head-") as folder:
            root = Path(folder)
            for reference in ("../private.png", "https://external.invalid/face.png", "/absolute.png", "..\\private.png"):
                with self.assertRaises(ValueError):
                    export.dependency_allowlist(root, {"avatar": {"model": reference}})
            with self.assertRaises(FileNotFoundError):
                export.dependency_allowlist(root, {"avatar": {"model": "absent.json"}})
            with self.assertRaises(ValueError):
                export.dependency_allowlist(root, {"sourceProperties": {"textures": [{"asset": None}]}})


if __name__ == "__main__":
    unittest.main()
