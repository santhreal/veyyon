---
description: "Reaching into another project by absolute path costs tokens on every call; re-root there with set_cwd so its files take short relative paths"
condition: "(?:^|[\\s\"'=(,])/(?!usr/|etc/|opt/|proc/|sys/|dev/|var/|bin/|sbin/|lib/|lib64/|boot/|run/|snap/|nix/|tmp/|private/|System/|Library/|Applications/)(?:[\\w.@+-]+/){2,}[\\w.@+-]+"
scope: "tool:read, tool:grep, tool:glob, tool:ast_grep"
pathScope: outside-cwd
interruptMode: never
repeatMode: per-compact
warmupMatches: 3
---

You have now reached outside your working directory (`{{cwd}}`) by absolute path several times, most recently `{{#if matchedPath}}{{matchedPath}}{{else}}a file named by its full absolute path{{/if}}`. A file inside the working directory needs no absolute path: you name it by a short relative path. Every call into a directory outside it carries the full path instead, in the read header and in every edit that echoes that header back, and the cost repeats on every follow-up call.

## What to do

- If you will keep working over there, `set_cwd` to that project's ROOT — the directory holding its manifest or `.git`, not the directory the file happens to sit in. Its files then display by short relative paths.
{{#if argot}}
- Also `argot_load` that project so its identifiers compress too. Argot shorthand is armed per project and only your working directory's project is loaded by default, so re-rooting and loading shorthand are separate steps; a settled move into a new project does both.
{{/if}}
- If those reads were unrelated glances rather than work settling over there, ignore this and carry on. Re-rooting to pass through a few files costs more than the reads did.
