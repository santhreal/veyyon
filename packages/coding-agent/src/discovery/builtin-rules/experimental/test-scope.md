---
description: "Suggest a narrower test selection when a bash command runs a whole suite"
condition:
  - "(?:^|\\s|&&|\\|\\||;)(?:bun|npm|pnpm|yarn|deno)\\s+(?:run\\s+)?test(?:\\s+(?:--?[\\w:.-]+|\\d?>&?\\d?))*\\s*(?=$|[|;&])"
  - "(?:^|\\s|&&|\\|\\||;)cargo\\s+(?:\\+\\S+\\s+)?test(?:\\s+(?:--?[\\w-]+|\\d?>&?\\d?))*\\s*(?=$|[|;&])"
  - "(?:^|\\s|&&|\\|\\||;)go\\s+test\\s+\\./\\.\\.\\."
  - "(?:^|\\s|&&|\\|\\||;)pytest(?:\\s+(?:--?[\\w:.-]+|\\d?>&?\\d?))*\\s*(?=$|[|;&])"
scope: "tool:bash"
interruptMode: never
repeatMode: per-compact
repeatCompactions: 3
---

This runs the whole suite. Prefer the narrowest selection that covers your change: one test file usually returns in well under a second, a package or directory in a few seconds, everything in minutes.

Batch before you gate. Finish a coherent chunk of work and gate it once, rather than after each small edit. Run the whole suite at a chunk boundary, before a commit, or when a narrow run has passed and you need the wider signal.
