---
description: "Suggest built-in grep/glob tools when a bash command starts with grep/rg/find"
condition: "(?:^|\\n|&&|\\|\\||;|\\()\\s*(?:grep|rg|ripgrep|ag|ack|find|fd)(?![^\\n;&|]*<<)\\s+"
scope: "tool:bash"
interruptMode: never
repeatMode: per-compact
---

Use the built-in `grep` or `glob` tools to search files, not `grep`/`rg`/`find` in `bash`.

They take a path or glob and cannot read stdin, so they do not replace a pipeline that filters another command's output; keep that pipe, or move the processing into an `eval` cell.
