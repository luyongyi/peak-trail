"""Read-only inspection of PEAK Unity assets (no game process required)."""
import argparse
import json
from pathlib import Path
from collections import Counter
import UnityPy
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator

p = argparse.ArgumentParser()
p.add_argument("--game", default=r"C:\Program Files (x86)\Steam\steamapps\common\PEAK")
p.add_argument("--file", default="resources.assets")
p.add_argument("--class-name", default="Customization")
p.add_argument("--full", action="store_true")
args = p.parse_args()
env = UnityPy.load(str(Path(args.game) / "PEAK_Data" / args.file))
generator = TypeTreeGenerator(env.objects[0].assets_file.unity_version)
generator.load_local_game(args.game)
env.typetree_generator = generator
counts = Counter()
for obj in list(env.objects):
    if obj.type.name != "MonoBehaviour":
        continue
    try:
        head = obj.parse_monobehaviour_head()
        if not head.m_Script.m_PathID:
            continue
        name = head.m_Script.read().m_ClassName
        counts[name] += 1
        if name == args.class_name:
            data = obj.read_typetree()
            print(obj.assets_file.name, obj.path_id, json.dumps(data if args.full else {k:v for k,v in data.items() if k in ['m_Name','skins','fits','hats','eyes','mouths','accessories','sashes','medals']},ensure_ascii=False))
    except Exception as exc:
        print("ERROR",obj.path_id, str(exc)[:150])
print("COUNTS",counts.most_common(100))
