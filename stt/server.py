"""Speech-to-text for Desktop Agent.

Loads a model ONCE and answers POST /transcribe. Two backends behind one
interface, chosen per request or by config:

  local   faster-whisper (CTranslate2, int8). On a 2016 i7 this decodes a 5s
          clip with small.en in ~2.0s, against ~13s for whisper.cpp on the
          same machine's iGPU -- the runtime matters far more than the model.
  remote  any OpenAI-compatible transcription endpoint (Groq's
          whisper-large-v3-turbo being the useful one). Bigger model, no local
          compute, and the audio leaves the machine.

Why this exists rather than driving voxtype: voxtype ships remote support that
its released build ignores, exposes no vocabulary biasing, and had to be
integrated through a result file plus a status stream. Owning the pipeline is
less code than working around not owning it.

Everything that makes whisper trustworthy lives here, not in the caller:
VAD before decode, forced language, temperature 0, no conditioning on previous
text, and confidence thresholds -- because a decoder given silence writes
plausible sentences.
"""
import json
import os
import tempfile
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("DA_STT_PORT", "8791"))
MODEL = os.environ.get("DA_STT_MODEL", "small.en")
LANG = os.environ.get("DA_STT_LANG", "en") or None
THREADS = int(os.environ.get("DA_STT_THREADS", "0")) or max(1, (os.cpu_count() or 4) - 1)

# Segments whisper emits on silence or noise are dropped by these.
NO_SPEECH_MAX = float(os.environ.get("DA_STT_NO_SPEECH_MAX", "0.6"))
LOGPROB_MIN = float(os.environ.get("DA_STT_LOGPROB_MIN", "-1.0"))

# Whole-utterance artifacts of training on captioned video. Only ever matched
# against the ENTIRE transcript, so someone who really says "thank you" keeps it.
ARTIFACTS = {
    "thank you", "thanks for watching", "thank you for watching", "please subscribe",
    "subscribe", "you", "bye", "goodbye", "okay", "ok", "so", "music", "applause",
    ".", "..", "...", "[music]", "(music)",
}

_model = None


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        print(f"[stt] loading {MODEL} (cpu/int8, {THREADS} threads)…", flush=True)
        _model = WhisperModel(MODEL, device="cpu", compute_type="int8",
                              cpu_threads=THREADS)
        print("[stt] ready", flush=True)
    return _model


def clean(text):
    """Drop a transcript that is nothing but a known hallucination."""
    t = (text or "").strip()
    bare = "".join(c for c in t.lower() if c.isalnum() or c.isspace()).strip()
    return "" if not bare or bare in ARTIFACTS else t


def transcribe_local(path, prompt):
    segs, info = model().transcribe(
        path,
        language=LANG,
        temperature=0.0,
        initial_prompt=prompt or None,
        # Trim silence BEFORE decoding. Filtering the text afterwards cannot
        # undo a decoder that has already invented a sentence from noise.
        vad_filter=True,
        vad_parameters=dict(threshold=0.5, min_silence_duration_ms=500),
        # A hallucinated segment must not seed the next one.
        condition_on_previous_text=False,
        no_speech_threshold=NO_SPEECH_MAX,
        log_prob_threshold=LOGPROB_MIN,
        compression_ratio_threshold=2.4,
    )
    kept = [s.text for s in segs
            if getattr(s, "no_speech_prob", 0.0) <= NO_SPEECH_MAX
            and getattr(s, "avg_logprob", 0.0) >= LOGPROB_MIN]
    return clean("".join(kept)), float(getattr(info, "duration", 0.0) or 0.0)


def transcribe_remote(path, prompt, endpoint, key, remote_model):
    """OpenAI-compatible multipart transcription (Groq, OpenAI, others)."""
    boundary = "----desktopagent"
    with open(path, "rb") as f:
        audio = f.read()
    parts = []

    def field(name, value):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                     f'name="{name}"\r\n\r\n{value}\r\n'.encode())

    field("model", remote_model)
    field("response_format", "verbose_json")
    field("temperature", "0")
    if LANG:
        field("language", LANG)
    if prompt:
        field("prompt", prompt)
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                 f'name="file"; filename="a.wav"\r\n'
                 f"Content-Type: audio/wav\r\n\r\n".encode())
    parts.append(audio)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        endpoint, data=body,
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read())

    # Use the per-segment confidence the API returns, same thresholds as local.
    segs = j.get("segments") or []
    if segs:
        kept = [s.get("text", "") for s in segs
                if s.get("no_speech_prob", 0.0) <= NO_SPEECH_MAX
                and s.get("avg_logprob", 0.0) >= LOGPROB_MIN]
        text = "".join(kept)
    else:
        text = j.get("text", "")
    return clean(text), float(j.get("duration", 0.0) or 0.0)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": MODEL, "threads": THREADS})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0) or 0)
        audio = self.rfile.read(n) if n else b""
        if not audio:
            return self._json(400, {"error": "no audio"})

        prompt = self.headers.get("X-Prompt", "") or ""
        mode = self.headers.get("X-Mode", "local")
        endpoint = self.headers.get("X-Endpoint", "")
        key = self.headers.get("X-Key", "")
        rmodel = self.headers.get("X-Remote-Model", "whisper-large-v3-turbo")

        tmp = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(audio)
                tmp = f.name
            if mode == "remote" and endpoint and key:
                text, dur = transcribe_remote(tmp, prompt, endpoint, key, rmodel)
                used = f"remote:{rmodel}"
            else:
                text, dur = transcribe_local(tmp, prompt)
                used = f"local:{MODEL}"
            self._json(200, {"text": text, "duration": dur, "engine": used})
        except Exception as e:
            self._json(500, {"error": str(e)[:300]})
        finally:
            # Audio is never kept. A recording of someone's desk is not ours.
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass


if __name__ == "__main__":
    model()   # fail loudly at startup, not on the first utterance
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
