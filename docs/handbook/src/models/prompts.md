# Execution-order prompts

The harness assembles system and developer prompts and adapts them per provider. Base instructions
encode control-flow discipline: **explore → plan → edit → verify → STOP**. Plan mode (`/plan`) and
goal mode (`/goal`) add gating on top of the default prompt stack.

## Delivery

- A default system prompt plus per-tool prompts
- Per-provider streaming and tool wire format
- Skills and rules inject additional context via discovery

Edit tool prompts switch with `edit.mode` (the hashline prompt when hashline is active).

There is no `backends.toml`-driven catalog or per-backend prompt tuning, and `apply_patch` is not the
default edit surface, Veyyon uses hashline by default.

## Seeing every prompt

You do not have to read the source to find out what Veyyon sends a model. Run:

```
veyyon prompt --prompts
```

That lists every prompt by id, grouped by the directory it lives in, with one line on what
each is for. An id is the file's path under that directory without the `.md`, so
`turn-control/auto-continue` and `dialect/gemma` name their own files.

Then look at one:

```
veyyon prompt --prompt subagent/system-prompt
```

The lookup spans every registry, so an id from any of them works without naming its package.
A mistyped id is refused with the nearest real id quoted back.

For the system prompt itself, `veyyon prompt` prints the assembled text and
`veyyon prompt --sections` breaks it down by section with the byte and token cost of each.

`veyyon prompt --statements` goes one level finer. The prompt is assembled from named statements,
one per rule, so this prints what each individual rule costs you:

```
statement                                      bytes   tokens  share  condition
execution-workflow/verify                       1099      275  10.6%  always
delivery-contract/personality                   1098      274  10.5%  personality
tool-policy/lsp                                  412      103   4.0%  tools has lsp
```

Two things to read from it. The cost is MARGINAL: it is what the prompt would be shorter by without
that rule, not the length of the rule's text, so the numbers add up to their section rather than
exceeding it. And the condition tells you what turns the rule on, which is what you need to know
before deciding a rule is not earning its tokens.

Under the table is every rule this configuration leaves out, with the condition that would include
it, so a rule being off is visible as a fact rather than as an absence you have to notice:

```
not in this prompt (33 of 68):
  tool-policy/delegation-gates      needs tools has task
  runtime/obsidian-vault-url        needs hasObsidian
```

To read one of those rules, name it:

```
veyyon prompt --statement delivery-contract/personality
```

You get the rule's rendered text, which is what the model sees rather than the template behind it. If
the rule is not in this prompt you get the condition that would include it and why the rule exists,
and the command still exits 0, because a rule being off is a configuration and not a failure. An id
that does not exist exits non-zero and quotes the ids of the section you named.

Both read your real configuration. The settings the prompt is gated on -- your personality, whether
subagent delegation is preferred or required, whether Mermaid diagrams are rendered, which tool
dialect applies -- are resolved from your profile `config.yml` before the prompt is
assembled, so what you see is what a session would send. Change a setting, run it
again, and the difference is visible.

The prompt is only half of what a turn pays before your first message. Every active tool ships a
description and a parameter schema on every request, and `veyyon prompt --tools` prices that half:

```
tool          bytes     desc   schema   tokens  share
edit           8158     2013       27     2040   15.4%
eval           5720     1258      173     1431   10.8%
launch         5563      684      707     1391   10.5%
TOTAL         53060    10011     3266    13277

17 tools cost 13277 tokens; the system prompt costs 23403. Every request pays both.
```

The row set is the tool set your configuration loads, so disabling a tool removes its row and its
cost. The two halves are separated because they are cut differently: a description is prose you can
shorten, a schema is the parameter list and shrinks only by dropping parameters.

Nothing is written while you look. The command opens no database, migrates nothing, and leaves no
marker files, so inspecting the prompt cannot change what the next session does.

## Going deeper

The system prompt is not one string. It is an ordered list of parts, and the boundary between the
first part and the rest is a provider-caching contract rather than a stylistic choice. To change
what a part says, read [System prompt customization](../../../system-prompt-customization.md). To
understand why the parts are split where they are, and where a new part would belong, read
[`docs/internal/system-prompt-architecture.md`](../../../internal/system-prompt-architecture.md).
