# Acknowledgements

Veyyon stands on the work of others, and we credit it plainly. The handbook keeps this as a footnote on
purpose: Veyyon's public docs explain Veyyon's behavior first, while detailed competitive study stays in
private research notes.

- **oh-my-pi** ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)), under the MIT license. Veyyon
  is a fork of oh-my-pi: the TypeScript/Bun agent loop and TUI, the `pi-*` Rust natives (grep, PTY,
  hashline edits), provider breadth, role routing, session-tree work, and edit ergonomics all carry
  forward from it. Incorporated MIT code keeps its permission notice; see the repository `LICENSE`.
- **codex**, by OpenAI, under the Apache 2.0 license. oh-my-pi and Veyyon carry forward the codex
  `apply_patch` patch format and parts of the agent-loop shape as an independent TypeScript
  reimplementation, see `NOTICE` for exactly which files are format-compatible versus which actually
  vendor Apache 2.0 code (the OpenAI wire types and the Playwright ARIA-snapshot bundle do; the
  `apply_patch` parser and the Codex backend client do not).
- **OpenCode**, under the MIT license. Veyyon studies its plan/build workflow, project memory, compact
  command, and file-context UI ideas.
- **Lossless Claw**, under the MIT license. Veyyon studies its summary DAG, fresh-tail compaction, and
  compacted-history inspection tools.
- **command-code**, by Langbase. command-code is proprietary. Veyyon only studies observable mechanisms
  clean-room, copying no code or bundled implementation text.

The ideas here are reimplemented in Veyyon's own design, tested to Veyyon's own bar, and extended past
where we found them. Legal provenance and upstream notices live in the repository `LICENSE`, `NOTICE`,
and `UPSTREAM.md`.
