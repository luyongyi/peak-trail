"""Export actual transformed player meshes, selecting heads by source bone weights.

Read-only installed-game inputs; generated game art remains in ignored local/.
No guessed skulls, full-body image crops, or possession-based transformation.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('world_export', HERE / 'export-world-assets.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def head_bone_indices(renderer):
    """Head and descendants, not similarly named chest/detail bones."""
    result = []
    for index, bone in enumerate(renderer.m_Bones):
        current = bone
        while current.m_PathID:
            transform = current.read()
            if transform.m_GameObject.read().m_Name == 'Head':
                result.append(index)
                break
            current = transform.m_Father
    return result


def extract_head(part, weights, bone_indices, head_indices):
    weights, bone_indices = np.asarray(weights), np.asarray(bone_indices)
    head_weight = (weights * np.isin(bone_indices, head_indices)).sum(axis=1)
    # Require every triangle corner to belong entirely to the head. This is
    # source topology selection, not a world-height crop or invented neck cap.
    groups = []
    for group in part['groups']:
        triangles = np.asarray(group['indices'], dtype=int).reshape(-1, 3)
        triangles = triangles[np.all(head_weight[triangles] >= 0.999, axis=1)]
        if len(triangles):
            groups.append({**group, 'indices': triangles.reshape(-1).tolist()})
    if not groups:
        raise ValueError('Source form has no independently weighted head triangles')
    used = sorted({index for group in groups for index in group['indices']})
    remap = {old: new for new, old in enumerate(used)}
    result = {**part, 'name': part['name'] + ' Head', 'role': 'form-head', 'groups': groups}
    for key, stride in [('positions', 3), ('uv', 2), ('colors', 3)]:
        if key in part:
            result[key] = np.asarray(part[key]).reshape(-1, stride)[used].reshape(-1).tolist()
    for group in groups:
        group['indices'] = [remap[index] for index in group['indices']]
    return result, used


class FormExporter(module.WorldExporter):
    def form(self, form, renderer_ref, mesh_ref=None, material_ref=None, retain_hat=False):
        renderer_obj = self.resolve(self.refs_obj, renderer_ref)
        renderer = renderer_obj.read()
        mesh_obj = self.resolve(self.refs_obj, mesh_ref) if mesh_ref else renderer.m_Mesh.deref()
        material_obj = self.resolve(self.refs_obj, material_ref) if material_ref else renderer.m_Materials[0].deref()
        material = self.material(material_obj, module.pointer(material_obj), 'form')
        material.pop('skinColor', None)  # A skull is not the selected human skin.
        part = self.renderer_model(renderer_ref, mesh_override=mesh_obj, material_overrides=[material], role='form-body')
        handler = module.module.MeshHandler(mesh_obj.read())
        handler.process()
        raw_colors = np.asarray(handler.m_Colors or [], dtype=float)
        if len(raw_colors) == len(handler.m_Vertices):
            part['colors'] = np.round(raw_colors[:, :3] / 255, 6).reshape(-1).tolist()
        head_indices = head_bone_indices(renderer)
        head, used = extract_head(part, handler.m_BoneWeights, handler.m_BoneIndices, head_indices)
        head_triangle_count = sum(len(g['indices']) // 3 for g in head['groups'])
        portrait_scope = 'source-head-bone-topology'
        hat_offset = [0, 0, 0]
        if form == 'chicken':
            # The source is a headless roast chicken. Its Head-weighted vertices
            # are only a neck stump, not an actual head. Show its whole original
            # form as an explicitly labelled icon, never invent a chicken face.
            head = {**part, 'role': 'form-head'}
            portrait_scope = 'whole-form-no-head'
            hat = self.resolve(self.refs_obj, self.refs['hatTransform']).read()
            parent = self.transform(hat.m_Father.deref())
            # BecomeChicken moves local Y to -4.66. Account for the actual
            # parent scale/rotation before applying that shift to baked models.
            hat_offset = np.round(parent[:3, :3] @ np.array([0, -4.66 - hat.m_LocalPosition.y, 0]), 6).tolist()
        source = {'asset': mesh_obj.assets_file.name, 'meshPathId': mesh_obj.path_id,
                  'meshName': mesh_obj.read().m_Name, 'materialPathId': material_obj.path_id,
                  'materialName': material_obj.read().m_Name, 'rendererPathId': renderer_obj.path_id,
                  'headBoneNames': [renderer.m_Bones[i].read().m_GameObject.read().m_Name for i in head_indices],
                  'sourceVertexCount': len(handler.m_Vertices), 'headVertexCount': len(used),
                  'headTriangleCount': head_triangle_count,
                  'headSelection': 'all-triangle-vertices-have-Head-descendant-weight-at-least-0.999'}
        common = {'form': form, 'source': source,
                  'limitations': ['Original neutral pose and vertex colors; custom shader texture layers and transition animation are not reproduced']}
        model = self.save(f'models/forms/{form}.json', {**common, 'parts': [part]})
        head_model = self.save(f'models/forms/{form}-head.json', {**common, 'purpose': 'form-head',
                               'portraitScope': portrait_scope, 'parts': [head]})
        return {'form': form, 'model': model, 'headModel': head_model, 'retainHat': retain_hat,
                'hatOffset': hat_offset, 'portraitScope': portrait_scope, 'source': source}

    def run_forms(self):
        installed = module.game_info(self.game)[2]
        if str(installed) != self.build:
            raise ValueError(f'Installed build {installed} does not match requested build {self.build}')
        catalog = json.loads((self.root / 'catalog.json').read_text(encoding='utf8'))
        if str(catalog.get('gameBuildId')) != self.build:
            raise ValueError('Form extraction requires the exact installed build catalog')
        forms = [self.form('skeleton', self.refs['skeletonRenderer'], self.refs['skeletonThirdPerson'],
                           self.refs['skeletonThirdPersonMat'], retain_hat=True),
                 self.form('mushroom', self.refs['skeletonRenderer'], self.refs['mushroomManMesh'],
                           self.refs['mushroomManMaterial']),
                 self.form('chicken', self.refs['chickenRenderer'], retain_hat=True)]
        catalog['customization']['forms'] = forms
        allowed = {entry['path'] for entry in catalog['assets']}
        allowed.update(path for entry in forms for path in (entry['model'], entry['headModel']))
        allowed.update(self.images.values())
        catalog['assets'] = [{'path': path, 'sha256': hashlib.sha256((self.root / path).read_bytes()).hexdigest(),
                              'bytes': (self.root / path).stat().st_size} for path in sorted(allowed)]
        self.save('catalog.json', catalog)
        print(json.dumps({'forms': forms, 'assets': len(catalog['assets'])}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--game', default=r'C:\Program Files (x86)\Steam\steamapps\common\PEAK')
    parser.add_argument('--output', default=str(HERE.parents[2] / 'local/assets/game-assets'))
    parser.add_argument('--build', default='25306743')
    args = parser.parse_args()
    FormExporter(args.game, args.output, args.build).run_forms()
