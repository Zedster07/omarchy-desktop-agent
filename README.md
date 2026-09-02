# Desktop Agent

Voice control and agent control for your desktop, on a leash you own.

Hold a key and talk: the words land in whatever window has focus. Hold a
different key and talk: the phrase is matched against a declared list of
actions and run — through a default-deny policy, with an approval prompt for
anything the rules are unsure about and an audit line for everything that
happens.

Speech never leaves the machine. There is no account, no API key, and no
network call in the voice path.

## Two front-ends, one gate

```
  VOICE                              AGENT (optional)
  Super+D        dictate ──┐     ┌── Claude Code, or any MCP client
  Super+Shift+D  command ──┤     │
                           ▼     ▼
                   ┌──────────────────┐
                   │ INTENT RESOLVER  │  matched against a registry,
                   └────────┬─────────┘  never free-form
                            ▼
                   ┌──────────────────┐
                   │  POLICY ENGINE   │  allow · ask · deny
                   └────────┬─────────┘
                       ┌────┴────┐
                   approval    audit
                    overlay     log
```

**Dictation deliberately does not pass through the policy.** You pressing a key
and speaking is you typing. Gating it would make it unusable — and the policy
forbids typing into terminals, which is right for an agent and wrong for you.
Only command mode and agent actions are gated.

The agent half is optional. Voice works with it turned off, and needs neither
`bun` nor an MCP client.

## Install

```bash
omarchy plugin add https://github.com/Zedster07/omarchy-desktop-agent.git --enable --yes
sudo pacman -S whisper-cpp
desktop-agent setup
```

`setup` downloads a speech model, writes two user units, and starts them.
Nothing runs on its own at install time: Omarchy never executes an install hook
for a plugin, and this one does not try to work around that. Check state at any
time with `desktop-agent doctor`.

Then bind the keys:

```
bind  = SUPER, D, exec, desktop-voice start dictate
bindr = SUPER, D, exec, desktop-voice stop
bind  = SUPER SHIFT, D, exec, desktop-voice start command
bindr = SUPER SHIFT, D, exec, desktop-voice stop
```

## Why the transcript is filtered

Whisper's decoder is an autoregressive language model. That is why it gives you
punctuation and casing for free, and it is the same reason it can keep
generating text once the audio stops supporting it — the familiar
"Thank you for watching!" on a silent clip is the model completing a pattern
from captioned web video, not mishearing you.

You cannot remove that; it is the architecture. So `voice/filter.ts` fences it.
Nothing reaches your keyboard until it passes:

| Rule | Catches |
|---|---|
| `vad-floor` | Microphone never got loud enough for speech to have happened |
| `no-speech-prob` | The engine's own estimate that this was not speech |
| `logprob` | Mean token probability below −1.0 — the decoder was guessing |
| `non-speech-tag` | `[MUSIC]`, `(applause)`, `♪…♪` |
| `artifact` | A known filler phrase as the **entire** utterance |
| `compression` | Repetition loops, via gzip ratio > 2.4 |
| `phrase-repeat` | "open the door open the door open the door" |
| `rate` | More words than the audio duration could contain |

Push-to-talk is close to the best case for this: short utterances, an explicit
start and stop, a close mic, one speaker, and you watching the result appear.
Most documented Whisper hallucination is a long-form unattended problem.

Rejections are never silent — the HUD says which rule fired and why.

## Recovering from a bad transcript

The filter is a fence, not a guarantee, so recovery is one keystroke:

- Text is inserted as a **single undo unit** — `Ctrl+Z` removes the dictation,
  not forty characters.
- **Preview mode** (off by default) shows the transcript in the HUD and waits
  for Enter instead of typing straight away.
- Custom vocabulary primes the decoder with your names and jargon, which is the
  cheapest accuracy win available.

## Settings

Everything is in the widget's settings form — engine, model, language,
injection method, vocabulary, confirmation policy, lease ceiling. Nothing here
needs a hand-edited config file.

`policy.jsonc` remains a hand-edited file on purpose: it is the security
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

`pw-record` (pipewire), `wtype`, `socat`, `wl-clipboard`, `whisper-cpp`.
The optional agent half additionally needs `bun`, and clicking needs `ydotool`.

## Licence

MIT.
