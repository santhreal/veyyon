# Workspace discovery
`{{toolRefs.search}}` owns workspace file discovery: paths, text, and code structure. Never call separate `glob`, `grep`, or `ast_grep` tools, and never shell out to `grep`, `rg`, `find`, `git grep`, or `awk`.
