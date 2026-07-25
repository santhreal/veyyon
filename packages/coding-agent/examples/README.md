# Examples

Example code for the veyyon coding-agent SDK, hooks, and custom tools.

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, hooks, and session management.

### [hooks/](hooks/)
Example hooks for intercepting tool calls, adding safety gates, and integrating with external systems.

### [custom-tools/](custom-tools/)
Example custom tools that extend the agent's capabilities.

### [extensions/](extensions/)
Example extensions, which register tools, commands, flags, and renderers through `ExtensionAPI`.

## Editing an example

Each example ships twice: `hello.ts` and `hello.js`, so you can copy whichever
one matches the language you write in. The TypeScript file is the source and the
JavaScript file is generated from it, so edit the `.ts` and then run:

```sh
bun scripts/gen-example-js.ts --write
```

Run it without `--write` to check instead of rewrite; that is what CI does. Note
that a comment sitting directly above a type-only import does not survive the
transpile, because the import itself is erased: put a file's header comment above
the first statement that still exists in JavaScript.

The TypeScript examples are type checked as a workspace project
(`bun run --filter @veyyon/coding-agent check:types`), and the generator makes the
JavaScript copies follow. An example that does not compile is worse than no
example, because the reader discovers that only after copying it.

## Documentation

- [SDK Reference](sdk/README.md)
- [Hooks Documentation](../../../docs/hooks.md)
- [Custom Tools Documentation](../../../docs/custom-tools.md)
- [Skills Documentation](../../../docs/skills.md)
