---
description: "Reaching into another project by absolute path costs tokens on every call; re-root there with set_cwd so its files take short relative paths"
condition: "(?:^|[\\s\"'=(,])/(?:[\\w.@+-]+/){3,}[\\w.@+-]+"
scope: "tool:read, tool:grep, tool:glob, tool:ast_grep"
interruptMode: never
---

You are reaching into a file by its full absolute path. A file inside your working directory does not need one: you refer to it by a short relative path, and only a file in a DIFFERENT project forces the absolute path you just used. If that is what happened, each such call costs extra tokens, and the cost repeats on every follow-up call into that project.

## Why it costs tokens

A file inside your working directory shows a short relative path (`src/foo.ts`) in the read header. A file outside it keeps its full absolute path in that header and in every edit that echoes the header back. The longer the path, the more tokens each call spends, and a settled task in a foreign project pays it on every read and edit.
{{#if argot}}

Argot shorthand is also armed per project, and only your working directory's project is loaded by default. Another project's identifiers stay uncompressed until you load it.
{{/if}}

## What to do

- If you will keep working in that project, `set_cwd` to it. Its files then display by their short relative paths instead of the absolute one.
{{#if argot}}
- Also `argot_load` that project so its identifiers compress too. Re-rooting and loading shorthand are separate steps; a settled move into a new project does both.
{{/if}}
- If this is a one-off glance, ignore this and carry on.
