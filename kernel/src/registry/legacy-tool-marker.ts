/**
 * The property the legacy-pi-coding-agent shim stamps on a tool it has already converted.
 *
 * A stamper and a detector in two different modules: `legacy-pi-coding-agent-shim.ts` defines the property on
 * each tool it converts, and `sdk.ts` reads it to decide whether a tool still needs converting. Each declared
 * its own copy of the string, and the shape of the failure if they drifted is written into `sdk.ts` beside the
 * check: an already-converted tool that looks unconverted gets converted twice, which scrambles the order of
 * the arguments `execute()` receives. Nothing throws, and the tool simply misbehaves.
 *
 * The sdk's own marker is a `Symbol`, not this string, and that distinction is deliberate: a symbol cannot
 * collide with a user's property, so tools converted by the sdk carry the symbol and only tools that came
 * through the legacy shim carry this. Both are checked, because checking one would double-convert the other
 * kind.
 */

/** Set on a tool the legacy shim has already turned into a `ToolDefinition`. */
export const LEGACY_TOOL_DEFINITION_MARKER = "__isToolDefinition";
