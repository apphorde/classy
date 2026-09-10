import sys
import os
import json
import eyed3

def extract_audio(file_path):
    result = {"title": None, "artist": None, "album": None, "genre": None, "year": None}
    try:
        # Lower log level to avoid spamming stderr
        eyed3.log.setLevel("ERROR")
        audiofile = eyed3.load(file_path)
        if audiofile and audiofile.tag:
            tag = audiofile.tag
            result["title"] = tag.title
            result["artist"] = tag.artist
            result["album"] = tag.album
            result["genre"] = tag.genre.name if tag.genre else None
            if tag.recording_date:
                result["year"] = str(tag.recording_date.year)
    except:
        pass

    # Fallback structure: If audio metadata doesn't exist, extract parent folders
    if not result["artist"] or not result["album"]:
        path_parts = os.path.normpath(file_path).split(os.sep)
        if len(path_parts) >= 3:
            result["album"] = path_parts[-2]
            result["artist"] = path_parts[-3]
        elif len(path_parts) == 2:
            result["album"] = path_parts[-2]

    print(json.dumps(result))

if __name__ == "__main__":
    if len(sys.argv) > 1:
        extract_audio(sys.argv[1])
