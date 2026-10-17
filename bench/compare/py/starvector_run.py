"""StarVector image -> SVG runner for the LogoLab vectorizer benchmark.

Run with the venv's interpreter, isolated (-I) so nothing is imported from the cwd:

  .bench-tools/starvector-venv/Scripts/python.exe -I bench/compare/py/starvector_run.py \
      --in icon.png --out icon.svg
  .bench-tools/starvector-venv/Scripts/python.exe -I bench/compare/py/starvector_run.py \
      --in-dir pngs/ --out-dir svgs/ --report svgs/report.json

Generation defaults are the repo's own SVG-Bench eval config for the 1B HF model
(configs/generation/hf/starvector-1b/im2svg.yaml: max_length 7800, min_length 10,
num_beams 1, nucleus sampling, temperature 0.2, top_p 0.95), plus a fixed seed so a
run is reproducible. --greedy switches sampling off.

Two Windows-specific deviations from the reference code, both explicit here:

* The 1B model builds its LLM by calling from_pretrained("bigcode/starcoderbase-1b"),
  a GATED repo. Its weights are thrown away (the StarVector checkpoint carries the whole
  LLM), only the GPTBigCode config and tokenizer are used. --base shim (the default
  when the gated repo is not accessible) points that at a local directory holding the
  same config (ungated mirror Xenova/starcoderbase-1b) and the StarVector repo's own
  tokenizer files, and builds the LLM from config instead of downloading 4 GB to discard
  them. --base hub uses the real repo (accept its licence on huggingface.co first).
* starvector.data.util.clean_svg uses signal.SIGALRM, which does not exist on Windows,
  so every SVG it would have repaired falls through to the placeholder. clean_svg_win
  below is the same repair with a thread timeout instead.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path

# Weights, remote code and the config shim live in the gitignored .bench-tools/ at the
# repo root; this script is vendored into bench/compare/py/ so the benchmark is reproducible.
HERE = Path(__file__).resolve().parents[3] / ".bench-tools"
os.environ.setdefault("HF_HUB_CACHE", str(HERE / "hf-cache"))
os.environ.setdefault("HF_MODULES_CACHE", str(HERE / "hf-modules"))  # trust_remote_code copies
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
SHIM_DIR = HERE / "starcoderbase-1b-shim"
GATED_BASE = "bigcode/starcoderbase-1b"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--in", dest="inp", type=Path, help="one input PNG")
    src.add_argument("--in-dir", type=Path, help="directory of input PNGs (model loaded once)")
    p.add_argument("--out", type=Path, help="output SVG (with --in)")
    p.add_argument("--out-dir", type=Path, help="output directory (with --in-dir)")
    p.add_argument("--model", default="starvector/starvector-1b-im2svg")
    # Pinned: weights AND the trust_remote_code modelling files come from this commit.
    p.add_argument("--revision", default="380ab95d25a8e9ab1dc825debe238b4953ae13b9")
    p.add_argument("--base", choices=["auto", "hub", "shim"], default="auto",
                   help="where the StarCoder config/tokenizer comes from (1B model only)")
    p.add_argument("--dtype", choices=["float16", "bfloat16", "float32"], default="float16")
    p.add_argument("--max-length", type=int, default=7800)
    p.add_argument("--min-length", type=int, default=10)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--top-p", type=float, default=0.95)
    p.add_argument("--num-beams", type=int, default=1)
    p.add_argument("--greedy", action="store_true", help="deterministic decoding (no sampling)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--keep-raw", action="store_true", help="also write <name>.raw.svg (the model's text)")
    p.add_argument("--report", type=Path, help="JSON report (per image: time, tokens, VRAM, status)")
    p.add_argument("--skip-existing", action="store_true")
    a = p.parse_args()
    if a.inp and not a.out:
        p.error("--in needs --out")
    if a.in_dir and not a.out_dir:
        p.error("--in-dir needs --out-dir")
    return a


def base_accessible() -> bool:
    try:
        from huggingface_hub import hf_hub_download
        hf_hub_download(GATED_BASE, "config.json")
        return True
    except Exception:
        return False


def install_shim() -> None:
    """Build the StarCoder LLM from the local config instead of the gated hub weights."""
    import starvector.model.llm.starcoder as sc
    real = sc.AutoModelForCausalLM

    class _FromConfig:
        @staticmethod
        def from_pretrained(name, config=None, torch_dtype=None, trust_remote_code=True, **kw):
            if Path(str(name)).resolve() != SHIM_DIR.resolve():
                return real.from_pretrained(name, config=config, torch_dtype=torch_dtype,
                                            trust_remote_code=trust_remote_code, **kw)
            return real.from_config(config, torch_dtype=torch_dtype, trust_remote_code=trust_remote_code)

    sc.AutoModelForCausalLM = _FromConfig


def clean_svg_win(svg_text: str, timeout: float = 5.0) -> str:
    """starvector.data.util.clean_svg without SIGALRM."""
    import cairosvg
    from bs4 import BeautifulSoup
    pretty = BeautifulSoup(svg_text, "xml").prettify()
    box: dict = {}

    def work():
        try:
            box["svg"] = cairosvg.svg2svg(pretty).decode()
        except Exception as e:  # noqa: BLE001
            box["err"] = e

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError("svg2svg timed out")
    if "err" in box:
        raise box["err"]
    return "\n".join(l for l in box["svg"].split("\n") if not l.strip().startswith("<?xml"))


def load_on_white(path: Path):
    """Composite over white, as the TRAINING processor does (_rgba_to_rgb_white).

    The HF processor's img.convert("RGB") just drops alpha, so art on transparency
    reaches the model as whatever RGB sits under alpha 0 (often black).
    """
    from PIL import Image
    img = Image.open(path)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        return bg
    return img.convert("RGB")


def postprocess(raw: str) -> tuple[str, str]:
    """process_and_rasterize_svg's choice of SVG: raw if it parses, else repaired, else placeholder."""
    from svgpathtools import svgstr2paths
    from starvector.data.util import use_placeholder
    try:
        svgstr2paths(raw)
        return raw, "valid"
    except Exception:
        pass
    try:
        svg = clean_svg_win(raw)
        svgstr2paths(svg)
        return svg, "cleaned"
    except Exception:
        return use_placeholder(), "placeholder"


def main() -> int:
    a = parse_args()
    import torch
    from PIL import Image
    from transformers import AutoModelForCausalLM

    if not torch.cuda.is_available():
        print("CUDA not available", file=sys.stderr)
        return 2

    load_kw = {}
    base = "n/a"
    if "8b" not in a.model:
        base = a.base
        if base == "auto":
            base = "hub" if base_accessible() else "shim"
        if base == "shim":
            install_shim()
            load_kw["starcoder_model_name"] = str(SHIM_DIR)

    dtype = getattr(torch, a.dtype)
    t0 = time.perf_counter()
    model = AutoModelForCausalLM.from_pretrained(a.model, revision=a.revision, torch_dtype=dtype,
                                                 trust_remote_code=True, code_revision=a.revision, **load_kw)
    model.cuda().eval()
    load_s = time.perf_counter() - t0
    processor = model.model.processor
    tokenizer = model.model.svg_transformer.tokenizer
    print(f"loaded {a.model} (base={base}, {a.dtype}) in {load_s:.1f}s; "
          f"VRAM allocated {torch.cuda.memory_allocated() / 2**20:.0f} MiB", flush=True)

    if a.inp:
        jobs = [(a.inp, a.out)]
    else:
        a.out_dir.mkdir(parents=True, exist_ok=True)
        jobs = [(p, a.out_dir / (p.stem + ".svg")) for p in sorted(a.in_dir.glob("*.png"))]

    gen = dict(max_length=a.max_length, min_length=a.min_length, num_beams=a.num_beams,
               use_nucleus_sampling=not a.greedy, temperature=a.temperature, top_p=a.top_p)
    # Resumable: the report is rewritten after EVERY image, and with --skip-existing an image
    # already in the report (and on disk) is kept, not regenerated. A batch that dies part-way
    # (a stall, a sleep, a killed shell) then loses only the image it was on.
    rows = []
    if a.skip_existing and a.report and a.report.exists():
        try:
            rows = [r for r in json.loads(a.report.read_text(encoding="utf-8")).get("images", [])
                    if Path(r["output"]).exists()]
        except Exception:  # noqa: BLE001
            rows = []
    done = {Path(r["input"]).name for r in rows}

    def write_report():
        if not a.report:
            return
        a.report.parent.mkdir(parents=True, exist_ok=True)
        a.report.write_text(json.dumps(dict(
            model=a.model, revision=a.revision, base=base, dtype=a.dtype, load_seconds=round(load_s, 1),
            generation=gen | {"seed": a.seed}, gpu=torch.cuda.get_device_name(0),
            torch=torch.__version__, images=rows), indent=2), encoding="utf-8")

    for src, dst in jobs:
        if a.skip_existing and src.name in done and dst.exists():
            continue
        torch.manual_seed(a.seed)
        torch.cuda.reset_peak_memory_stats()
        img = load_on_white(src)
        pix = processor(img, return_tensors="pt")["pixel_values"]
        if pix.dim() == 3:  # the card's squeeze(0) leaves [3,H,W]; the encoder needs [B,3,H,W]
            pix = pix.unsqueeze(0)
        pix = pix.cuda()
        torch.cuda.synchronize()
        t = time.perf_counter()
        with torch.inference_mode():
            raw = model.generate_im2svg({"image": pix}, **gen)[0]
        torch.cuda.synchronize()
        dt = time.perf_counter() - t
        n_tok = len(tokenizer(raw, add_special_tokens=False)["input_ids"])
        svg, status = postprocess(raw)
        truncated = "</svg>" not in raw
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(svg, encoding="utf-8")
        if a.keep_raw:
            dst.with_suffix(".raw.svg").write_text(raw, encoding="utf-8")
        row = dict(input=str(src), output=str(dst), seconds=round(dt, 3), tokens=n_tok,
                   tokens_per_s=round(n_tok / dt, 1), bytes=len(svg.encode()), status=status,
                   truncated=truncated,
                   peak_vram_mib=round(torch.cuda.max_memory_allocated() / 2**20),
                   peak_reserved_mib=round(torch.cuda.max_memory_reserved() / 2**20))
        rows.append(row)
        write_report()
        print(json.dumps(row), flush=True)

    write_report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
