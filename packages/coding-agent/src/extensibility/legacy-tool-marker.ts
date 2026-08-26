/**
 * The property the legacy shim stamps on a tool it has already converted. Stamper + detector in two
 * modules; drift would double-convert and scramble argument order. The sdk's own marker is a `Symbol`
 * (can't collide with user properties); both are checked to avoid double-converting either kind.
 */

/** Set on a tool the legacy shim has already turned into a `ToolDefinition`. */
export const LEGACY_TOOL_DEFINITION_MARKER = "__isToolDefinition";
