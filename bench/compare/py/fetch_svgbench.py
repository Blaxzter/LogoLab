"""Fetch StarVector's SVG-Bench `svg-emoji` TEST split and freeze the v0 selection.

    .bench-tools/starvector-venv/Scripts/python.exe -I bench/compare/py/fetch_svgbench.py

Why this split: it is the only colour-icon split of SVG-Bench (arXiv 2312.11556), it is a
PUBLISHED held-out split the tracer was never tuned on, and every row is an authored SVG —
so one case carries both the literature's pixel metrics and LogoLab's geometry gates. The
svg-icons / *-simple splits are DeepSVG hairline outlines (fill none, stroke .3) and are
skipped for v0 (bench/compare/README in the run.ts header says why).

Writes, all under .bench-tools/datasets/svg-emoji/ (gitignored):
  raw/test.parquet                       the split, pinned to REVISION below
  test/<Filename>                        all 668 rows as files
and, checked in, bench/compare/manifests/svg-emoji-test.json: every row's filename, source
set, licence, sha256 of the SVG text, and whether it is in the frozen v0 slice.

v0 slice (deterministic, no peeking at results): Twemoji rows only (all fill-only), skin-tone
and FE0F variants collapsed to one per base sequence (the variant with the smallest
sha1(Filename)), bases ranked by sha1 of that filename, first 100.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / ".bench-tools" / "datasets" / "svg-emoji"
MANIFEST = REPO / "bench" / "compare" / "manifests" / "svg-emoji-test.json"
DATASET = "starvector/svg-emoji"
REVISION = "a4209d1752ba3014b23077d225ad1040db6cbd9b"  # HF dataset sha, 2025-01-10
# The ORIGINAL data file at the pinned commit, not the /api/.../parquet convert endpoint
# (that serves whatever refs/convert/parquet points at today). Its sha256 is checked.
URL = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/data/test-00000-of-00001.parquet"
PARQUET_SHA256 = "da3a8e37491c482cff810cce9fcafdd02147720ed9207e4c0f0f8daa63c6f913"
V0_SIZE = 100

SOURCES = {
    # Twemoji: (c) Twitter, CC-BY 4.0; twitter/twemoji is archived, jdecked/twemoji maintains it.
    "-twemoji.svg": ("twemoji", "CC-BY-4.0", "https://github.com/jdecked/twemoji"),
    "-openmoji.svg": ("openmoji", "CC-BY-SA-4.0", "https://github.com/hfg-gmuend/openmoji"),
    "-noto-emoji.svg": ("noto", "Apache-2.0", "https://github.com/googlefonts/noto-emoji"),
}
SKIN = {"1f3fb", "1f3fc", "1f3fd", "1f3fe", "1f3ff", "fe0f"}


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode()).hexdigest()


def source_of(name: str) -> tuple[str, str, str]:
    for suffix, meta in SOURCES.items():
        if name.endswith(suffix):
            return meta
    return ("unknown", "unknown", "")


def base_of(name: str) -> str:
    stem = name.rsplit("-twemoji.svg", 1)[0]
    return "-".join(cp for cp in stem.split("-") if cp not in SKIN)


def main() -> int:
    import pyarrow.parquet as pq

    raw = DATA / "raw" / "test.parquet"
    if not raw.exists():
        raw.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {URL}")
        urllib.request.urlretrieve(URL, raw)
    got = hashlib.sha256(raw.read_bytes()).hexdigest()
    if got != PARQUET_SHA256:
        print(f"parquet sha256 {got} != pinned {PARQUET_SHA256}; refusing (delete {raw} to re-fetch)",
              file=sys.stderr)
        return 1
    table = pq.read_table(raw)
    rows = list(zip(table.column("Filename").to_pylist(), table.column("Svg").to_pylist()))
    print(f"{len(rows)} test rows")

    out = DATA / "test"
    out.mkdir(parents=True, exist_ok=True)
    for name, svg in rows:
        if "/" in name or "\\" in name or name.startswith("."):
            print(f"refusing odd filename {name!r}", file=sys.stderr)
            return 1
        # BYTES: write_text on Windows rewrites LF as CRLF, and the files then stop matching
        # the manifest's sha256 (349 of 668 did before this). corpus.ts verifies them.
        (out / name).write_bytes(svg.encode("utf-8"))

    # v0: one Twemoji per base sequence, fill-only, ranked by sha1.
    best: dict[str, str] = {}
    for name, svg in rows:
        if not name.endswith("-twemoji.svg"):
            continue
        if "stroke" in svg or "Gradient" in svg or "clip" in svg:
            continue
        b = base_of(name)
        if b not in best or sha1(name) < sha1(best[b]):
            best[b] = name
    v0 = set(sorted(best.values(), key=sha1)[:V0_SIZE])
    print(f"{len(best)} Twemoji bases; v0 = {len(v0)}")

    entries = []
    for name, svg in sorted(rows):
        src, lic, home = source_of(name)
        entries.append(dict(
            file=name, source=src, license=lic, home=home,
            sha256=hashlib.sha256(svg.encode()).hexdigest(), v0=name in v0,
        ))
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_bytes(json.dumps(dict(
        dataset=DATASET, revision=REVISION, split="test", url=URL, parquetSha256=PARQUET_SHA256,
        note="SVG-Bench svg-emoji test split. No licence on the HF card; per-row licence is the "
             "upstream emoji set's. v0 = 100 Twemoji, one per base emoji, ranked by sha1(file).",
        rows=entries), indent=1).encode("utf-8"))
    print(f"wrote {MANIFEST.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
