"""OmniSVG image -> SVG runner for the LogoLab vectorizer benchmark.

Run with the OmniSVG venv's interpreter, isolated (-I) so nothing is imported from the cwd:

  .bench-tools/omnisvg-venv/Scripts/python.exe -I bench/compare/py/omnisvg_run.py \
      --in-dir pngs/ --out-dir svgs/ --report svgs/report.json

The model is OmniSVG1.1_4B (NeurIPS 2025) on Qwen2.5-VL-3B-Instruct, both at pinned
revisions, driven through the repo's OWN inference.py functions (.bench-tools/omnisvg-src at
OMNISVG_SRC_SHA): its preprocessing (composite on white, background check, LANCZOS to 448),
its prompt, its image-to-svg sampling defaults from config.yaml (T 0.3, top-p 0.9, top-k 50,
repetition 1.05, max 1536 new tokens), and its rule for which sample is the answer: the
FIRST candidate that decodes and renders non-empty. Nothing compares a candidate with the
input. We ask for one candidate, which the script samples as 1 + 4 buffer sequences; its
default of 4 candidates would draw 8 and still keep the first.

Deviations, all explicit:

* A fixed seed per image (torch.manual_seed), so a run is reproducible.
* The weights are a pickled pytorch_model.bin; they are loaded with weights_only=True, which
  cannot execute code from the file (the repo's own load is a plain torch.load).
* cairosvg needs the Cairo C library, which Windows does not have. The `cairosvg` module is
  stubbed with resvg (resvg-py), the renderer the benchmark scores with. inference.py uses
  it only for the non-empty check; deepsvg imports it at module level.
* IPython and moviepy are imported by deepsvg for notebook display helpers that this path
  never calls; they are stubbed rather than installed.
* torch 2.5.1+cu124 instead of the README's 2.3.0+cu121 (the CUDA build this machine runs);
  transformers is the repo's pin, 4.51.3.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parents[3] / ".bench-tools"
SRC = HERE / "omnisvg-src"
os.environ.setdefault("HF_HUB_CACHE", str(HERE / "hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")  # everything is pinned and already on disk

OMNISVG_SRC_SHA = "308b49b3e3df29c8b5424bbaa7f1f7c6ff218e8d"
WEIGHTS = ("OmniSVG/OmniSVG1.1_4B", "117d4c4541839e02943554fe71c0a0d54fcef819")
QWEN = ("Qwen/Qwen2.5-VL-3B-Instruct", "66285546d2b821cf421d4f5eb2576359d3770cd3")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--in-dir", type=Path, required=True, help="directory of input PNGs (model loaded once)")
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--report", type=Path, help="JSON report (per image: time, VRAM, status)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--candidates", type=int, default=1)
    p.add_argument("--skip-existing", action="store_true")
    return p.parse_args()


def install_stubs() -> None:
    import io

    import resvg_py

    def svg2png(bytestring=None, url=None, write_to=None, output_width=None, output_height=None, **_kw):
        svg = bytestring.decode("utf-8") if isinstance(bytestring, bytes) else bytestring
        png = (resvg_py.svg_to_bytes(svg_string=svg, width=output_width, height=output_height)
               if svg is not None else resvg_py.svg_to_bytes(svg_path=url, width=output_width, height=output_height))
        png = bytes(png)
        if write_to:
            Path(write_to).write_bytes(png)
            return None
        return png

    sys.modules["cairosvg"] = types.SimpleNamespace(svg2png=svg2png)
    ipd = types.ModuleType("IPython.display")
    ipy = types.ModuleType("IPython")
    ipy.display = ipd
    sys.modules["IPython"], sys.modules["IPython.display"] = ipy, ipd
    mp = types.ModuleType("moviepy")
    mpe = types.ModuleType("moviepy.editor")
    for n in ("ImageClip", "concatenate_videoclips", "ipython_display"):
        setattr(mpe, n, None)
    mp.editor = mpe
    sys.modules["moviepy"], sys.modules["moviepy.editor"] = mp, mpe
    del io


def snapshot(repo: str, rev: str) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(repo, revision=rev)


def main() -> int:
    a = parse_args()
    # Absolute before the chdir below, or a relative --in-dir finds nothing.
    a.in_dir, a.out_dir = a.in_dir.resolve(), a.out_dir.resolve()
    a.report = a.report.resolve() if a.report else None
    install_stubs()
    sys.path.insert(0, str(SRC))
    os.chdir(SRC)  # inference.py reads ./config.yaml at import
    import torch

    if not torch.cuda.is_available():
        print("CUDA not available", file=sys.stderr)
        return 2
    import inference as inf  # the repo's own module: its globals are the loaded model
    from decoder import SketchDecoder
    from PIL import Image
    from tokenizer import SVGTokenizer
    from transformers import AutoProcessor, AutoTokenizer

    qwen = snapshot(*QWEN)
    weights = os.path.join(snapshot(*WEIGHTS), "pytorch_model.bin")
    t0 = time.perf_counter()
    # inference.load_models, with the weights loaded as data only.
    inf.tokenizer = AutoTokenizer.from_pretrained(qwen, padding_side="left", trust_remote_code=False)
    inf.processor = AutoProcessor.from_pretrained(qwen, padding_side="left", trust_remote_code=False)
    inf.processor.tokenizer.padding_side = "left"
    inf.sketch_decoder = SketchDecoder(config_path=inf.CONFIG_PATH, model_path=qwen, model_size="4B",
                                       pix_len=inf.MAX_MAX_LENGTH,
                                       text_len=inf.config.get("text", {}).get("max_length", 200),
                                       torch_dtype=inf.DTYPE)
    state = torch.load(weights, map_location="cpu", weights_only=True)
    inf.sketch_decoder.load_state_dict(state)
    del state
    inf.sketch_decoder = inf.sketch_decoder.eval()
    inf.svg_tokenizer = SVGTokenizer(inf.CONFIG_PATH, model_size="4B")
    inf.current_model_size = "4B"
    load_s = time.perf_counter() - t0
    print(f"loaded OmniSVG1.1_4B in {load_s:.1f}s; VRAM allocated {torch.cuda.memory_allocated() / 2**20:.0f} MiB",
          flush=True)

    tc = inf.TASK_CONFIGS["image-to-svg"]
    gen = dict(temperature=tc.get("default_temperature", 0.3), top_p=tc.get("default_top_p", 0.90),
               top_k=tc.get("default_top_k", 50), repetition_penalty=tc.get("default_repetition_penalty", 1.05),
               max_length=inf.MAX_LENGTH, candidates=a.candidates, buffer=inf.EXTRA_CANDIDATES_BUFFER)

    a.out_dir.mkdir(parents=True, exist_ok=True)
    jobs = [(p, a.out_dir / (p.stem + ".svg")) for p in sorted(a.in_dir.glob("*.png"))]
    rows = []
    if a.skip_existing and a.report and a.report.exists():
        try:
            rows = [r for r in json.loads(a.report.read_text(encoding="utf-8")).get("images", [])
                    if r.get("status") != "ok" or Path(r["output"]).exists()]
        except Exception:  # noqa: BLE001
            rows = []
    done = {Path(r["input"]).name for r in rows}

    def write_report():
        if not a.report:
            return
        a.report.parent.mkdir(parents=True, exist_ok=True)
        a.report.write_text(json.dumps(dict(
            model=WEIGHTS[0], revision=WEIGHTS[1], base=QWEN[0], base_revision=QWEN[1], src=OMNISVG_SRC_SHA,
            dtype=str(inf.DTYPE).replace("torch.", ""), load_seconds=round(load_s, 1),
            generation=gen | {"seed": a.seed}, gpu=torch.cuda.get_device_name(0), torch=torch.__version__,
            images=rows), indent=2), encoding="utf-8")

    for src, dst in jobs:
        if a.skip_existing and src.name in done:
            continue
        torch.manual_seed(a.seed)
        torch.cuda.reset_peak_memory_stats()
        img, _ = inf.preprocess_image_for_svg(Image.open(src), replace_background=True,
                                              target_size=inf.TARGET_IMAGE_SIZE)
        tmp = a.out_dir / f"{src.stem}.in.png"
        img.save(tmp, format="PNG")
        t = time.perf_counter()
        try:
            inputs = inf.prepare_inputs("image-to-svg", str(tmp))
            cands = inf.generate_candidates(inputs, "image-to-svg", "image", gen["temperature"], gen["top_p"],
                                            gen["top_k"], gen["repetition_penalty"], gen["max_length"],
                                            a.candidates)
            err = None
        except Exception as e:  # noqa: BLE001  -- a failure row, never a skipped case
            cands, err = [], f"{type(e).__name__}: {e}"
        torch.cuda.synchronize()
        dt = time.perf_counter() - t
        tmp.unlink(missing_ok=True)
        row = dict(input=str(src), output=str(dst), seconds=round(dt, 3),
                   peak_vram_mib=round(torch.cuda.max_memory_allocated() / 2**20),
                   peak_reserved_mib=round(torch.cuda.max_memory_reserved() / 2**20))
        if cands:
            svg = cands[0]["svg"]
            dst.write_text(svg, encoding="utf-8")
            row |= dict(status="ok", paths=cands[0]["path_count"], bytes=len(svg.encode()))
        else:
            row |= dict(status="failed", error=err or "no valid candidate")
        rows.append(row)
        write_report()
        print(json.dumps(row), flush=True)
        torch.cuda.empty_cache()

    write_report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
