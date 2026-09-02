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
filtering, injection.

**Transcription is remote by default and downloads nothing.** A free Groq key
gets you `whisper-large-v3-turbo` — a far larger model than anything that
runs comfortably on a laptop CPU, with no install and no disk cost. Paste the
key into the panel's voice tab and it works.

**Local is one dropdown away, and it asks first.** Choosing it shows exactly
what will be downloaded before anything happens:

```
local transcription needs a download
speech packages 432 MB  ·  model small.en 464 MB  —  896 MB total,
kept on this machine.
       [ Download and switch ]   [ Stay on remote ]
```

Nothing is fetched without that yes, and the numbers are measured rather than
guessed. Already have the packages? It only counts the model.

### Why not the dictation tool that ships with Omarchy

The first version wrapped voxtype, on the reasoning that a plugin should not
reinvent something shipping with the OS. Three things changed that: voxtype's
released build accepts a remote-transcription config and silently ignores it,
it exposes no vocabulary biasing, and integrating through a result file plus a
status stream produced three separate bugs in that seam alone.

The deciding number was the runtime. Same machine, same 5s clip:

| engine | |
|---|---|
| faster-whisper `base.en`, CPU int8 | **0.96s** |
| faster-whisper `small.en`, CPU int8 | **2.02s** |
| whisper.cpp (voxtype) on the Vulkan iGPU | 13.06s |

CTranslate2 beats whisper.cpp six times over here, on the CPU, with the larger
model. Owning the pipeline turned out to be less code than working around not
owning it.

### What makes the transcript trustworthy

Both paths apply the same discipline: VAD **before** decode, forced language,
temperature 0, no conditioning on previous text, and per-segment confidence
thresholds. A decoder handed silence writes plausible sentences, so the
silence never reaches it.

## Four tiers, escalating

Most requests never reach a model at all.

| tier | who decides | when |
|---|---|---|
| **1 match** | nobody — string comparison | a registered phrase. Sub-millisecond. |
| **2 route** | AI picks from the same list | an unregistered wording of a known command |
| **3 plan** | AI writes commands | something the list does not cover: playing a song, opening a URL |
| **4 agent** | AI drives the desktop | anything not expressible as commands at all |

Tier 4 is a hand-off to the agent half of this plugin: it can take a
screenshot, click a particular thing, and react to what it finds. It is opt-in,
and the safety is not new — every action goes through the same policy engine,
approval overlay and audit log, and it fails closed if the overlay is not
loaded.

That half ships here: `server/` is the MCP server, the policy engine and the
Hyprland plumbing. `desktop-agent mcp-install` registers it with Claude Code,
pointing at this plugin's copy. One plugin, one policy, one overlay — an
install that half-works because it is driving someone else's server is not
something anyone can ship.

The agent gets `mcp__desktop__*` and nothing else: no file editing, no shell,
no tools of its own. `--permission-mode bypassPermissions` means "do not add a
second prompt on top of the one the policy already shows" — the person is
talking, not watching a terminal — not "skip the checks".

Anything a model decided still needs your approval before it runs.

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

## Opening apps

"open whatsapp", "launch gmail", "open google maps" — resolved against the
`.desktop` entries actually installed on the machine and launched with
`uwsm-app`, the same way Omarchy's own launchers do, so a voice-started app
lands in the same systemd slice as a menu-started one.

Webapps come for free: Omarchy installs them AS desktop entries, so WhatsApp,
Gmail, Discord and the rest are found without special-casing.

Generic words are checked first and mean your configured default:
`browser`, `terminal`, `editor`, `files` go through `omarchy launch`. That
ordering matters — "browser" legitimately substring-matches
*Avahi Zeroconf Browser*, and no scoring can tell those apart, so a role word
must never reach the app search.

An app that is not installed is refused by name rather than guessed at.

Nothing here is configured or per-machine. The list is read from the XDG
entry directories at use time, so it is whatever *that* user has installed,
and it is re-read when those directories change — install an app and it is
speakable immediately, with no restart and no registry to maintain.

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

Nothing else by default. Choosing local transcription later creates a
virtualenv under `~/.local/share/desktop-agent/` and installs faster-whisper
into it (432 MB plus the model) — but only after the panel has shown you the
size and you have said yes. Nothing is installed system-wide.

## Developing on this

Plugin QML does not reliably hot-reload for panel components — a `Panel.qml`
change can leave the old one instantiated, so a new dropdown option or a
changed label simply will not appear.

```bash
omarchy restart shell
qs -p /usr/share/omarchy/shell log | grep zedster07
```

That is the first thing to try when an edit looks like it did nothing.

## Licence

MIT.
