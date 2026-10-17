#!/usr/bin/env bash
# Rebuild .bench-tools/ for the vectorizer comparison (bench/compare/run.ts), every input pinned.
#
#   bash bench/compare/py/setup.sh            # from the repo root, Git Bash on Windows or any POSIX sh
#
# Idempotent: a step whose output exists is skipped. Downloads go into their own empty
# directories and are hash-checked before anything reads them. Nothing here is committed;
# .bench-tools/ is gitignored. Needs: git, curl, unzip, sha256sum, cargo, Python 3.12 (`py -3.12`
# on Windows, `python3.12` elsewhere), an NVIDIA GPU + CUDA 12.4 driver for StarVector.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
T="$REPO/.bench-tools"
mkdir -p "$T"

# ── pins ────────────────────────────────────────────────────────────────────────────────────
VTRACER_VERSION=0.6.4
POTRACE_URL=https://potrace.sourceforge.net/download/1.16/potrace-1.16.win64.zip
POTRACE_SHA256=63699f9885b5ed053977fd94452a7bdbb77ee62b77bf28a3f17b2f14b9b9c65d
STARVECTOR_GIT=https://github.com/joanrod/star-vector.git
STARVECTOR_SHA=0e083c1911760aa31bc576ca7f337a7f8ee605ec
STARVECTOR_MODEL=starvector/starvector-1b-im2svg
STARVECTOR_REV=380ab95d25a8e9ab1dc825debe238b4953ae13b9
DINO_REV=f9e44c814b77203eaa57a6bdbbd535f21ede1415          # facebook/dinov2-base
STARCODER2_REV=bb9afde76d7945da5745592525db122d4d729eb1    # bigcode/starcoder2-7b (tokenizer)
SHIM_CONFIG_REPO=Xenova/starcoderbase-1b                    # ungated copy of bigcode/starcoderbase-1b's config
SHIM_CONFIG_REV=c1d88f6743334a1200e4948ef46f545acfa96568
SHIM_CONFIG_SHA256=0306bb2e5f2d0b490e0a16dd9b10bcad29ee4496634e2da74f8e62492da00819

check() { # file sha256
  local got
  got=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$got" = "$2" ] || { echo "sha256 mismatch for $1: $got != $2" >&2; exit 1; }
}

# ── VTracer (crates.io, locked) ─────────────────────────────────────────────────────────────
if [ ! -x "$T/vtracer/bin/vtracer" ] && [ ! -x "$T/vtracer/bin/vtracer.exe" ]; then
  cargo install vtracer --version "$VTRACER_VERSION" --locked --root "$T/vtracer"
fi

# ── Potrace (Windows build; on Linux/macOS install potrace 1.16 and edit POTRACE in adapters/external.ts)
if [ ! -d "$T/potrace/potrace-1.16.win64" ]; then
  mkdir -p "$T/potrace/dl"
  [ -f "$T/potrace/dl/potrace-1.16.win64.zip" ] || curl -fL -o "$T/potrace/dl/potrace-1.16.win64.zip" "$POTRACE_URL"
  check "$T/potrace/dl/potrace-1.16.win64.zip" "$POTRACE_SHA256"
  unzip -q "$T/potrace/dl/potrace-1.16.win64.zip" -d "$T/potrace"
fi

# ── StarVector source + venv (requirements.lock is `pip freeze` of the venv the run used) ────
if [ ! -d "$T/star-vector-src/.git" ]; then
  git clone "$STARVECTOR_GIT" "$T/star-vector-src"
fi
git -C "$T/star-vector-src" checkout --quiet "$STARVECTOR_SHA"

if [ ! -d "$T/starvector-venv" ]; then
  if command -v py >/dev/null 2>&1; then py -3.12 -m venv "$T/starvector-venv"; else python3.12 -m venv "$T/starvector-venv"; fi
fi
VPY="$T/starvector-venv/Scripts/python.exe"
[ -x "$VPY" ] || VPY="$T/starvector-venv/bin/python"
"$VPY" -m pip install --quiet --upgrade pip
# torch/torchvision come from the CUDA 12.4 index; the editable starvector line points at the checkout.
grep -v '^-e ' "$REPO/bench/compare/py/requirements.lock" > "$T/requirements.nostarvector.txt"
"$VPY" -m pip install --quiet --extra-index-url https://download.pytorch.org/whl/cu124 -r "$T/requirements.nostarvector.txt"
"$VPY" -m pip install --quiet --no-deps -e "$T/star-vector-src"

# ── Hugging Face snapshots, at pinned revisions, into .bench-tools/hf-cache ─────────────────
export HF_HUB_CACHE="$T/hf-cache" HF_HUB_DISABLE_TELEMETRY=1
"$VPY" -I - <<PY
from huggingface_hub import snapshot_download, hf_hub_download
snapshot_download("$STARVECTOR_MODEL", revision="$STARVECTOR_REV")
snapshot_download("facebook/dinov2-base", revision="$DINO_REV")
for f in ["tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt", "special_tokens_map.json", "config.json"]:
    try:
        hf_hub_download("bigcode/starcoder2-7b", f, revision="$STARCODER2_REV")
    except Exception as e:
        print("starcoder2-7b", f, e)
PY

# ── the starcoderbase-1b shim: ungated config + StarVector's OWN tokenizer files ───────────
# (starvector_run.py --base shim; the LLM's weights come from the StarVector checkpoint).
SHIM="$T/starcoderbase-1b-shim"
if [ ! -f "$SHIM/config.json" ]; then
  mkdir -p "$SHIM"
  curl -fL -o "$SHIM/config.json" "https://huggingface.co/$SHIM_CONFIG_REPO/resolve/$SHIM_CONFIG_REV/config.json"
  SNAP="$T/hf-cache/models--starvector--starvector-1b-im2svg/snapshots/$STARVECTOR_REV"
  for f in added_tokens.json merges.txt special_tokens_map.json tokenizer_config.json vocab.json; do
    cp "$SNAP/$f" "$SHIM/$f"
  done
fi
check "$SHIM/config.json" "$SHIM_CONFIG_SHA256"

# ── LPIPS' VGG weights land in .bench-tools/torch-home on first use (svgbench_metrics.py).

# ── the held-out corpus (pinned revision, parquet sha256 checked, rows sha256-checked by corpus.ts)
"$VPY" -I "$REPO/bench/compare/py/fetch_svgbench.py"

echo "ready: node --experimental-strip-types bench/compare/run.ts --run <name>"
