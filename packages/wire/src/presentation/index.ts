/**
 * The presentation contract: what a session tells a renderer to draw, and what
 * the renderer reports back.
 *
 * Nothing here depends on the agent runtime, on a terminal, or on a browser.
 * A renderer that implements {@link PresentationContext} can draw a session
 * without importing coding-agent, which is the same reason the collab wire
 * types live in this package.
 */

export * from "./composer";
export * from "./context";
export * from "./events";
export * from "./overlay";
export * from "./status";
export * from "./theme";
export * from "./transcript";
