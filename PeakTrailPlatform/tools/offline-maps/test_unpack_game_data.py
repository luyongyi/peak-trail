import contextlib
import io
from pathlib import Path
import struct
import tempfile
import unittest
from unpack_game_data import unpack


def bundle_fixture(name='level5'):
    payload = b'original scene bytes'
    metadata = b'\0' * 16 + struct.pack('>I', 1) + struct.pack('>IIH', len(payload), len(payload), 0)
    metadata += struct.pack('>I', 1) + struct.pack('>qqI', 0, len(payload), 4) + name.encode() + b'\0'
    prefix = b'UnityFS\0' + struct.pack('>I', 7) + b'6000.0.0f1\0' * 2
    header = prefix + struct.pack('>qIII', 0, len(metadata), len(metadata), 64)
    header += b'\0' * (-len(header) % 16)
    value = header + metadata + payload
    return value[:len(prefix)] + struct.pack('>q', len(value)) + value[len(prefix) + 8:], payload


class BundleInputTests(unittest.TestCase):
    def test_streaming_extract_keeps_exact_serialized_bytes_and_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            value, payload = bundle_fixture()
            bundle = root / 'data.unity3d'
            bundle.write_bytes(value)
            with contextlib.redirect_stdout(io.StringIO()):
                result = unpack(bundle, root / 'private')
            self.assertEqual((root / 'private/level5').read_bytes(), payload)
            self.assertEqual(result['files'][0]['bytes'], len(payload))
            self.assertTrue((root / 'private/extraction-evidence.json').is_file())

    def test_rejects_paths_outside_private_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            value, _ = bundle_fixture('../outside')
            bundle = root / 'data.unity3d'
            bundle.write_bytes(value)
            with self.assertRaisesRegex(ValueError, 'Unsafe bundle entry'):
                unpack(bundle, root / 'private')
            self.assertFalse((root / 'outside').exists())


if __name__ == '__main__':
    unittest.main()
