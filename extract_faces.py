import json
import os
import sys

import cv2
from insightface.app import FaceAnalysis


def main():
    app = FaceAnalysis(
        name=os.environ.get("FACE_MODEL", "buffalo_l"),
        providers=["CPUExecutionProvider"],
    )
    app.prepare(ctx_id=-1, det_size=(640, 640))

    for line in sys.stdin:
        try:
            request = json.loads(line)
            image = cv2.imread(request["file_path"])
            if image is None:
                raise ValueError("OpenCV could not read the image")

            faces = []
            for face in app.get(image):
                embedding = getattr(face, "normed_embedding", None)
                if embedding is None:
                    continue
                faces.append({
                    "embedding": embedding.astype("float32").tolist(),
                    "bbox": [round(float(value), 2) for value in face.bbox],
                    "score": round(float(face.det_score), 5),
                })
            print(json.dumps({"id": request["id"], "faces": faces}), flush=True)
        except Exception as error:
            print(json.dumps({"id": request.get("id"), "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
