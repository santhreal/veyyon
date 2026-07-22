Globs files and directories via fast pattern matching, any codebase size.

<instruction>
- `path`: a glob, file, or directory. Search several at once by passing a semicolon-delimited list (`src/**/*.ts; test/**/*.ts`).
- A pattern that STARTS with a glob is recursive from the search root: `*.json` matches every `*.json` at any depth (it becomes `**/*.json`), not just the top level. Scope with a directory prefix (`src/*.json` stays in `src/`, `src/**/*.json` recurses under `src/`) to limit depth. A very broad pattern over a huge tree can time out; when it does you get the partial matches found so far plus an "incomplete scan" notice, so scope to a deeper directory rather than retrying.
- `gitignore` (default `true`) hides `.gitignore` matches. Set `gitignore: false` to find `.env*`, `*.log`, fresh build outputs, or anything your repo ignores.
- `hidden` (default `true`); combine with `gitignore: false` to surface dotfiles also gitignored.
</instruction>

<output>
Matching paths sorted by mtime (newest first), grouped under `# <dir>/` headers with basenames below; directories get a trailing `/`.
</output>

<avoid>
Open-ended searches needing multiple rounds of globbing/searching: you MUST use the Task tool instead.
</avoid>
