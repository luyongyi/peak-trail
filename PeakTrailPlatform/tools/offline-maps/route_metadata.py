"""Read PEAK's resolved stage chain without conflating a stage and its biome.

The final two mountain stages share a BiomeType value in build 25306743.
Volcano -> Volcano means Caldera -> Kiln; Swamp -> Swamp means fog islands
(Swamp) -> Temple. Names below are presentation labels, not new enum values.
"""
from __future__ import annotations

BIOMES = {
    0: 'Shore', 1: 'Tropics', 2: 'Alpine', 3: 'Volcano', 5: 'Peak',
    6: 'Mesa', 7: 'Roots', 8: 'Swamp', 9: 'Temple', 10: 'Grasslands',
    11: 'Ocean', 12: 'Skyblock', 13: 'Hell', 14: 'Heaven', 15: 'Mars',
    16: 'Wisconsin', 17: 'Void',
}


def resolved_segments(handler):
    """Mirror MapSegment getters; never activate both alternatives at once.

    The runtime's out-of-range variant lookup returns segments[0]. Preserving
    that fallback matters when inspecting an unfamiliar or modified scene.
    """
    result = []
    variants = handler.get('variantSegments', [])
    segments = handler['segments']
    for index, base in enumerate(segments):
        selected = base.copy()
        if base.get('hasVariant'):
            variant_index = int(base['variantBiomeIndex'])
            variant = variants[variant_index] if 0 <= variant_index < len(variants) else segments[0]
            if variant['_biome'] in handler['biomes']:
                for key in ('_biome', '_segmentParent', '_segmentCampfire'):
                    selected[key] = variant[key]
        result.append((index, selected))
    return result


def route_metadata(handler, root_name):
    """Return branch evidence from selected scene roots, not a guessed calendar.

    root_name receives a Unity GameObject pointer. No source geometry or player
    information is included. A missing/inconsistent pair remains unknown.
    """
    segments = []
    for index, selected in resolved_segments(handler):
        biome_id = int(selected['_biome'])
        segments.append({
            'index': index,
            'biome': BIOMES.get(biome_id, str(biome_id)),
            'biomeId': biome_id,
            'name': root_name(selected['_segmentParent']),
            'campfireName': root_name(selected['_segmentCampfire']),
        })
    pair = [segment['biomeId'] for segment in segments[3:5]]
    has_geometry = len(segments) >= 5 and all(segment['name'] for segment in segments[3:5])
    branch = 'volcano-kiln' if pair == [3, 3] and has_geometry else 'swamp-temple' if pair == [8, 8] and has_geometry else 'unknown'
    labels = {
        'volcano-kiln': (('caldera', '火山'), ('kiln', '熔炉')),
        'swamp-temple': (('swamp', '雾岛'), ('temple', '城塞')),
    }
    if branch in labels:
        for segment, (stage_id, display_name) in zip(segments[3:5], labels[branch]):
            segment.update(stageId=stage_id, displayName=display_name)
    return {'authority': 'serialized-map-handler', 'branch': branch, 'segments': segments}
