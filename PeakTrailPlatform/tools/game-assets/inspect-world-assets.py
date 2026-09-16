"""Read-only source evidence for world-object exports; never launches PEAK."""
import argparse
import json
import re
from pathlib import Path
import UnityPy
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--game', type=Path, default=Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK'))
    parser.add_argument('--files', nargs='+', default=['resources.assets', 'sharedassets4.assets'])
    parser.add_argument('--match', default='Mine|Zombie|Sleep|Spore|Shroom|Fog|Mushroom')
    parser.add_argument('--types', nargs='+', default=['MonoBehaviour', 'Material', 'GameObject', 'Mesh', 'Texture2D'])
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--tree', help='Print a GameObject hierarchy as FILE:PATH_ID')
    parser.add_argument('--status-type', type=int, help='Filter serialized statusType after class matching')
    args = parser.parse_args()
    env = UnityPy.load(*[str(args.game / 'PEAK_Data' / name) for name in args.files])
    generator = TypeTreeGenerator(env.objects[0].assets_file.unity_version)
    generator.load_local_game(str(args.game))
    env.typetree_generator = generator
    if args.tree:
        filename, path_id = args.tree.split(':')
        root = next(o for o in list(env.objects) if o.assets_file.name == filename and o.path_id == int(path_id))
        def visit(go, depth=0):
            value = go.read()
            components = [c.component.deref() for c in value.m_Component]
            labels = []
            for component in components:
                label = component.type.name
                if label == 'MonoBehaviour':
                    head = component.parse_monobehaviour_head()
                    label += ':' + (head.m_Script.read().m_ClassName if head.m_Script.m_PathID else '?')
                if label in ('MeshRenderer', 'SkinnedMeshRenderer'):
                    label += ':' + ','.join(p.read().m_Name for p in component.read().m_Materials if p.m_PathID)
                labels.append(f'{label}@{component.path_id}')
            print('  '*depth + f'{value.m_Name} GO:{go.path_id} active:{value.m_IsActive} ' + ', '.join(labels))
            trans = next((c for c in components if c.type.name in ('Transform', 'RectTransform')), None)
            if trans:
                for child in trans.read().m_Children:
                    visit(child.read().m_GameObject.deref(), depth+1)
        visit(root)
        return
    for obj in list(env.objects):
        kind = obj.type.name
        if kind not in args.types:
            continue
        if kind == 'MonoBehaviour':
            head = obj.parse_monobehaviour_head()
            if not head.m_Script.m_PathID:
                continue
            name = head.m_Script.read().m_ClassName
        else:
            name = obj.read().m_Name
        if not re.search(args.match, name, re.I):
            continue
        if args.status_type is not None and obj.read_typetree().get('statusType') != args.status_type:
            continue
        print(json.dumps({'file': obj.assets_file.name, 'pathId': obj.path_id,
                          'type': kind, 'name': name,
                          **({'data': obj.read_typetree()} if args.full else {})}, default=lambda value: f'<{type(value).__name__}>'))


if __name__ == '__main__':
    main()
