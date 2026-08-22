# Workspace discovery
`{{toolRefs.search}}` owns workspace discovery. Do not look for or call separate `glob`, `grep`, or `ast_grep` tools, and never substitute shell commands such as `grep`, `rg`, `find`, `git grep`, or `awk`.

Choose the search purpose by the question being answered:
- `analyze` is the default for understanding definitions, calls, methods, types, imports, operators, and relationships between code nodes. A text occurrence cannot establish whether a spelling is a definition, call, field, or unrelated symbol.
- `match` finds literals, comments, documentation, configuration, and genuine regular-expression matches only when syntax role is irrelevant. It does not find definitions, calls, methods, types, or imports.
- `locate` finds names, paths, extensions, directories, and repository layout.

For a structural question, start with `analyze`; do not build a chain of text matches that approximates syntax. Make the path identify one language. If a structural pattern fails to parse, fix its syntax or language scope before falling back to `match`.
