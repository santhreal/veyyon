/**
 * Builds the view-models a renderer draws from the session's own state.
 *
 * Everything here is a reduction: session facts in, `@veyyon/wire/presentation`
 * types out. Nothing in this directory imports `@veyyon/tui` or any other
 * renderer, which is what lets the terminal driver and a browser client consume
 * the same output.
 */

export * from "./composer-builder";
export * from "./event-bridge";
export * from "./overlay-builder";
export * from "./status-builder";
export * from "./transcript-builder";
