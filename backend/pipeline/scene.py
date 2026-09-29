"""
Scene classification — SigLIP 2 zero-shot, batched, on MPS.

Labels every processable photo, not just the no-face ones: a photo whose only
faces are low-quality or dismissed is filed under Places/{label}, and a label on
every photo is what "Places for everyone" will need later.

Runs in-process: the old FAISS/PyTorch libomp conflict is gone now that face
matching uses plain numpy (see pipeline/classify.py), so no subprocess needed.
"""
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

import torch
from PIL import Image, ImageOps
import pillow_heif

from database import crud
from database.models import Photo

pillow_heif.register_heif_opener()

MODEL_NAME = "ViT-B-16-SigLIP2"
PRETRAINED = "webli"
BATCH_SIZE = 16
DECODE_WORKERS = 4

# Softmax confidence floor — below this the model isn't sure, label as "other"
# instead of forcing a wrong bucket.
MIN_CONFIDENCE = 0.30

# "other" is assigned via the confidence floor, never predicted directly —
# "a photo of other" is a meaningless prompt.
LABEL_PROMPTS: dict[str, list[str]] = {
    "beach":    ["a photo of a beach", "a photo taken at the seaside", "a photo of the ocean shore"],
    "mountain": ["a photo of mountains", "a mountain landscape photo", "a photo taken in the hills"],
    "temple":   ["a photo of a temple", "a photo of a shrine", "a photo of a place of worship"],
    "monument": ["a photo of a monument", "a photo of a historic landmark", "a photo of an old fort or palace"],
    "street":   ["a photo of a city street", "a street photography shot", "a photo of buildings along a road"],
    "market":   ["a photo of a market", "a photo of a street market or bazaar", "a photo of shops and stalls"],
    "nature":   ["a photo of nature", "a photo of a forest or countryside", "a photo of a lake or river landscape"],
    "indoor":   ["an indoor photo", "a photo taken inside a building", "a photo of a room interior"],
    "food":     ["a photo of food", "a close-up photo of a meal", "a photo of dishes on a table"],
}
SCENE_LABELS = list(LABEL_PROMPTS.keys())
FALLBACK_LABEL = "other"

_model = None
_lock = threading.Lock()


def _device() -> str:
    return "mps" if torch.backends.mps.is_available() else "cpu"


def get_encoder():
    """Lazy singleton: (model, preprocess, per-label text features)."""
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                import open_clip

                device = _device()
                model, _, preprocess = open_clip.create_model_and_transforms(
                    MODEL_NAME, pretrained=PRETRAINED
                )
                model = model.eval().to(device)
                tokenizer = open_clip.get_tokenizer(MODEL_NAME)

                # Prompt ensemble: encode all prompts, average per label, renormalize
                all_prompts = [p for prompts in LABEL_PROMPTS.values() for p in prompts]
                with torch.no_grad():
                    feats = model.encode_text(tokenizer(all_prompts).to(device))
                    feats = feats / feats.norm(dim=-1, keepdim=True)
                label_feats = []
                i = 0
                for prompts in LABEL_PROMPTS.values():
                    avg = feats[i:i + len(prompts)].mean(dim=0)
                    label_feats.append(avg / avg.norm())
                    i += len(prompts)
                text_feats = torch.stack(label_feats)  # (num_labels, dim)

                _model = (model, preprocess, text_feats, device)
    return _model


def classify_scenes(
    session,
    trip_id: str,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    only_missing: bool = True,
) -> int:
    """
    Zero-shot scene-label the trip's photos (RAW, video and duplicates excluded).

    only_missing (default) skips photos that already carry a label, so re-running
    classification neither redoes work nor overwrites labels the user corrected
    in the gallery. Returns the number of photos labeled. Commits per batch.
    """
    query = session.query(Photo).filter(crud.processable_photo_filter(trip_id))
    if only_missing:
        query = query.filter(Photo.scene_label.is_(None))
    photos = query.all()
    if not photos:
        return 0

    model, preprocess, text_feats, device = get_encoder()
    total = len(photos)
    labeled = 0

    # Snapshot paths before the loop — the per-batch commit expires ORM
    # attributes, and decode threads must never trigger a lazy reload on the
    # shared (non-thread-safe) session.
    paths = {p.id: p.local_path for p in photos}

    def load(path: Optional[str]) -> Optional[torch.Tensor]:
        try:
            if path and Path(path).exists():
                img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
                return preprocess(img)
        except Exception:
            pass
        return None

    with ThreadPoolExecutor(max_workers=DECODE_WORKERS) as pool:
        for start in range(0, total, BATCH_SIZE):
            batch = photos[start:start + BATCH_SIZE]
            tensors = list(pool.map(load, [paths[p.id] for p in batch]))

            valid = [(p, t) for p, t in zip(batch, tensors) if t is not None]
            for photo, t in zip(batch, tensors):
                if t is None:
                    photo.scene_label = FALLBACK_LABEL

            if valid:
                stack = torch.stack([t for _, t in valid]).to(device)
                with torch.no_grad():
                    img_feats = model.encode_image(stack)
                    img_feats = img_feats / img_feats.norm(dim=-1, keepdim=True)
                    # CLIP-convention sharpening for an argmax + confidence floor
                    probs = (100.0 * img_feats @ text_feats.T).softmax(dim=-1).cpu()

                for (photo, _), p in zip(valid, probs):
                    conf, idx = float(p.max()), int(p.argmax())
                    photo.scene_label = SCENE_LABELS[idx] if conf >= MIN_CONFIDENCE else FALLBACK_LABEL

            labeled += len(batch)
            session.commit()
            if progress_cb:
                progress_cb(labeled, total)

    return labeled
