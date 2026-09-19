"""Asset-free topology tests; use the pipeline's pinned Python environment."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('form_export', Path(__file__).with_name('export-form-assets.py'))
forms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forms)


class FormHeadTests(unittest.TestCase):
    def test_head_selection_remaps_original_vertices_uv_colors_and_triangles(self):
        part = {'name': 'Skeleton', 'role': 'form-body',
                'positions': [99, 99, 99, 0, 0, 0, 1, 0, 0, 0, 1, 0],
                'uv': [9, 9, 0, 0, 1, 0, 0, 1],
                'colors': [0, 0, 0, 1, 1, 1, .5, .5, .5, .2, .2, .2],
                'groups': [{'indices': [1, 2, 3, 0, 1, 2], 'material': {'name': 'source'}}]}
        head, used = forms.extract_head(part, [[1], [1], [1], [1]], [[1], [106], [106], [107]], [106, 107])
        self.assertEqual(used, [1, 2, 3])
        self.assertEqual(head['positions'], part['positions'][3:])
        self.assertEqual(head['uv'], part['uv'][2:])
        self.assertEqual(head['colors'], part['colors'][3:])
        self.assertEqual(head['groups'][0]['indices'], [0, 1, 2])
        self.assertEqual(part['groups'][0]['indices'], [1, 2, 3, 0, 1, 2])
        self.assertEqual(head['role'], 'form-head')

    def test_neck_partial_weight_or_no_head_fails_instead_of_body_crop(self):
        part = {'name': 'Body', 'positions': [0] * 9, 'uv': [0] * 6,
                'groups': [{'indices': [0, 1, 2], 'material': {}}]}
        with self.assertRaisesRegex(ValueError, 'no independently weighted head'):
            forms.extract_head(part, [[1], [1], [.5]], [[106], [106], [106]], [106])


if __name__ == '__main__':
    unittest.main()
