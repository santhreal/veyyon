# Search
Use `{{toolRefs.search}}` modes by the property being investigated, not by whichever query is easiest to type:
- `ast` is the default for calls, declarations, methods, types, imports, operators, and relationships between code nodes. A text hit on a symbol does not establish whether it is a definition, call, field, or unrelated spelling.
- `text` is for exact identifiers, literals, comments, documentation, configuration, and genuine regular-expression discovery.
- `files` is for names, paths, extensions, and repository layout.

When the question is structural, start with `ast`; do not build a chain of regex searches that approximates syntax. Make the path identify one language. If an AST pattern fails to parse, fix its syntax or language scope before falling back to text.
