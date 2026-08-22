Search the workspace using the mode that matches the question.

{{#if AST_ENABLED}}
- Use `ast` for code structure: calls, declarations, methods, types, imports, and relationships between syntax nodes. Prefer it when the question says “calls”, “definitions”, “declarations”, or otherwise distinguishes syntax roles.
{{/if}}
{{#if TEXT_ENABLED}}
- Use `text` for exact identifiers, literals, comments, documentation, and regular-expression discovery. Do not approximate a known syntax shape with regex when `ast` can express it.
{{/if}}
{{#if FILES_ENABLED}}
- Use `files` for names, paths, extensions, and directory layout.
{{/if}}

{{#if FILES_ENABLED}}
## `mode: "files"`

- `path` accepts a glob, file, directory, or semicolon-delimited set.
- A leading glob is recursive from the search root: `*.json` matches at any depth. Prefix a directory to constrain it.
- `gitignore` and `hidden` default to `true`; set `gitignore: false` to include ignored files.
- Narrow a broad scan that times out instead of repeating it unchanged.
{{/if}}

{{#if TEXT_ENABLED}}
## `mode: "text"`

- `pattern` supports Rust regular expressions and PCRE2 syntax; a literal `\n` crosses lines.
- Scope `path` whenever the likely directory or file is known. It also accepts globs, internal URLs, semicolon-delimited sets, and single-file line selectors.
- Results carry snapshot tags and numbered context lines for anchored edits. Use `skip` to paginate after a file-limit result.

<critical>
Never shell out to `grep`, `rg`, `git grep`, `awk`, or another CLI for content search.
</critical>
{{/if}}

{{#if AST_ENABLED}}
## `mode: "ast"`

- `pattern` is one valid AST node. `$NAME` captures one node, `$_` matches one anonymously, and `$$$ARGS` captures zero or more nodes. Captures are uppercase, occupy whole nodes, and repeated names require identical code.
- Make `path` identify one language, such as `src/**/*.ts` or `internal/**/*.go`, and avoid repository-root scans.
- Write the construct in that language's syntax. Declaration forms are distinct; a function, method, and arrow function are different shapes.
- A parse error is a failed query, not an empty result. Fix the pattern or language scope before falling back to text.
{{/if}}
