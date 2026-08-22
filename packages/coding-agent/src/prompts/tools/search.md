Choose `purpose` by what the result must prove, then follow that purpose's section.

{{#if AST_ENABLED}}
## `purpose: "analyze"`

- Finds definitions, calls, methods, types, imports, operators, and other syntax relationships.
- `pattern` must be one valid AST node in the target language. `$NAME` captures one node, `$_` matches one anonymously, and `$$$ARGS` captures zero or more nodes. Captures are uppercase and occupy whole nodes.
- Scope `path` to one language, such as `src/**/*.ts` or `internal/**/*.go`. Function, method, and arrow-function declarations are different shapes.
- A parse error means the pattern or language scope is wrong. Fix it rather than falling back to text matching.
{{/if}}

{{#if TEXT_ENABLED}}
## `purpose: "match"`

- Finds literals, comments, documentation, configuration, and regular expressions where syntax role is irrelevant.
- `pattern` supports Rust regular expressions and PCRE2 syntax; a literal `\n` crosses lines.
- Scope `path` with directories, globs, internal URLs, semicolon-delimited sets, or single-file line selectors. Results include snapshot tags and numbered lines; use `skip` to paginate.
{{/if}}

{{#if FILES_ENABLED}}
## `purpose: "locate"`

- Finds file names, paths, extensions, directories, and repository layout.
- `path` accepts a glob, file, directory, or semicolon-delimited set. A leading glob such as `*.json` is recursive; prefix a directory to constrain it.
- `gitignore` and `hidden` default to `true`; set `gitignore: false` to include ignored files.
{{/if}}
