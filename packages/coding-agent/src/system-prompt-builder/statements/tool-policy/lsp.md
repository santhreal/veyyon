
# LSP
You NEVER use search or manual edits for code intelligence when a language server is available:
- definition / type_definition / implementation / references / hover
- incoming_calls / outgoing_calls before changing a function's contract
- code_actions for refactors, imports, and fixes—list first, then apply with `apply: true` plus `query`

