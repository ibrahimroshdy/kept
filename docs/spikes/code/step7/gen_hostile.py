"""Hostile archives for the Z1 spike (D157, engineering spec §3.1b). T7 commits the small ones under
apps/server/test/fixtures/zip/; the 200,001-entry and 1 GB-of-zeros archives are regenerated here.

    python3 gen_hostile.py out/hostile
"""

import os
import struct
import sys
import zipfile
import zlib

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)


def path(name):
    return os.path.join(OUT, name)


def simple(name, entries, **kw):
    with zipfile.ZipFile(path(name), "w", zipfile.ZIP_DEFLATED, **kw) as z:
        for info, data in entries:
            z.writestr(info, data)


def manifest():
    return ("manifest.json", b'{"schemaVersion":1}\n')


# 1. One entry of 1 GiB of zeros: about 1 MiB deflated, a ratio near 1000:1.
with zipfile.ZipFile(path("ratio-1g-zeros.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(*manifest())
    with z.open("entities.json", "w", force_zip64=True) as f:
        block = bytes(1 << 20)
        for _ in range(1024):
            f.write(block)

# 2. 200,001 empty entries (one over the cap). More than 65,535, so the archive is ZIP64.
with zipfile.ZipFile(path("entries-200001.zip"), "w", zipfile.ZIP_STORED) as z:
    z.writestr(*manifest())
    for i in range(200_000):
        z.writestr(f"attachments/{i:06d}", b"")

# 3. A symlink entry (Unix mode 0120777, made by Unix).
link = zipfile.ZipInfo("attachments/0b7c6e4e-0000-4000-8000-000000000001")
link.create_system = 3
link.external_attr = (0o120777 << 16)
simple("symlink.zip", [manifest(), (link, b"/etc/passwd")])

# 4–6. Names yauzl's validateFileName() refuses.
simple("dotdot.zip", [manifest(), ("../x", b"x")])
simple("absolute.zip", [manifest(), ("/etc/x", b"x")])
simple("backslash.zip", [manifest(), ("a\\b", b"x")])

# 7. Two entries with one name.
with zipfile.ZipFile(path("duplicate.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(*manifest())
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        z.writestr("manifest.json", b'{"schemaVersion":2}\n')

# 8. A header that understates its size: 10 MiB of zeros declared as 1,000 bytes, in both the
#    local header and the central directory.
simple("understated.zip", [manifest(), ("entities.json", bytes(10 << 20))])
with open(path("understated.zip"), "r+b") as f:
    data = bytearray(f.read())
    real = 10 << 20
    # Local file header: signature PK\3\4, uncompressed size at offset 22.
    i = 0
    while (i := data.find(b"PK\x03\x04", i)) != -1:
        if struct.unpack_from("<I", data, i + 22)[0] == real:
            struct.pack_into("<I", data, i + 22, 1000)
        i += 4
    # Central directory header: signature PK\1\2, uncompressed size at offset 24.
    i = 0
    while (i := data.find(b"PK\x01\x02", i)) != -1:
        if struct.unpack_from("<I", data, i + 24)[0] == real:
            struct.pack_into("<I", data, i + 24, 1000)
        i += 4
    f.seek(0)
    f.write(data)

# 9. A truncated archive: a valid one cut in half (no end-of-central-directory record).
simple("whole.zip", [manifest(), ("entities.json", os.urandom(64 << 10))])
with open(path("whole.zip"), "rb") as f:
    whole = f.read()
with open(path("truncated.zip"), "wb") as f:
    f.write(whole[: len(whole) // 2])
os.remove(path("whole.zip"))

# 10. A legitimate ZIP64 archive (ZIP64 extra fields on a small entry). It must open.
with zipfile.ZipFile(path("zip64.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(*manifest())
    with z.open("entities.json", "w", force_zip64=True) as f:
        f.write(b'[{"id":"x"}]\n')

# 11. A control: a small, well-formed archive shaped like a Homebox export.
simple("ok.zip", [manifest(), ("entities.json", b"[]\n"), ("attachments/0b7c6e4e-0000-4000-8000-000000000002", os.urandom(4096))])

for n in sorted(os.listdir(OUT)):
    print(f"{os.path.getsize(path(n)):>12,}  {n}")
