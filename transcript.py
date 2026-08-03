#!/usr/bin/env python3
import json
import sys


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Video ID is required"}))
        return 1

    video_id = sys.argv[1]
    try:
        from youtube_transcript_api import YouTubeTranscriptApi

        languages = ["en", "en-GB", "en-US"]
        try:
            api = YouTubeTranscriptApi()
            transcript = api.fetch(video_id, languages=languages)
            snippets = transcript.to_raw_data() if hasattr(transcript, "to_raw_data") else transcript
            language = getattr(transcript, "language_code", "en")
            generated = bool(getattr(transcript, "is_generated", False))
        except AttributeError:
            snippets = YouTubeTranscriptApi.get_transcript(video_id, languages=languages)
            language = "en"
            generated = False

        text = " ".join(
            str(item.get("text", "")).replace("\n", " ").strip()
            for item in snippets
            if item.get("text")
        )
        text = " ".join(text.split())
        if len(text) < 80:
            raise RuntimeError("The available transcript was empty or too short")

        print(json.dumps({
            "data": {
                "text": text,
                "language": language,
                "generated": generated,
            }
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
