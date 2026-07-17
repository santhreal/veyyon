# Tools, skills, and extension data

Veyyon does real work through tools, and you can extend what it knows and what it can reach. This page
covers the built in tools, skills, extension data, and external tools through the Model Context Protocol.

## Tools

Tools are the actions Veyyon can take: reading a file, searching the tree, editing code, running a
command, fetching a page, and more. Every tool runs through the same approval model, so a
tool cannot exceed the boundary you set. Editing tools in particular all flow through one verified write
path, so a change is checked and recorded the same way no matter which tool made it.

## Skills

Skills are reusable capabilities Veyyon can draw on, defined as data rather than baked into the binary.
Because a skill is data, you can add a skill by dropping in a file, and you can share a skill with
others. Veyyon validates a skill when it loads and tells you clearly if a skill needs a tool that is not
available, rather than failing in a way you cannot diagnose.

## Plugin bundles

Plugin bundles are the package shape for larger extension sets. Treat plugin installation as available
only when your `veyyon` build exposes the matching install, list, and remove commands. Until then, use
skills and MCP servers for local extension, because those are the shipped operator paths documented on
this page.

## External tools through the Model Context Protocol

Veyyon speaks the Model Context Protocol, so it can use tools served by an external server and can serve
its own tools to other clients. This lets you connect Veyyon to the wider ecosystem of context servers
without custom integration work. An external server is added as data, and its tools appear to the model
exactly where you intend.

## The principle behind extension

Everything here follows one principle: capability grows through data and through a clear boundary, never
through a hidden hardcoded list and never past the safety boundary you set. You can always see what
Veyyon can do, and you can always extend it without editing code.

## Where to go next

- [Configuration](./configuration.md) covers the approval mode that gates every tool.
- [What makes Veyyon different](../why/innovations.md) explains the one write path that every editing
  tool shares.
