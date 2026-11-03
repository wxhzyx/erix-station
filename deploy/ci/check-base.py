"""Fail closed when runtime Dockerfiles drift from the reviewed GHCR base contract."""
import hashlib
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[2]
contract = json.loads((root/'deploy/ci/runtime-contract.json').read_text())
for name, expected in contract.items():
    actual = hashlib.sha256((root/name).read_bytes().replace(b'\r\n', b'\n')).hexdigest()
    if actual != expected:
        raise SystemExit(f'{name} changed: review/update pinned CI runtime base before publishing')
print('Pinned runtime base contract verified')
