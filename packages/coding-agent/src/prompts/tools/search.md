Searches the workspace in one of the enabled modes.

{{#if FILES_ENABLED}}
## `mode: "files"`

Find files and directories with fast glob matching.

- `path` may be a glob, file, directory, or semicolon-delimited set such as `src/**/*.ts; test/**/*.ts`.
- A pattern that starts with a glob is recursive from the search root: `*.json` matches at any depth. Prefix a directory to constrain the scan.
- `gitignore` defaults to `true`. Set it to `false` for ignored files such as `.env*`, logs, or fresh build output.
- `hidden` defaults to `true`.
- A broad scan can time out with partial results; narrow the path rather than repeating it unchanged.
{{/if}}

{{#if TEXT_ENABLED}}
## `mode: "text"`

Search file contents with Rust regular expressions and PCRE2 syntax.

- Scope `path` to a known file or directory. It may also be a glob, internal URL, semicolon-delimited set, or a single-file line selector such as `src/foo.ts:50-100`.
- A literal `\n` makes the pattern cross lines.
- Results include snapshot tags and numbered context lines suitable for anchored edits.
- Use `skip` to paginate by files when a search reaches its file limit.

<critical>
Use this mode for content search. Never shell out to `grep`, `rg`, `git grep`, `awk`, or another CLI text-search command.
</critical>
{{/if}}

{{#if AST_ENABLED}}
## `mode: "ast"`

Search source by syntax shape with ast-grep.

- Use this mode when syntax structure matters more than text, such as calls, declarations, or language constructs.
- Narrow each call to one language and avoid repository-root scans.
- `pattern` is one AST pattern. `$NAME` captures one node, `$_` matches one without binding, and `$$$ARGS` captures zero or more nodes. Metavariable names are uppercase and must occupy a whole AST node.
- Repeating a metavariable requires identical code at both positions.
- The pattern must parse as one valid AST node. Wrap non-standalone snippets in context.
- C++ expression-statement calls require a trailing semicolon.
- TypeScript declaration forms have distinct shapes; search the relevant function, method, or arrow-function form.

<critical>
A parse error is a failed query, not evidence that no matches exist. Fix the pattern or narrow the path before concluding absence.
</critical>
{{/if}}

## Examples

{{#if FILES_ENABLED}}
Find TypeScript files under `src`:

`{"mode":"files","path":"src/**/*.ts"}`
{{/if}}

{{#if TEXT_ENABLED}}
Find JSON or tool references in source text:

`{"mode":"text","pattern":"json|tool","path":"src"}`
{{/if}}

{{#if AST_ENABLED}}
Find TypeScript console calls:

`{"mode":"ast","pattern":"console.log($$$)","path":"src/**/*.ts"}`
{{/if}}
