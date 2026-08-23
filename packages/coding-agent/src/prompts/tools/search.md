Searches workspace paths, text, and code structure through one type-first interface.

<schema>
Always pass `type` before `input`:
- `{ type: "files", input: "src/**/*.ts" }`
- `{ type: "text", input: "TODO|FIXME", path: "src" }`
- `{ type: "structure", input: "console.log($$$)", path: "src/**/*.ts" }`
</schema>

<types>
- `files` matches file names, paths, extensions, directories, and repository layout. `input` is a file, directory, glob, or semicolon-delimited set. A leading glob such as `*.json` is recursive; prefix a directory to limit depth. `hidden`, `gitignore`, and `limit` apply only here.
- `text` matches literals, comments, documentation, configuration, and regular expressions where syntax role is irrelevant. `input` supports Rust regular expressions and PCRE2 syntax; literal `\n` or `\\n` crosses lines. `path`, `case`, `gitignore`, and `skip` apply only here.
- `structure` matches definitions, calls, methods, types, fields, imports, operators, and syntax relationships. `input` is one valid syntax node in the target language. `$NAME` captures one node, `$_` matches one anonymously, and `$$$ARGS` captures zero or more nodes. Metavariables are uppercase and occupy whole nodes. `path` and `skip` apply only here.
</types>

<instruction>
- Use `structure` whenever the question depends on code syntax or relationships; text matches do not prove definitions, calls, or types.
- For `text` and `structure`, `input` is the pattern and `path` is the scope; never swap them. Pass the narrowest known `path` instead of repeating a broad workspace search.
- Scope `structure` to one language. Declaration forms are distinct: functions, methods, and arrow functions require their own valid patterns. C++ expression-statement calls require the trailing semicolon.
- A structure parse error means the input or language scope is wrong. Correct it rather than falling back to `text`.
- `path` accepts a file, directory, glob, internal URL, line selector for `text`, or semicolon-delimited set. `ssh://` scopes work only with `text`; use `read` to inspect remote code before a local `structure` search. Omit `path` only when the workspace root is the intended scope.
</instruction>

<output>
Broad multi-file `text` results may show representative matches and a recoverable `artifact://` reference instead of carrying the entire match set through later turns. Narrow `path` for detail; read the artifact only when the complete set is needed.
{{#if HASH_LINES}}Text and structure matches use snapshot-tag headers and numbered lines such as `[src/login.ts#A1B2]`; copy the header for anchored edits.{{else}}{{#if LINE_NUMBERS}}Text and structure matches use line-number-prefixed output.{{/if}}{{/if}}
</output>
