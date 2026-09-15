"""Read only cosmetic choices from Steam's local PEAK stat cache.

Output is current local preference, never a historical trail assertion.
Do not put its output into the public game-assets catalog.
"""
import argparse
import json
import struct
from pathlib import Path
from datetime import datetime,timezone

class BinaryKV:
    def __init__(self,data): self.data=data; self.pos=0
    def string(self):
        end=self.data.index(0,self.pos); s=self.data[self.pos:end].decode('utf8',errors='replace'); self.pos=end+1; return s
    def number(self,fmt):
        value=struct.unpack_from('<'+fmt,self.data,self.pos)[0]; self.pos+=struct.calcsize(fmt); return value
    def object(self):
        values={}
        while self.pos<len(self.data):
            kind=self.number('B')
            if kind in (8,11): return values
            key=self.string()
            if kind==0: val=self.object()
            elif kind==1: val=self.string()
            elif kind==2: val=self.number('i')
            elif kind==3: val=self.number('f')
            elif kind==7: val=self.number('Q')
            elif kind==10: val=self.number('q')
            else: raise ValueError(f'Unsupported binary KV type {kind} at {self.pos}')
            values[key]=val
        return values

def walk(data,path=()):
    if not isinstance(data,dict): return
    for key,value in data.items():
        if isinstance(value,dict):
            yield path+(key,),value
            yield from walk(value,path+(key,))

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--stats',default=r'C:\Program Files (x86)\Steam\appcache\stats')
    p.add_argument('--output')
    args=p.parse_args(); root=Path(args.stats)
    schema=BinaryKV((root/'UserGameStatsSchema_3527290.bin').read_bytes()).object()
    cache_files=list(root.glob('UserGameStats_*_3527290.bin'))
    results=[]
    for f in cache_files:
        cache=BinaryKV(f.read_bytes()).object()
        known={}
        for path,entry in walk(schema):
            name=entry.get('name','')
            if not isinstance(name,str) or 'cosmetic' not in name.lower(): continue
            stat_id=path[-1]
            values=[entry for path,entry in walk(cache) if path[-1]==stat_id and 'data' in entry]
            if values: known[name]=values[0]['data']
        result={'source':'steam-local-cache-current','historical':False,
                'observedAtUtc':datetime.now(timezone.utc).isoformat(),
                'cacheModifiedAtUtc':datetime.fromtimestamp(f.stat().st_mtime,tz=timezone.utc).isoformat(),
                'cosmeticStats':known}
        results.append(result)
    text=json.dumps(results,ensure_ascii=False,indent=2)
    if args.output:
        out=Path(args.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(text,encoding='utf8')
    print(text)

if __name__=='__main__': main()
