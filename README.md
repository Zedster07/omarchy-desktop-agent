# Desktop Agent

**Say what you want, and your desktop does it — on a leash you own.**

Omarchy already turns your voice into text: Voxtype ships with the OS, bound to
`F9`. This does the other half. Press `F10`, say *"workspace three"* or
*"lock screen"*, and it **happens** — matched against a declared list of
actions, gated by a default-deny policy, with an approval prompt for anything
irreversible and an audit line for everything that runs.

Nothing to install for the voice part. No engine, no model download, no API
key, no account. If you are running Omarchy, the speech half is already there.

## Two front-ends, one gate

```
  VOICE                                AGENT (optional)
  F9   dictate  ─┐                 ┌── Claude Code, or any MCP client
  F10  command  ─┤                 │
                 ▼                 ▼
          ┌──────────────┐   ┌──────────────────┐
          │ capture+VAD  │   │ INTENT REGISTRY  │
          │ stt/server.py│──▶│ declared templates│
          └──────────────┘   └────────┬─────────┘
                                      ▼
                             ┌──────────────────┐
                             │  POLICY ENGINE   │  allow · ask · deny
                             └────────┬─────────┘
                                 ┌────┴────┐
                             approval    audit
                              overlay     log
```

## The speech stack

This plugin owns the whole speech path: capture, VAD, transcription,
filtering, injection. It does not drive an external dictation tool.

That was not the original plan. The first version wrapped Omarchy's bundled
voxtype, on the reasoning that a plugin should not reinvent something shipping
with the OS. Three things changed the calculation: voxtype's released build
accepts a remote-transcription config and silently ignores it, it exposes no
vocabulary biasing, and integrating with it meant a result file plus a status
stream — three separate bugs came out of that seam alone.

The deciding number was the runtime. Same machine, same 5s clip:

| engine | |
|---|---|
| faster-whisper `base.en`, CPU int8 | **0.96s** |
| faster-whisper `small.en`, CPU int8 | **2.02s** |
| whisper.cpp (voxtype) on the Vulkan iGPU | 13.06s |

CTranslate2 is simply a better runtime than whisper.cpp here: `small.en` on
plain CPU beats whisper.cpp on the GPU by six times, and is the more accurate
model. Owning the pipeline turned out to be less code than working around not
owning it.

`stt/server.py` keeps a model warm and answers `POST /transcribe`. Two
backends behind one interface:

- **local** — faster-whisper, int8, nothing leaves the machine.
- **remote** — any OpenAI-compatible endpoint. Groq's `whisper-large-v3-turbo`
  is the useful one: a far larger model, no local compute, and your audio
  leaves the machine. Off unless you choose it and add a key.

Everything that makes whisper trustworthy lives in that service, not in the
caller: VAD **before** decode, forced language, temperature 0, no conditioning
on previous text, and per-segment confidence thresholds. A decoder handed
silence writes plausible sentences, so the silence never reaches it.

## The action space is a registry, not a prompt

This is the design decision everything else follows from. A spoken phrase is
matched against declared templates with typed slots:

```json
{
  "id": "workspace.switch",
  "phrases": ["workspace {n}", "go to workspace {n}"],
  "slots": { "n": { "type": "number", "min": 1, "max": 10 } },
  "run": ["hyprctl", "dispatch", "workspace", "{n}"]
}
```

No language model decides what to run. That makes it **fast** (matching is
string work, so the hook returns in ~130ms and cannot trip Voxtype's timeout),
**offline**, **auditable**, and — most importantly — **bounded**. It can only
ever do things someone declared.

A phrase that does not match well enough is reported as unrecognised. It is
never guessed at, and never quietly typed into whatever window had focus.

Two rules earn their keep:

- **Filler words are stripped**, so *"could you please switch to workspace two"*
  hits the same template as *"workspace 2"*.
- **Homophone digits are not.** Mapping `"to"→2` looked helpful and silently
  turned *"set volume to seventy"* into 2%. A preposition is far more common
  than the digit it sounds like, and a wrong action is much worse than an
  unmatched one — an unmatched one says so.

## Which AI, and when

Most commands never reach a model: a registered phrase is matched by string
comparison in under a millisecond.

On a miss, your installed CLI agent is asked to pick from the same list —
claude first, then opencode, codex, gemini, with a local Ollama model as the
fallback for a machine that has none. The agent is preferred because the job
is mostly about saying *"none of these"*, and that is the single thing a small
local model is worst at: asked to route "play Despacito on YouTube", a 3B
model picked `audio.mute`.

That accuracy costs about ten seconds on the miss path instead of five, and
tokens. Set `aiProvider` to `ollama` if you would rather have the speed and
keep it offline.

## Other plugins can be spoken to

There are over two thousand plugins on the marketplace and none of them can be
spoken to. Any plugin that drops a `voice-intents.json` beside its manifest
becomes voice-controllable, without knowing this plugin exists.

Sources are **approved once** before their intents go live. Installing a plugin
must not silently extend what your microphone can do to your machine.

## Nothing irreversible happens quietly

Intents can be marked `destructive`. Those always raise the approval overlay —
whatever your confirmation setting says, and regardless of any lease — and the
overlay drops its "Always" button so there is no one-click way to stop being
asked.

The prompt shows what it heard, which intent matched, the exact argv, and why
it stopped. You are never approving a black box.

## If it keeps mishearing you

Check the microphone before the model. A signal that is too quiet or clipped
destroys the waveform, and whisper responds by writing plausible language
instead of what you said — "open chrome" heard as "hope chrome", or an opening
word invented outright.

```bash
desktop-agent-mictest
```

It records five seconds, reports peak/RMS/clipping, and transcribes the same
clip. Peak wants to be roughly **0.2–0.6** with no clipping. Two real failures
found this way on one laptop: a USB dongle capturing at peak 0.013 (barely
above the noise floor), and the internal mic clipping 34% of samples behind
+50 dB of hardware gain.

The durable fix is automatic gain control rather than a hand-tuned level,
because the right gain depends on how loudly you happen to be speaking.
PipeWire's `libpipewire-module-echo-cancel` wraps the same webrtc-audio-processing
a browser applies to `getUserMedia`:

```
context.modules = [
  { name = libpipewire-module-echo-cancel
    args = {
      aec.args = { webrtc.gain_control = true, webrtc.noise_suppression = true }
      capture.props = { node.target = "<your mic>" }
      source.props  = { node.name = "mic_agc" }
    } }
]
```

Then make `mic_agc` your default source. Leave the raw mic with headroom
(~30%) so AGC has something to work with rather than a clipped signal.

## When a command is misheard

Matching is strict on purpose, so the usual failure is *"No command matched"* —
which costs you a repeat, not a wrong action. Turn `Match strictness` up if you
get false matches, down if it is too fussy.

For dictation itself, Voxtype owns accuracy: `voxtype configure` gives you the
engine, model, language and a custom-vocabulary list. This plugin does not
duplicate those settings — one source of truth per setting.

## Settings

In the widget's settings form: whether spoken commands are on, when a command
needs confirmation, whether other plugins may register intents, match
strictness, and the unattended-lease ceiling.

`policy.jsonc` stays a hand-edited file on purpose: it is the security
boundary, it wants comments, and it should be reviewed as text.

## The policy

Five dimensions, evaluated independently, **most restrictive wins**:

1. `capabilities` — may it do this kind of thing at all?
2. `workspaces` — is the target somewhere it may touch?
3. `apps` — may it do this to this particular window?
4. `paths` — may it write to this file?
5. `run.commands` — may it run this program?

Within a dimension the **last matching pattern wins**, so put broad rules first
and exceptions last. Anything unmatched is **denied**, and every refusal names
the rule responsible.

Fail-closed throughout: an unreadable policy refuses everything, and if the
shell plugin is not loaded there is nobody to ask, so every `ask` refuses.

## The kill switch is a flag file

`~/.local/state/desktop-agent/disabled`. Nothing has to be running for it to
hold, and it cannot corrupt your policy — an earlier version rewrote
`"enabled": true` inside `policy.jsonc` with `sed`, which silently flips the
wrong key when that string appears in a nested section first.

The full-access lease works the same way: a timestamp at
`~/.local/state/desktop-agent/yolo.json`. It expires with nothing running, it
survives nothing, and `rm` ends it immediately. A lease only ever promotes
`ask` to `allow` — it never reaches a `deny`, and never auto-approves a
destructive command.

## Theming

Every colour is derived from Omarchy's tokens; there is not one literal in the
QML. The approval prompt is built on the shell's **polkit** surface rather than
the generic popup one, so a theme that styles the system password dialog styles
this identically, gradients included.

## Requirements

`pw-record` (pipewire), `wtype`, `socat`, `wl-clipboard`, `python3`, `bun`.

`desktop-agent setup` creates a virtualenv under
`~/.local/share/desktop-agent/` and installs faster-whisper into it — about
430 MB, plus the model on first run. Nothing is installed system-wide and
voxtype is not required.

## Licence

MIT.
