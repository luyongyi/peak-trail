"""Add original item/placed-object meshes and a sourced NPC portrait to a pack.

Models retain prefab-local metres. This does not recover historical world state:
the recorder must supply each instance's lifetime and world transform.
"""
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('peak_visual_export', HERE / 'export-game-assets.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.path.insert(0, str(HERE.parent / 'offline-maps'))
from build_maps import game_info


def pointer(obj):
    return {'m_FileID': 0, 'm_PathID': obj.path_id}


def components(go):
    return [c.component.deref() for c in go.read().m_Component]


def transform(go):
    return next(c for c in components(go) if c.type.name in ('Transform', 'RectTransform'))


def walk(go, include_inactive=False):
    if not include_inactive and not go.read().m_IsActive:
        return
    yield go
    for child in transform(go).read().m_Children:
        yield from walk(child.read().m_GameObject.deref(), include_inactive)


def relative_positions(positions, inverse_root):
    vertices = np.asarray(positions, dtype=float).reshape(-1, 3)
    homogeneous = np.concatenate((vertices, np.ones((len(vertices), 1))), axis=1)
    return np.round((inverse_root @ homogeneous.T).T[:, :3], 6).reshape(-1).tolist()


class WorldExporter(module.Exporter):
    def image(self, origin, ref, group='textures'):
        obj = self.resolve(origin, ref)
        # A camera's RenderTexture exists only during play; exporting a dummy
        # screenshot would be fabricated. Keep its surrounding physical mesh.
        if obj and obj.type.name not in ('Texture2D', 'Sprite'):
            return None
        return super().image(origin, ref, group)

    def material(self, origin, ref, role=None):
        material = super().material(origin, ref, role)
        obj = self.resolve(origin, ref)
        if not obj:
            return material
        data = obj.read_typetree()
        shader = self.resolve(obj, data['m_Shader']).read_typetree()['m_ParsedForm']
        properties = {prop['m_Name']: prop for prop in shader['m_PropInfo']['m_Props']}
        saved = data['m_SavedProperties']
        colors = dict(saved.get('m_Colors', []))
        # _Tint is only a multiplier in Peak_Standard. Preserve source base
        # albedo rather than tinting every mushroom the same neutral grey.
        name = next((name for name in ('_BaseColor', '_Color', '_Tint')
                     if name in colors and name in properties and properties[name]['m_Type'] == 0), None)
        if name:
            rgba = [colors[name][k] for k in 'rgba']
            flags = properties[name]['m_Flags']
            material['color'] = rgba
            material['colorSpace'] = 'linear' if flags & (16 | 32) else 'srgb'
            material['sourceColor'] = {'property': name, 'flags': flags, 'storedRgba': rgba}
        textures = dict(saved.get('m_TexEnvs', []))
        tex = next((textures[key] for key in ('_BaseTexture', '_BaseMap', '_MainTex')
                    if key in properties and key in textures and textures[key]['m_Texture']['m_PathID']), None)
        if tex:
            material['texture'] = self.image(obj, tex['m_Texture'])
            material['textureScale'] = [tex['m_Scale'][k] for k in 'xy']
            material['textureOffset'] = [tex['m_Offset'][k] for k in 'xy']
        else:
            material.pop('texture', None)
        material['shader'] = shader['m_Name']
        material['approximation'] = 'Source base albedo and UV texture; custom layer masks, animation and lighting are not reproduced'
        return material

    def model_for(self, go):
        inverse_root = np.linalg.inv(self.transform(transform(go)))
        parts = []
        ignored_lods = set()
        nodes = list(walk(go))
        for node in nodes:
            for component in components(node):
                if component.type.name != 'LODGroup':
                    continue
                lods = component.read_typetree().get('m_LODs', [])
                for lod in lods[1:]:
                    for ref in lod.get('renderers', []):
                        ref = ref.get('renderer', ref)
                        renderer = self.resolve(component, ref)
                        if renderer:
                            ignored_lods.add((renderer.assets_file.name, renderer.path_id))
        for node in nodes:
            for renderer in components(node):
                if renderer.type.name not in ('MeshRenderer', 'SkinnedMeshRenderer'):
                    continue
                if (renderer.assets_file.name, renderer.path_id) in ignored_lods:
                    continue
                if not renderer.read().m_Enabled:
                    continue
                part = self.renderer_model(pointer(renderer), origin=renderer)
                part['positions'] = relative_positions(part['positions'], inverse_root)
                if part['positions']:
                    parts.append(part)
        return {'parts': parts, 'coordinateSpace': 'unity-prefab-local-meters',
                'source': {'file': go.assets_file.name, 'pathId': go.path_id, 'prefabName': go.read().m_Name},
                'limitations': ['Neutral serialized pose; dynamic animation and custom shader layers are not reproduced']}

    def zombie(self):
        zombie = next(o for name, o in self.behaviours if name == 'MushroomZombie'
                      and self.resolve(o, o.read_typetree()['m_GameObject']).read().m_Name == 'MushroomZombie')
        data = zombie.read_typetree()
        go = self.resolve(zombie, data['m_GameObject'])
        descendants = list(walk(go, True))
        refs_obj = next(c for node in descendants for c in components(node)
                        if c.type.name == 'MonoBehaviour' and c.parse_monobehaviour_head().m_Script.m_PathID
                        and c.parse_monobehaviour_head().m_Script.read().m_ClassName == 'CustomizationRefs')
        refs = refs_obj.read_typetree()
        selected = [(refs['PlayerRenderers'][0], 'skin'), (refs['EyeRenderers'][0], 'eyes'),
                    (refs['EyeRenderers'][1], 'eyes'), (refs['mouthRenderer'], 'mouth')]
        parts = [self.renderer_model(ref, role=role, origin=refs_obj) for ref, role in selected]
        eye_texture = self.image(zombie, data['zombieEyeTexture'])
        # The zombie-specific eye is a real game texture. Other feature geometry
        # and the mouth come from this NPC prefab, not a player's cosmetics.
        for part in parts:
            if part['role'] == 'eyes':
                for group in part['groups']:
                    group['material']['texture'] = eye_texture
        # Use the NPC prefab's skin material, never a hardcoded player skin.
        skin = parts[0]['groups'][0]['material'].get('skinColor', [1, 1, 1, 1])[:3]
        # These source mushroom meshes are parented to the head. In game they
        # grow over time; the map portrait is a clearly labelled mature NPC
        # reference, not an assertion about the recorded growth animation.
        head_go = self.resolve(refs_obj, refs['PlayerRenderers'][0]).read().m_GameObject.deref()
        head_bone = transform(head_go).read().m_Father.read().m_GameObject.deref()
        head_descendants = {(node.assets_file.name, node.path_id) for node in walk(head_bone, True)}
        for ref in data['mushroomVisuals']:
            visual = self.resolve(zombie, ref)
            if (visual.assets_file.name, visual.path_id) not in head_descendants:
                continue
            for node in walk(visual, True):
                for renderer in components(node):
                    if renderer.type.name in ('MeshRenderer', 'SkinnedMeshRenderer') and renderer.read().m_Enabled:
                        parts.append(self.renderer_model(pointer(renderer), role='mushroom', origin=renderer))
        model = self.save('models/world/mushroom-zombie-head.json', {'parts': parts,
                          'source': {'file': go.assets_file.name, 'pathId': go.path_id},
                          'coordinateSpace': 'unity-prefab-neutral-pose'})
        preview_spec = importlib.util.spec_from_file_location('peak_previews', HERE / 'render-previews.py')
        preview_module = importlib.util.module_from_spec(preview_spec)
        preview_spec.loader.exec_module(preview_module)
        icon = 'previews/world-mushroom-zombie-head.png'
        (self.root / icon).parent.mkdir(parents=True, exist_ok=True)
        preview_module.Renderer(self.root, 256).render(parts, skin=skin).save(self.root / icon)
        return {'objectId': 'MushroomZombie', 'prefabName': 'MushroomZombie', 'kind': 'zombie',
                'icon': icon, 'headModel': model,
                'source': {'file': go.assets_file.name, 'pathId': go.path_id},
                'portraitKind': 'original-npc-head-mature-reference',
                'portraitLimitations': 'Source head/eyes/skin and mature head mushrooms; not recorded growth or attack pose',
                'distanceBeforeWakeup': data['distanceBeforeWakeup'], 'distanceToEnable': data['distanceToEnable']}

    def run_world(self):
        catalog = json.loads((self.root / 'catalog.json').read_text(encoding='utf8'))
        if str(catalog.get('gameBuildId')) != self.build or str(game_info(self.game)[2]) != self.build:
            raise ValueError('Installed game and asset catalog must match --build exactly')
        database = next(o for classname, o in self.behaviours if classname == 'ItemDatabase')
        items = {(item['itemId'], item['prefabName']): item for item in catalog['items']}
        failures = []
        count = 0
        for ref in database.read_typetree()['Objects']:
            item_obj = self.resolve(database, ref)
            data = item_obj.read_typetree()
            go = self.resolve(item_obj, data['m_GameObject'])
            entry = items.get((data['itemID'], go.read().m_Name))
            if not entry:
                continue
            try:
                model = self.model_for(go)
                if not model['parts']:
                    entry['worldModelUnavailableReason'] = 'no-enabled-source-mesh'
                    continue
                entry['worldModel'] = self.save(f"models/world/item-{entry['itemId']}-{module.slug(entry['prefabName'])}.json", model)
                entry.pop('worldModelUnavailableReason', None)
                count += 1
            except Exception as exc:
                entry['worldModelUnavailableReason'] = f'{type(exc).__name__}: {exc}'
                failures.append({'itemId': entry['itemId'], 'reason': entry['worldModelUnavailableReason']})
        objects = []
        seen = set()
        for classname, obj in self.behaviours:
            if classname not in ('ShelfShroom', 'CloudFungus'):
                continue
            ref = obj.read_typetree().get('instantiateOnBreak')
            go = self.resolve(obj, ref)
            if not go or (go.assets_file.name, go.path_id) in seen:
                continue
            seen.add((go.assets_file.name, go.path_id))
            model = self.model_for(go)
            name = go.read().m_Name
            entry = {'objectId': name, 'prefabName': name, 'kind': 'placed-object', 'source': model['source']}
            if model['parts']:
                entry['model'] = self.save(f'models/world/{module.slug(name)}.json', model)
            else:
                entry['modelUnavailableReason'] = 'source-is-particle-effect-without-solid-mesh'
            objects.append(entry)
        objects.append(self.zombie())
        catalog['worldObjects'] = objects
        # Retain the existing explicit allowlist, adding only files referenced by
        # this exporter. No private capture directory belongs in this asset tree.
        allowed = {asset['path'] for asset in catalog['assets']}
        allowed.update(self.images.values())
        allowed.update(entry['worldModel'] for entry in catalog['items'] if entry.get('worldModel'))
        for entry in objects:
            allowed.update(entry[key] for key in ('model', 'headModel', 'icon') if entry.get(key))
        assets = []
        for name in sorted(allowed):
            path = (self.root / name).resolve()
            if not path.is_relative_to(self.root.resolve()) or path.suffix not in ('.png', '.json'):
                raise ValueError(f'Unsafe existing asset reference: {name}')
            assets.append({'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                           'bytes': path.stat().st_size})
        catalog['assets'] = assets
        self.save('catalog.json', catalog)
        print(json.dumps({'itemModels': count, 'worldObjects': objects, 'failures': failures,
                          'totalAssetBytes': sum(asset['bytes'] for asset in catalog['assets'])}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--game', default=r'C:\Program Files (x86)\Steam\steamapps\common\PEAK')
    parser.add_argument('--output', default=str(HERE.parents[2] / 'local/assets/game-assets'))
    parser.add_argument('--build', default='25306743')
    args = parser.parse_args()
    WorldExporter(args.game, args.output, args.build).run_world()
