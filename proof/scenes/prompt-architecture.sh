#!/usr/bin/env bash
# What the system prompt is made of, printed by the product itself.
#
# Two subcommands, not a session: `prompt --sections` costs every assembled
# section, and `prompt --statements` lists the conditional statements and the
# state each one is waiting on. That is why this scene runs in a shell rather than
# in the TUI (SCENE_COMMAND is `bash`), and it is also why it needs no model: the
# assembly is deterministic, so the same command prints the same table every time.
CLI="bun /repo/packages/coding-agent/src/cli.ts"

settle 6
shot shell

submit "${CLI} prompt --sections --cwd /sandbox/home/demo"
settle 25
shot sections

submit "clear"
sleep 1

submit "${CLI} prompt --statements --cwd /sandbox/home/demo"
settle 25
shot statements
