/**
 * What a plugin renderer hands back for the active host to draw.
 *
 * The core plugin contract cannot name a host's node type, because there is more
 * than one host and they do not share one. The terminal draws a `@veyyon/tui`
 * `Component`; the HTML export, the collab web client and the stats dashboard
 * draw React through `@veyyon/tool-render`. A contract that names either one
 * makes every plugin written against it a plugin for that host.
 *
 * A renderer written for a specific host still satisfies this: a function
 * returning `Component` is assignable to one returning `HostView`, because
 * return position is covariant. The narrowing happens once, in the host, at the
 * point where it actually draws.
 *
 * This is deliberately not a union of the known host node types. A union would
 * have to grow every time a host is added, which is the coupling it is meant to
 * remove, and it would let the core inspect a node it has no business reading.
 */
export type HostView = unknown;
