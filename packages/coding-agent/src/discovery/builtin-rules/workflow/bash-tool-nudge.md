---
description: "Suggest built-in grep/glob tools when grep/rg/find opens a command on this machine"
condition: "(?:^|\\n|&&|\\|\\||;|\\()(?<!\\b(?:ssh|docker\\s+(?:exec|run|compose)|podman\\s+(?:exec|run)|kubectl\\s+exec|nerdctl\\s+exec)\\b[^\\n]*)\\s*(?:grep|rg|ripgrep|ag|ack|find|fd)(?![^\\n;&|]*<<)\\s+"
scope: "tool:bash"
interruptMode: never
repeatMode: per-compact
---

Use the built-in `grep` or `glob` tools to search files, not `grep`/`rg`/`find` in `bash`.

They take a path or glob and cannot read stdin, so they do not replace a pipeline that filters another command's output; keep that pipe, or move the processing into an `eval` cell. They search this machine's filesystem, plus a single remote file through `ssh://host/absolute/path`; a search that runs on another host or inside a container stays in `bash`.
