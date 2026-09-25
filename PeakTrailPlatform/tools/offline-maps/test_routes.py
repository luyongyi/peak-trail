import unittest
from route_metadata import resolved_segments, route_metadata


def segment(biome, name, variant=None):
    return {'_biome': biome, '_segmentParent': name, '_segmentCampfire': '',
            'hasVariant': variant is not None, 'variantBiomeIndex': variant or 0}


def handler(swamp=False):
    return {
        'biomes': [0, 1, 2, 8 if swamp else 3],
        'segments': [segment(0, 'Beach'), segment(1, 'Jungle'), segment(2, 'Snow'),
                     segment(3, 'Caldera_Segment', 0), segment(3, 'Volcano_Segment', 1)],
        'variantSegments': [segment(8, 'Swamp_Segment'), segment(8, 'Temple_Segment')],
    }


class RouteTests(unittest.TestCase):
    def test_volcano_and_kiln_are_separate_stages_of_one_route(self):
        value = route_metadata(handler(), lambda name: name)
        self.assertEqual(value['branch'], 'volcano-kiln')
        self.assertEqual([stage['biomeId'] for stage in value['segments'][3:]], [3, 3])
        self.assertEqual([stage['displayName'] for stage in value['segments'][3:]], ['火山', '熔炉'])
        self.assertEqual([stage['name'] for stage in value['segments'][3:]], ['Caldera_Segment', 'Volcano_Segment'])

    def test_swamp_selects_both_linked_alternate_roots_without_relabeling_biome(self):
        value = route_metadata(handler(True), lambda name: name)
        self.assertEqual(value['branch'], 'swamp-temple')
        self.assertEqual([stage['biomeId'] for stage in value['segments'][3:]], [8, 8])
        self.assertEqual([stage['displayName'] for stage in value['segments'][3:]], ['雾沼', '城塞'])
        self.assertEqual([stage['name'] for stage in value['segments'][3:]], ['Swamp_Segment', 'Temple_Segment'])

    def test_unselected_null_alternatives_are_not_used(self):
        value = handler()
        value['variantSegments'] = [segment(8, ''), segment(8, '')]
        self.assertEqual(route_metadata(value, lambda name: name)['branch'], 'volcano-kiln')

    def test_inconsistent_or_missing_pair_is_not_guessed(self):
        value = handler(True)
        value['variantSegments'][1] = segment(3, 'WrongBranch')
        self.assertEqual(route_metadata(value, lambda name: name)['branch'], 'unknown')
        value = handler(True)
        value['variantSegments'][1]['_segmentParent'] = ''
        self.assertEqual(route_metadata(value, lambda name: name)['branch'], 'unknown')

    def test_runtime_out_of_range_variant_fallback_is_first_segment(self):
        value = handler(True)
        value['segments'][4]['variantBiomeIndex'] = 20
        self.assertEqual(resolved_segments(value)[4][1]['_segmentParent'], 'Beach')

    def test_resolution_does_not_mutate_serialized_source(self):
        value = handler(True)
        self.assertEqual(resolved_segments(value)[3][1]['_biome'], 8)
        self.assertEqual(value['segments'][3]['_biome'], 3)


if __name__ == '__main__':
    unittest.main()
