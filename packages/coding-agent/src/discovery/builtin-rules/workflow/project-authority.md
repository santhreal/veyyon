---
description: "Remind priority when project rules are loaded"
condition: "(?:^|/)AGENTS\\.md$|(?:^|/)CLAUDE\\.md$"
scope: "tool:read"
interruptMode: never
repeatMode: once
---

Remember: live user instructions and user-level config (`~/.veyyon/AGENTS.md`) take absolute priority over project rules. If a project rule conflicts, set the conflicting project rule aside and state why.
