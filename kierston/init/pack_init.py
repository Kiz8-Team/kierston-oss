"""Gather the packed init outputs into one container with a section directory.

Every binary in sim_data/ already opens the same way — four bytes of magic, a
u32 header length, a JSON header, then raw typed arrays on an 8-byte grid.
pack_population.py writes it as KPOP, pack_records.py writes it six times as
KREC, ties.py writes it as KTIE. Three packers, one envelope, by convention
rather than by anything enforcing it.

This nests them. A KSIM container is that same envelope with a header whose
payload is a directory of sections, and each section is one of those files
copied in whole:

    "KSIM"                     4 bytes
    header length              u32, little-endian
    header                     JSON — provenance, digest, section directory
    padding                    to an 8-byte boundary
    sections                   each a complete container, 8-aligned

Why nest rather than merge
--------------------------
A merged file would have to renumber every array offset, and the two packers
would have to grow a mode where they hand back bytes instead of writing a file.
Nesting costs neither: a section's bytes are byte-for-byte the file that exists
today, so this stage cannot corrupt what it packages, and a reader handed one
section is holding exactly what it would have downloaded before.

What it buys is the thing the separate files were bought for. pack_records.py
splits into six so the firearms page does not parse 147,301 civil dockets; that
split is a good decision defended by a filename, and here it is defended by a
byte range instead. A reader fetches the directory — a couple of kilobytes at
the front — and then asks for the one section it needs. The route serves it
with a 206, so one file behaves like sixteen without anyone having to remember
which sixteen.

Alignment is the one thing to get right. A section starts on an 8-byte boundary
so that a reader slicing it out keeps the alignment its own typed arrays were
written against. Nothing here inspects a section beyond its magic and its
length — a KSIM container does not know what a mortgage is either.

Cheap and safe to re-run. It reads only what earlier stages wrote and holds no
opinion about any of it, so it goes last and can be repeated at any time.
"""

import hashlib
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path


from paths import SIM_DATA
OUTPUT = SIM_DATA / "sim_init.bin"

MAGIC = b"KSIM"
VERSION = 1

# The sections, in the order they are written. Order is not load order — a
# reader seeks — but it keeps the directory readable and puts the two files
# every page touches at the front, which is where a cold cache notices.
#
# `required` is what makes a missing file an error rather than a smaller
# container: the population and the identities are what everything else keys
# against, and a container quietly missing them would fail later and further
# away, in a viewer, as an empty table.
SECTIONS = [
    ("population", "population.bin", True),
    ("identity", "identity.bin", True),
    ("criminal", "criminal.bin", False),
    ("civil", "civil.bin", False),
    ("firearms", "firearms.bin", False),
    ("vehicles", "vehicles.bin", False),
    ("externalTraffic", "external_traffic.bin", True),
    ("holdings", "holdings.bin", False),
    ("ties", "ties.bin", False),
]


def align8(value):
    return (value + 7) & ~7


def read_envelope(path):
    """The magic and header of a packed file, without reading its arrays.

    Every section is validated this far before being copied. A truncated or
    half-written file is the failure this catches — it is indistinguishable
    from a good one by size alone, and nesting it would produce a container
    that only fails when something tries to decode the section.
    """
    with path.open("rb") as handle:
        prefix = handle.read(8)
        if len(prefix) < 8:
            raise SystemExit(f"{path.name} is truncated ({len(prefix)} bytes)")
        magic = prefix[0:4]
        length = struct.unpack("<I", prefix[4:8])[0]
        header = handle.read(length)
        if len(header) < length:
            raise SystemExit(
                f"{path.name}: header length {length:,} bytes, {len(header):,} "
                f"read; truncated or not a packed file")
        try:
            meta = json.loads(header)
        except json.JSONDecodeError as error:
            raise SystemExit(f"{path.name} has an unreadable header: {error}")
    return magic.decode("ascii", "replace"), meta


class Container:
    """Collects named sections, then writes them behind a directory.

    Sections are held as paths rather than bytes. The whole set is around
    160 MB and there is no reason for all of it to be resident at once — the
    write below streams each one in as it goes.
    """

    def __init__(self, magic=MAGIC, **meta):
        self.magic = magic
        self.meta = meta
        self.sections = []

    def add_file(self, name, path):
        section_magic, header = read_envelope(path)
        self.sections.append({
            "name": name,
            "magic": section_magic,
            "source": path.name,
            "byteLength": path.stat().st_size,
            # Kept so the directory can answer "how much is in here" without a
            # reader fetching a section to find out. Both are already in the
            # nested header; this is a copy for the benefit of a summary view.
            "rows": header.get("counts") or {
                table["name"]: table["rows"] for table in header.get("tables", ())
            } or None,
            "path": path,
        })
        return self.sections[-1]

    def write(self, path):
        # Two passes. The first lays out the sections to learn their offsets,
        # which the header has to carry; the second writes. The offsets depend
        # on the header's length and the header's length depends on the
        # offsets, so the layout is done against a placeholder and the header
        # is padded to a fixed width rather than solved for.
        offset = 0
        for section in self.sections:
            section["byteOffset"] = offset
            offset = align8(offset + section["byteLength"])
        total = offset

        digest = hashlib.sha256()
        for section in self.sections:
            with section["path"].open("rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)

        directory = [
            {key: value for key, value in section.items() if key != "path"}
            for section in self.sections
        ]
        header = json.dumps({
            "magic": self.magic.decode(),
            "version": VERSION,
            **self.meta,
            # What a day file names to say which population it was generated
            # against. Over the section payloads only, so it does not depend on
            # this stage's own timestamp — repacking an unchanged set of inputs
            # gives the same digest.
            "digest": digest.hexdigest()[:16],
            "byteLength": total,
            "sections": directory,
        }, separators=(",", ":")).encode()

        data_start = align8(8 + len(header))
        with path.open("wb") as out:
            out.write(self.magic)
            out.write(len(header).to_bytes(4, "little"))
            out.write(header)
            out.write(b"\0" * (data_start - 8 - len(header)))
            written = 0
            for section in self.sections:
                out.write(b"\0" * (section["byteOffset"] - written))
                with section["path"].open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1 << 20), b""):
                        out.write(chunk)
                written = section["byteOffset"] + section["byteLength"]
            out.write(b"\0" * (total - written))

        return data_start + total, digest.hexdigest()[:16]


def main() -> None:
    container = None
    missing = []
    present = []

    for name, filename, required in SECTIONS:
        path = SIM_DATA / filename
        if not path.exists():
            if required:
                raise SystemExit(
                    f"{filename} is missing — run the {name} stage first")
            missing.append(filename)
            continue
        present.append((name, path))

    # Provenance comes from the population's own header rather than from a
    # command line, so the container cannot claim a seed the data was not
    # built with.
    _, population_header = read_envelope(SIM_DATA / "population.bin")

    container = Container(
        builtAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        seed=population_header.get("seed"),
        placementSeed=population_header.get("placementSeed"),
    )
    for name, path in present:
        container.add_file(name, path)

    size, digest = container.write(OUTPUT)

    print(f"{len(container.sections)} sections  digest {digest}")
    print("\nsections:")
    for section in container.sections:
        print(f"  {section['name']:<12} {section['magic']}  "
              f"{section['byteOffset']:>11,}  "
              f"{section['byteLength'] / 1e6:>7.1f} MB")
    if missing:
        print(f"\nnot packed (not built yet): {', '.join(missing)}")
    print(f"\nWrote {OUTPUT} ({size / 1e6:.1f} MB)")
    print("sections copied unchanged from their source files")


if __name__ == "__main__":
    main()
