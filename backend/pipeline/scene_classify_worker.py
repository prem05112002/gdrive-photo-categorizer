"""
Subprocess worker for scene classification.
Must be run as a standalone process — never imported into the main uvicorn process.
Reason: FAISS and PyTorch both ship libomp.dylib; loading both in the same process
causes a SIGSEGV in OMP thread management on macOS ARM64.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import torch
import open_clip
from PIL import Image

from database.models import SessionLocal, Photo

SCENE_LABELS = [
    "beach", "mountain", "temple", "monument", "street",
    "market", "nature", "indoor", "food", "other",
]


def main(trip_id: str) -> None:
    session = SessionLocal()
    try:
        no_face = (
            session.query(Photo)
            .filter(
                Photo.trip_id == trip_id,
                Photo.face_count == 0,
                Photo.is_raw == False,
                Photo.is_video == False,
                Photo.is_duplicate == False,
            )
            .all()
        )

        if not no_face:
            print(json.dumps({"labeled": 0}), flush=True)
            return

        model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
        model = model.eval()
        tokenizer = open_clip.get_tokenizer("ViT-B-32")

        text_tokens = tokenizer([f"a photo of {lbl}" for lbl in SCENE_LABELS])
        with torch.no_grad():
            text_feats = model.encode_text(text_tokens)
            text_feats /= text_feats.norm(dim=-1, keepdim=True)

        labeled = 0
        for i, photo in enumerate(no_face):
            print(json.dumps({"progress": i, "total": len(no_face)}), flush=True)
            try:
                if photo.local_path and Path(photo.local_path).exists():
                    img = Image.open(photo.local_path).convert("RGB")
                    img_t = preprocess(img).unsqueeze(0)
                    with torch.no_grad():
                        img_feat = model.encode_image(img_t)
                        img_feat /= img_feat.norm(dim=-1, keepdim=True)
                        probs = (img_feat @ text_feats.T).softmax(dim=-1)[0]
                        photo.scene_label = SCENE_LABELS[int(probs.argmax())]
                else:
                    photo.scene_label = "other"
            except Exception:
                photo.scene_label = "other"
            labeled += 1

        session.commit()
        print(json.dumps({"labeled": labeled}), flush=True)

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(json.dumps({"error": str(e)}), file=sys.stderr, flush=True)
        sys.exit(1)
    finally:
        session.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: scene_classify_worker.py <trip_id>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
