# How to read this book

## Structure

The book runs from what Veyyon is to how it works inside, in this order:

- **Understand Veyyon**: what it is, why it helps, the main mechanisms, and Argot, the shorthand the
  fork adds.
- **Get started**: install, sign in, and run your first task.
- **Core concepts**: the few ideas the rest of the book builds on (sessions and turns, the permission
  model, the model contract).
- **Everyday use**: the operator workflows (editing, approvals, models, sessions, and the interface).
- **Extend and customize**: skills, plugins, hooks, MCP, profiles, and configuration.
- **Reference**: the exhaustive lists (CLI flags, slash commands, tools, keybindings, environment
  variables, exit codes, file locations).
- **Under the hood**: how the harness implements those surfaces (architecture, repair, the edit
  engine, the provider stack, context, observability).
- **Troubleshooting**: when something is wrong, plus the FAQ and the doctor self-check.

Each concept has one page that owns it, and other pages cross-link to that page rather than repeat the
full contract. Read top to bottom the first time; after that, jump to the owning page a cross-link
points you at.

## Conventions

- **Paths and keys** are written as the product uses them (`~/.veyyon/profiles/default/agent/config.yml`, `tools.approvalMode`).
- **Prior art** is named with license when a technique is adapted; see [Acknowledgements](../acknowledgements.md).
- **Measurements** state the source (this project’s benchmarks vs third-party). If a number has no method, it does not belong in reference material.
