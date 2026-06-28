from pathlib import Path
import shutil

from huggingface_hub import hf_hub_download


ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / ".hf-cache"
TARGET_DIR = ROOT / "resources" / "comfyui-runtime" / "models" / "diffbir"

FILES = [
    {
        "repo_id": "lxq007/DiffBIR-v2",
        "filename": "v2.pth",
        "target": "v2.pth",
    },
    {
        "repo_id": "Manojb/stable-diffusion-2-1-base",
        "filename": "v2-1_512-ema-pruned.ckpt",
        "target": "v2-1_512-ema-pruned.ckpt",
    },
]


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    for item in FILES:
        print(f"Downloading {item['repo_id']}::{item['filename']}", flush=True)
        downloaded = Path(
            hf_hub_download(
                repo_id=item["repo_id"],
                filename=item["filename"],
                cache_dir=CACHE_DIR,
                resume_download=True,
            )
        )
        target = TARGET_DIR / item["target"]
        if target.exists():
            target.unlink()
        shutil.copy2(downloaded, target)
        print(f"Saved {target} ({target.stat().st_size} bytes)", flush=True)


if __name__ == "__main__":
    main()
