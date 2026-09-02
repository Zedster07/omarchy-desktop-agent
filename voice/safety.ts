// What an AI is never allowed to propose.
//
// Tier 3 lets a model invent a command. That is only defensible because the
// result is checked here before a human is ever asked to approve it -- an
// approval prompt for `sudo rm -rf /` is not a safety mechanism, it is a trap
// with a button on it. The user's own policy engine already draws these lines
// for the MCP agent; this is the same reasoning applied to voice.
//
// Two groups, for two different reasons.

/**
 * Re-entering a shell or an interpreter launders every rule below it: the
 * first token stops being the real program. Escalation is its own category.
 */
const LAUNDERERS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "env", "xargs", "eval",
  "python", "python3", "perl", "ruby", "node", "bun", "deno", "lua", "awk",
  "ssh", "scp", "sftp", "nc", "ncat", "socat", "telnet",
  "sudo", "pkexec", "doas", "su", "runuser",
])

/**
 * Irreversible, or reaches past the desktop into the system. A voice command
 * misheard by one word must not be able to do any of these.
 */
const DESTRUCTIVE = new Set([
  "rm", "rmdir", "shred", "dd", "mkfs", "fdisk", "parted", "wipefs",
  "mv", "cp", "install", "truncate", "tee", "ln",
  "chmod", "chown", "chgrp", "chattr", "setfacl",
  "kill", "pkill", "killall", "systemctl", "loginctl", "journalctl",
  "shutdown", "reboot", "halt", "poweroff", "mount", "umount", "swapoff",
  "pacman", "yay", "paru", "apt", "dnf", "pip", "npm", "cargo", "gem",
  "crontab", "at", "iptables", "nft", "ufw", "passwd", "usermod", "useradd",
  "git", "curl", "wget", "rsync",
  // The agent's own controls: a voice command must not be able to widen its
  // own leash or answer its own approval prompts.
  "desktop-agent", "desktop-agent-arm", "qs", "hyprctl", "voxtype",
])

export interface Refusal { ok: false; reason: string; token: string }
export interface Allowed { ok: true }

function basename(p: string): string {
  return String(p ?? "").split("/").filter(Boolean).pop() ?? ""
}

export function checkProposedCommand(argv: string[]): Allowed | Refusal {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string") {
    return { ok: false, reason: "no command was proposed", token: "" }
  }

  const prog = basename(argv[0])

  if (LAUNDERERS.has(prog)) {
    return { ok: false, token: prog,
             reason: `${prog} would re-enter a shell, which puts every other rule out of reach` }
  }
  if (DESTRUCTIVE.has(prog)) {
    return { ok: false, token: prog,
             reason: `${prog} is not something a misheard sentence should be able to run` }
  }

  // Commands are exec'd as argv with no shell, so metacharacters are literal
  // rather than dangerous. They are still a sign the model believed it was
  // writing a shell line, which means the rest of its output is suspect.
  //
  // But only the COMPOSITION operators are that sign. A bare "&" is how every
  // URL separates query parameters, and rejecting those refused a perfectly
  // ordinary `xdg-open https://…?list=x&index=1` with "contains shell syntax"
  // -- a safety rule firing on the safest thing in the request.
  // A semicolon FOLLOWED by whitespace is the shell-composition shape. The
  // earlier form required whitespace before it too, so "x.com; rm -rf ~" slipped
  // past -- there is no space before that semicolon. Real URLs do not contain
  // "; " at all.
  const SHELL_COMPOSITION = /&&|\|\||`|\$\(|>>|<<|;\s|;$/
  for (const a of argv) {
    if (typeof a !== "string") return { ok: false, reason: "malformed argument", token: "" }
    // A URL is a single argv element and cannot be anything but data here --
    // but only if it is actually a URL. Real ones contain no whitespace, so
    // requiring that keeps the exemption from covering
    // "https://x.com; rm -rf ~", which is inert but is nobody's real link.
    if (/^https?:\/\/\S+$/i.test(a) && !/\s/.test(a)) continue
    if (SHELL_COMPOSITION.test(a)) {
      return { ok: false, token: a.slice(0, 40),
               reason: "the proposal contains shell syntax, so it was not written as a plain command" }
    }
  }

  // A denylisted program hiding in a later argument, e.g. ["flatpak","run","sudo"].
  for (const a of argv.slice(1)) {
    const b = basename(a)
    if (LAUNDERERS.has(b) || DESTRUCTIVE.has(b)) {
      return { ok: false, token: b,
               reason: `${b} appears as an argument, which is how a blocked program gets run anyway` }
    }
  }

  return { ok: true }
}
