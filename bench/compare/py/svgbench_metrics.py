"""SVG-Bench pixel metrics for the vectorizer comparison — one batch pass over every render.

    .bench-tools/starvector-venv/Scripts/python.exe -I bench/compare/py/svgbench_metrics.py \
        --pairs <run>/pairs.jsonl --out <run>/svgbench.jsonl

bench/compare/run.ts writes pairs.jsonl: one line per (tool, case) with the ground-truth
render and the trace render — both resvg, on white, the same w×h — plus both SVG paths.
This script computes what StarVector's SVG-Bench reports, replicating the released code
(github.com/joanrod/star-vector, starvector/metrics/*.py) rather than the paper's prose:

  mse    F.mse_loss on ToTensor RGB in [0,1]                          (compute_l2.py)
  ssim   skimage structural_similarity(win_size=11, channel_axis=-1, sigma=1.5) on uint8
         RGB — gaussian_weights is NOT set there, so it is a uniform 11×11 window and
         sigma is inert; replicated as-is                              (compute_SSIM.py)
  lpips  lpips.LPIPS(net='vgg') on ImageNet mean/std-normalised tensors — not the [-1,1]
         input LPIPS expects; replicated as-is for comparability     (compute_LPIPS.py)
  dino   facebook/dinov2-base, last_hidden_state.mean(1) (CLS included), (cos + 1) / 2
                                                                     (compute_dino_score.py)
  tokens len(AutoTokenizer('bigcode/starcoder2-7b').encode(svg))      (count_token_length.py)

Two deliberate differences, stated so nobody reads them as the paper's numbers: the renders
are resvg (the corpus ground truth is resvg everywhere in LogoLab), not cairosvg, and they
keep the art's aspect ratio instead of being stretched to 512×512 (every v0 case is square).
A metric whose model cannot be loaded is written as null with the reason, never dropped.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / ".bench-tools"
os.environ.setdefault("HF_HUB_CACHE", str(TOOLS / "hf-cache"))
os.environ.setdefault("TORCH_HOME", str(TOOLS / "torch-home"))  # lpips' VGG weights
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# Pinned model revisions (the metric models must not float between runs).
DINO_REV = "f9e44c814b77203eaa57a6bdbbd535f21ede1415"  # facebook/dinov2-base
TOK_REV = "bb9afde76d7945da5745592525db122d4d729eb1"  # bigcode/starcoder2-7b (tokenizer only)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--no-lpips", action="store_true")
    p.add_argument("--no-dino", action="store_true")
    p.add_argument("--no-tokens", action="store_true")
    a = p.parse_args()

    import numpy as np
    import torch
    import torch.nn.functional as F
    from PIL import Image
    from skimage.metrics import structural_similarity
    from torchvision.transforms import Normalize, ToTensor

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    pairs = [json.loads(l) for l in a.pairs.read_text(encoding="utf-8").splitlines() if l.strip()]
    print(f"{len(pairs)} pairs on {dev}", flush=True)
    notes: dict[str, str] = {}

    def rgb(path: str):
        img = Image.open(path)
        if img.mode != "RGB":
            img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[3])
            img = bg
        return img

    to_t = ToTensor()
    norm = Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])

    lp = None
    if not a.no_lpips:
        try:
            import lpips
            lp = lpips.LPIPS(net="vgg", verbose=False).to(dev).eval()
        except Exception as e:  # noqa: BLE001
            notes["lpips"] = f"unavailable: {e}"
    dino = proc = None
    if not a.no_dino:
        try:
            from transformers import AutoImageProcessor, AutoModel
            dino = AutoModel.from_pretrained("facebook/dinov2-base", revision=DINO_REV).to(dev).eval()
            proc = AutoImageProcessor.from_pretrained("facebook/dinov2-base", revision=DINO_REV)
        except Exception as e:  # noqa: BLE001
            notes["dino"] = f"unavailable: {e}"
    tok = None
    if not a.no_tokens:
        try:
            from transformers import AutoTokenizer
            tok = AutoTokenizer.from_pretrained("bigcode/starcoder2-7b", revision=TOK_REV)
        except Exception as e:  # noqa: BLE001
            notes["tokens"] = f"unavailable: {e}"
    for k, v in notes.items():
        print(f"  {k}: {v}", file=sys.stderr)

    out = []
    with torch.inference_mode():
        for i, pr in enumerate(pairs):
            row = dict(key=pr["key"], mse=None, ssim=None, lpips=None, dino=None,
                       tokens=None, gtTokens=None, error=None)
            try:
                gt, gen = rgb(pr["gt_png"]), rgb(pr["gen_png"])
                if gt.size != gen.size:
                    gen = gen.resize(gt.size, Image.BILINEAR)
                tg, tr = to_t(gt), to_t(gen)
                row["mse"] = F.mse_loss(tg, tr).item()
                row["ssim"] = float(structural_similarity(
                    np.array(gt), np.array(gen), win_size=11, channel_axis=-1, sigma=1.5))
                if lp is not None:
                    row["lpips"] = lp(norm(tg)[None].to(dev), norm(tr)[None].to(dev)).item()
                if dino is not None:
                    fg = dino(**proc(images=gt, return_tensors="pt").to(dev)).last_hidden_state.mean(1)
                    fr = dino(**proc(images=gen, return_tensors="pt").to(dev)).last_hidden_state.mean(1)
                    row["dino"] = (F.cosine_similarity(fg, fr, dim=1).item() + 1) / 2
                if tok is not None:
                    if pr.get("gen_svg"):
                        row["tokens"] = len(tok.encode(Path(pr["gen_svg"]).read_text(encoding="utf-8")))
                    if pr.get("gt_svg"):
                        row["gtTokens"] = len(tok.encode(Path(pr["gt_svg"]).read_text(encoding="utf-8")))
            except Exception as e:  # noqa: BLE001
                row["error"] = f"{type(e).__name__}: {e}"
            out.append(row)
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(pairs)}", flush=True)

    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("w", encoding="utf-8") as f:
        f.write(json.dumps(dict(meta=dict(device=dev, notes=notes, torch=torch.__version__,
                                          dinoRevision=DINO_REV, tokenizerRevision=TOK_REV))) + "\n")
        for r in out:
            f.write(json.dumps(r) + "\n")
    print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
