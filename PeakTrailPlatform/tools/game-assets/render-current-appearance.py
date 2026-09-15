"""Private, explicitly current-only preview; never modifies any trail log."""
import argparse
import importlib.util
import json
from pathlib import Path

p=argparse.ArgumentParser(); p.add_argument('catalog_root'); p.add_argument('appearance'); p.add_argument('output'); args=p.parse_args()
root=Path(args.catalog_root); catalog=json.loads((root/'catalog.json').read_text(encoding='utf8')); c=catalog['customization']
data=json.loads(Path(args.appearance).read_text(encoding='utf8'))[0]
stats=data['cosmeticStats']; fit=c['fits'][stats['Cosmetic_Outfit']]
model=json.loads((root/c['avatar']['model']).read_text(encoding='utf8'))
parts=model['parts']
roles={'eyes':('eyes','Cosmetic_Eyes'),'mouth':('mouths','Cosmetic_Mouth'),'accessory':('accessories','Cosmetic_Accessory')}
for part in parts:
    if part['role'] in roles:
        group,stat=roles[part['role']]; option=c[group][stats[stat]]
        for mat in part['groups']: mat['material']['texture']=option.get('texture')
parts+=json.loads((root/fit['model']).read_text(encoding='utf8'))['parts']
hat=fit['overrideHatIndex'] if fit.get('overrideHat') else stats['Cosmetic_Hat']
for group,index in [('hats',hat),('sashes',stats['Cosmetic_Sash']),('medals',stats['Cosmetic_Medal'])]:
    option=c[group][index]
    if option.get('model'):
        extra=json.loads((root/option['model']).read_text(encoding='utf8'))['parts']
        if group=='hats' and index in (0,1) and fit.get('hatMaterial'):
            for part in extra:
                for g in part['groups']: g['material']=fit['hatMaterial']
        parts+=extra
spec=importlib.util.spec_from_file_location('renderer',Path(__file__).with_name('render-previews.py'))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
output=Path(args.output); output.parent.mkdir(parents=True,exist_ok=True)
module.Renderer(root).render(parts,skin=c['skins'][stats['Cosmetic_Skin']]['color'][:3],size=640).save(output)
print(json.dumps({'source':data['source'],'historical':False,'outfit':fit['name'],'hat':c['hats'][hat]['name'],'output':str(output)},ensure_ascii=False))
