import unittest

from export_enclosure import enclosure_asset_budget, check_enclosure_asset_budget


class EnclosureBudgetTests(unittest.TestCase):
    def test_measured_208_map_native_shells_fit_only_the_new_build_allowance(self):
        assets = {'97-unique-native-shells': 224_830_963}
        check_enclosure_asset_budget(assets, 26134529)
        for build in ('25306743', '25739797', 'unknown-build'):
            with self.subTest(build=build), self.assertRaisesRegex(ValueError, '64 MiB'):
                check_enclosure_asset_budget(assets, build)

    def test_limits_include_exact_boundary_but_reject_one_additional_byte(self):
        for build, mib in [('25306743', 64), ('25739797', 64), ('26134529', 256)]:
            with self.subTest(build=build):
                budget = mib * 1024 * 1024
                self.assertEqual(enclosure_asset_budget(build), budget)
                check_enclosure_asset_budget({'first': budget - 1, 'second': 1}, build)
                with self.assertRaisesRegex(ValueError, f'{mib} MiB'):
                    check_enclosure_asset_budget({'first': budget, 'second': 1}, build)

    def test_explicit_tighter_audit_budget_is_preserved(self):
        check_enclosure_asset_budget({'shell': 32}, '26134529', max_asset_bytes=32)
        with self.assertRaises(ValueError):
            check_enclosure_asset_budget({'shell': 33}, '26134529', max_asset_bytes=32)


if __name__ == '__main__':
    unittest.main()
