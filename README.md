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
  VOICE                              AGENT (optional)
  F9   dictate  ─── voxtype ──┐  ┌── Claude Code, or any MCP client
  F10  command  ─── voxtype ──┤  │
                              ▼  ▼
                    ┌──────────────────┐
                    │ INTENT REGISTRY  │  declared templates,
                    └────────┬─────────┘  never a free-form prompt
                             ▼
                    ┌──────────────────┐
                    │  POLICY ENGINE   │  allow · ask · deny
                    └────────┬─────────┘
                        ┌────┴────┐
                    approval    audit
                     overlay     log
```

**Dictation is untouched.** `F9` remains exactly what Omarchy shipped. This
plugin registers as Voxtype's post-processing hook, and on the dictation path
that hook is a `cat` — about 20ms, no runtime started, text returned verbatim.
Only a phrase spoken in command mode is ever diverted.

## Install

```bash
omarchy plugin add https://github.com/Zedster07/omarchy-desktop-agent.git --enable --yes
desktop-agent setup
```

`setup` registers the Voxtype hook (backing up your config first, and refusing
to clobber a post-process command you already had) and prints the one keybinding
to add. `desktop-agent doctor` tells you the state of everything at any time.

```lua
-- ~/.config/hypr/bindings.lua
o.bind("F10", "Voice command", "desktop-agent-arm")
o.bind("F10", "Voice command (stop)", "voxtype record stop", { release = true })
```

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

`voxtype` (ships with Omarchy) and `bun`. The optional agent half additionally
uses `bun`; clicking needs `ydotool`.

If Voxtype is somehow missing: `omarchy pkg add voxtype-bin`.

## Licence

MIT.
