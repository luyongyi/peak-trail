"""Unpack PEAK's UnityFS data without instantiating millions of Unity objects.

Files remain a private, read-only export input. The installed game is untouched.
The raw serialized-file bytes are preserved, so scene hashes remain meaningful.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from UnityPy.enums import ArchiveFlags, CompressionFlags
from UnityPy.helpers import CompressionHelper
from UnityPy.streams import EndianBinaryReader


def unpack(bundle: Path, destination: Path):
    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    with bundle.open('rb') as stream:
        reader = EndianBinaryReader(stream)
        if reader.read_string_to_null() != 'UnityFS':
            raise ValueError('Expected an unencrypted UnityFS bundle')
        version = reader.read_u_int()
        player_version = reader.read_string_to_null()
        engine_version = reader.read_string_to_null()
        declared_size = reader.read_long()
        compressed_size, uncompressed_size, flags = (reader.read_u_int() for _ in range(3))
        if declared_size != bundle.stat().st_size or version < 7:
            raise ValueError('Unexpected UnityFS size/version')
        if flags & ArchiveFlags.UsesAssetBundleEncryption:
            raise ValueError('Encrypted game data is unsupported')
        reader.align_stream(16)
        start = reader.Position
        if flags & ArchiveFlags.BlocksInfoAtTheEnd:
            reader.Position = reader.Length - compressed_size
        compressed = reader.read_bytes(compressed_size)
        metadata = CompressionHelper.DECOMPRESSION_MAP[CompressionFlags(flags & 0x3f)](compressed, uncompressed_size)
        if flags & ArchiveFlags.BlocksInfoAtTheEnd:
            reader.Position = start
        info = EndianBinaryReader(metadata)
        info.read_bytes(16)
        blocks = [(info.read_u_int(), info.read_u_int(), info.read_u_short()) for _ in range(info.read_int())]
        entries = [(info.read_long(), info.read_long(), info.read_u_int(), info.read_string_to_null()) for _ in range(info.read_int())]
        if flags & ArchiveFlags.BlockInfoNeedPaddingAtStart:
            reader.align_stream(16)
        entries.sort()
        targets = {}
        unique_names = set()
        total_bytes = sum(block[0] for block in blocks)
        previous_end = 0
        for offset, size, _, name in entries:
            target = (destination / name).resolve()
            if not target.is_relative_to(destination) or target == destination:
                raise ValueError('Unsafe bundle entry')
            if name.casefold() in unique_names or offset < previous_end or size < 0 or offset + size > total_bytes:
                raise ValueError('Overlapping or invalid bundle entries')
            unique_names.add(name.casefold())
            previous_end = offset + size
            if target.exists():
                raise ValueError(f'Private extraction input already exists: {target}')
            targets[name] = target
        handles = {}
        hashes = {}
        written = {}
        for offset, size, _, name in entries:
            target = targets[name]
            target.parent.mkdir(parents=True, exist_ok=True)
            handles[name] = target.open('wb')
            hashes[name] = hashlib.sha256()
            written[name] = 0
        position = 0
        try:
            for raw_size, packed_size, block_flags in blocks:
                raw = CompressionHelper.DECOMPRESSION_MAP[CompressionFlags(block_flags & 0x3f)](reader.read_bytes(packed_size), raw_size)
                if len(raw) != raw_size:
                    raise ValueError('Decompressed block length mismatch')
                for offset, size, _, name in entries:
                    lo, hi = max(position, offset), min(position + raw_size, offset + size)
                    if lo < hi:
                        part = raw[lo - position:hi - position]
                        handles[name].write(part)
                        hashes[name].update(part)
                        written[name] += len(part)
                position += raw_size
        finally:
            for handle in handles.values():
                handle.close()
        if any(written[name] != size for _, size, _, name in entries):
            raise ValueError('Incomplete extraction')
        with bundle.open('rb') as source:
            source_digest = hashlib.file_digest(source, 'sha256').hexdigest()
        result = {'schemaVersion': 1, 'unityVersion': engine_version, 'playerVersion': player_version,
                  'sourceBundle': bundle.name, 'sourceBundleSha256': source_digest,
                  'files': [{'name': name, 'bytes': size, 'sha256': hashes[name].hexdigest()} for _, size, _, name in entries]}
        (destination / 'extraction-evidence.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf8')
        print(json.dumps({'files': len(entries), 'bytes': position, 'destination': str(destination)}, indent=2), flush=True)
        return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    unpack(args.bundle, args.destination)
