"""Read-only Unity scene probes used to verify the offline map pipeline."""
import sys, json, time, collections, struct
from pathlib import Path
import UnityPy
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator

game = Path(r'C:\Program Files (x86)\Steam\steamapps\common\PEAK')
target = sys.argv[1] if len(sys.argv) > 1 else 'level20'
start = time.time()
env = UnityPy.load(str(game / 'PEAK_Data' / target))
scene = next(iter(env.files.values()))
print('loaded', scene.name, scene.unity_version, len(scene.objects), time.time()-start, flush=True)
gen = TypeTreeGenerator(scene.unity_version)
gen.load_local_game(str(game))
scripts = {}
for obj in scene.objects.values():
    if obj.type.name != 'MonoBehaviour':
        continue
    env.typetree_generator = None
    mb = obj.read(check_read=False)
    ptr = mb.m_Script
    key = (ptr.m_FileID, ptr.m_PathID)
    if key not in scripts:
        try:
            scripts[key] = ptr.read().m_ClassName
        except Exception:
            scripts[key] = '?'
    if scripts[key] in ('MapHandler', 'Biome', 'VoidBiome'):
        env.typetree_generator = gen
        tree = obj.read_typetree()
        print('FOUND', scripts[key], obj.path_id, json.dumps(tree), flush=True)
for typ in ('Transform','GameObject','MeshFilter','MeshRenderer','MeshCollider','LODGroup'):
    matches = [o for o in scene.objects.values() if o.type.name == typ]
    print('EXAMPLE',typ,matches[100].path_id if len(matches)>100 else matches[0].path_id,(matches[100] if len(matches)>100 else matches[0]).read_typetree(),flush=True)
print('finished', time.time()-start)
