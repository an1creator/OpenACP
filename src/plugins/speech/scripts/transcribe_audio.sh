#!/usr/bin/env bash
set -euo pipefail

# Keep the former wrapper cache as the fallback so existing model downloads and
# virtual environments are reused after migration to the native provider.
CACHE_ROOT="${OPENACP_LOCAL_WHISPER_CACHE:-${CODEX_TRANSCRIBE_VOICE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/codex/transcribe-voice}}"
VENV_DIR="$CACHE_ROOT/venv"
PYTHON="$VENV_DIR/bin/python"
PACKAGE_MARKER="$CACHE_ROOT/.faster-whisper-1.2"

usage() {
  cat >&2 <<'EOF'
Usage: transcribe_audio.sh [options] <audio-file>

Options:
  --model NAME          faster-whisper model name (default: base)
  --language CODE       Whisper language code, for example ru or en (default: ru)
  --beam-size N         Beam size for decoding (default: 5)
  --vad-filter          Enable VAD filtering
  --no-vad-filter       Disable VAD filtering (default)
  --segments            Print timestamped segments instead of one plain transcript
  --device NAME         Device for faster-whisper (default: cpu)
  --compute-type NAME   Compute type (default: int8)
  --quiet               Suppress metadata on stderr
EOF
}

ensure_env() {
  mkdir -p "$CACHE_ROOT"
  if [[ ! -x "$PYTHON" ]]; then
    if command -v uv >/dev/null 2>&1; then
      uv venv "$VENV_DIR" >&2
    else
      local python_bin="${PYTHON_BIN:-python3}"
      "$python_bin" -m venv "$VENV_DIR" >&2 || {
        echo "Could not create a Python virtual environment. Install uv or python3-venv." >&2
        exit 2
      }
    fi
    rm -f "$PACKAGE_MARKER"
  fi

  if [[ ! -f "$PACKAGE_MARKER" ]]; then
    if command -v uv >/dev/null 2>&1; then
      uv pip install --python "$PYTHON" 'faster-whisper>=1.2,<2' >&2
    else
      "$PYTHON" -m pip install 'faster-whisper>=1.2,<2' >&2 || {
        echo "Could not install faster-whisper. Install uv or ensure pip is available in the venv." >&2
        exit 2
      }
    fi
    touch "$PACKAGE_MARKER"
  fi
}

if [[ $# -eq 0 ]]; then
  usage
  exit 2
fi

ensure_env

"$PYTHON" - "$@" <<'PY'
import argparse
import os
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe an audio file with faster-whisper.")
    parser.add_argument("audio_file", help="Path to the audio file to transcribe")
    parser.add_argument("--model", default=os.environ.get("OPENACP_LOCAL_WHISPER_MODEL", "base"))
    parser.add_argument("--language", default=os.environ.get("OPENACP_LOCAL_WHISPER_LANGUAGE", "ru"))
    parser.add_argument("--beam-size", type=int, default=int(os.environ.get("OPENACP_LOCAL_WHISPER_BEAM_SIZE", "5")))
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true", default=False)
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false")
    parser.add_argument("--segments", action="store_true", help="Print timestamped segments")
    parser.add_argument("--device", default=os.environ.get("OPENACP_LOCAL_WHISPER_DEVICE", "cpu"))
    parser.add_argument("--compute-type", default=os.environ.get("OPENACP_LOCAL_WHISPER_COMPUTE_TYPE", "int8"))
    parser.add_argument("--quiet", action="store_true", help="Suppress metadata on stderr")
    args = parser.parse_args()

    audio_path = Path(args.audio_file).expanduser()
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=args.language,
        beam_size=args.beam_size,
        vad_filter=args.vad_filter,
    )
    segments = list(segments_iter)

    if not args.quiet:
        probability = getattr(info, "language_probability", None)
        probability_text = f"{probability:.3f}" if probability is not None else "unknown"
        print(
            f"model={args.model} language={info.language} "
            f"language_probability={probability_text} duration={info.duration:.3f}s",
            file=sys.stderr,
        )

    if args.segments:
        for segment in segments:
            print(f"[{segment.start:.2f}-{segment.end:.2f}] {segment.text.strip()}")
    else:
        print(" ".join(segment.text.strip() for segment in segments).strip())
    return 0


raise SystemExit(main())
PY
