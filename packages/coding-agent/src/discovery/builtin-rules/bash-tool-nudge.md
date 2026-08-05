---
description: "Suggest built-in grep/glob tools when running grep/rg/find in bash"
condition: "(?:^|\\s|&&|\\|\\|)(?:grep|rg|ripgrep|ag|ack|find|fd)\\s+"
scope: "tool:bash"
interruptMode: never
repeatMode: per-compact
---

Use built-in `grep` or `glob` instead of running `grep`/`rg`/`find` in `bash`.
