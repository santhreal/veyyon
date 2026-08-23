# Project trust

A repository can carry code that veyyon loads at startup: a plugin registry at
`.veyyon/plugins/installed_plugins.json`, and extension or hook files it names.
That code runs before tool approval applies. Opening a directory does not approve
it. Until you decide, it is withheld.

## What is withheld

| Project file | What it grants |
| --- | --- |
| `.veyyon/plugins/installed_plugins.json` | extensions, hooks, custom tools, slash commands and MCP servers, from the directories it names |
| an extension or hook file inside the project | module top-level code and its factory, at import |

A file outside the project root is not affected. Profile extensions, installed
plugins and paths you set in `extensions:` load as before — a configured path is
your own instruction and loads even when it lives inside the project, which is
where an extension is written while you are developing it. Settings come from
your profile and your home directory, so a repository cannot add itself to that
list.

## Deciding

```sh
veyyon trust           # show the code the project would run, and approve it
veyyon trust --list    # show it without deciding
veyyon trust --deny    # refuse, and remember the refusal
veyyon trust --forget  # drop the decision
veyyon trust path/to/file.ts   # decide one named file
```

Inside a session, `/trust` reports, and `/trust approve`, `/trust deny` and
`/trust forget` decide. `/trust approve <path>` approves one file by name, which
is how you answer a refusal that states a file the discovery scan does not list.

## What a decision records

One sha-256 per approved file, keyed by the symlink-resolved project root, in
`<agent dir>/project-trust.json`. Consequences:

- A file that changes after you approved it is withheld again.
- A file that appears later was not approved by an earlier decision.
- Approving the plugin registry approves the plugins it names. Their install
  directories are usually outside the project, and their contents are not
  digested.
- A denial is stored, so the next launch neither loads the code nor prompts again.
- A store written by another version of veyyon, or one whose records are
  malformed, is discarded. Nothing is trusted and you are prompted again.

## Reading a refusal

```
extensions: ext/hostile.ts was not loaded because this project has not been
trusted. Project code runs with your permissions; approve it with `/trust
approve` in this session or `veyyon trust` in this directory, or leave it
untrusted.
```

| Reason | Meaning |
| --- | --- |
| has not been trusted | no decision exists for this project |
| marked untrusted | you denied this project |
| changed since it was trusted | the file's bytes differ from the approved ones |
| not part of the approved set | the file was not in the decision |

Refusals appear as startup warnings. Nothing prompts: a session that cannot prompt
loads nothing rather than defaulting to yes.
