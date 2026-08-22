Use this tool for all workspace discovery: locating paths, finding exact occurrences, and understanding code structure.

<critical>
Do not look for or call separate `glob`, `grep`, or `ast_grep` tools. Never shell out to `grep`, `rg`, `find`, `git grep`, `awk`, or another CLI for workspace discovery.
</critical>

Choose `purpose` by the question being answered:

{{#if AST_ENABLED}}
- `analyze`: understand definitions, calls, methods, types, imports, operators, or relationships between code nodes. Use this first for structural questions; a text occurrence cannot establish a syntax role.
{{/if}}
{{#if TEXT_ENABLED}}
- `match`: find exact identifiers, literals, comments, documentation, configuration, or genuine regular-expression matches.
{{/if}}
{{#if FILES_ENABLED}}
- `locate`: find names, paths, extensions, directories, or repository layout.
{{/if}}

{{#if AST_ENABLED}}
## `purpose: "analyze"`

- `pattern` is one valid AST node. `$NAME` captures one node, `$_` matches one anonymously, and `$$$ARGS` captures zero or more nodes. Captures are uppercase, occupy whole nodes, and repeated names require identical code.
- Make `path` identify one language, such as `src/**/*.ts` or `internal/**/*.go`, and avoid repository-root scans.
- Write the construct in that language's syntax. A function, method, and arrow function are different shapes.
- A parse error is a failed query, not an empty result. Fix the pattern or language scope before using `match`.
{{/if}}

{{#if TEXT_ENABLED}}
## `purpose: "match"`

- `pattern` supports Rust regular expressions and PCRE2 syntax; a literal `\n` crosses lines.
- Scope `path` whenever the likely directory or file is known. It also accepts globs, internal URLs, semicolon-delimited sets, and single-file line selectors.
- Results carry snapshot tags and numbered context lines for anchored edits. Use `skip` to paginate after a file-limit result.
{{/if}}

{{#if FILES_ENABLED}}
## `purpose: "locate"`

- `path` accepts a glob, file, directory, or semicolon-delimited set.
- A leading glob is recursive from the search root: `*.json` matches at any depth. Prefix a directory to constrain it.
- `gitignore` and `hidden` default to `true`; set `gitignore: false` to include ignored files.
- Narrow a broad scan that times out instead of repeating it unchanged.
{{/if}}
