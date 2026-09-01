/**
 * A second host for the view contract.
 *
 * `hosts/terminal` draws a `ToolView` as rows of escape bytes; this draws the same models as HTML.
 * The two share no code, and a plugin that returns a view reaches both without a line of its own
 * changing, which is what makes `contracts/view` a contract rather than a description of the
 * terminal.
 *
 * The package depends on `@veyyon/view` and on a Markdown renderer, and on nothing else in this
 * repository: no kernel, no tool, no agent, no settings. A host that needed any of them would be
 * proving the opposite of what it exists to prove.
 */

export * from "./draw-tool-view";
export * from "./html";
export * from "./tokens";
