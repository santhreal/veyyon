/**
 * The sentences every extensibility load failure says.
 *
 * WHY THIS MODULE EXISTS. Four loaders fail the same four ways -- hooks,
 * extension modules, custom tools and custom commands -- and each had written
 * its own text for each way. The result was `Failed to load hook: <cause>`,
 * `Failed to load tool: <cause>`, `Failed to load command: <cause>` and
 * `Failed to load extension: <cause>`: four spellings of one sentence, none of
 * which named what the operator should do about it. A plugin, hook or custom
 * tool that fails to load is invisible by nature -- the thing you installed
 * simply does not appear -- so a message that names the failure and no remedy
 * leaves the operator with a file on disk and no next move.
 *
 * WHAT EVERY SENTENCE HERE STATES, in this order:
 *   1. WHAT was wrong.
 *   2. The EFFECT, always spelled out as "is not active in this run", because
 *      the operator's actual symptom is absence and nothing else says so.
 *   3. The FIX, an action the reader can perform.
 *
 * WHY NO PATH IS INTERPOLATED HERE. Every consumer already pairs the returned
 * string with the artifact path: `logger.error(..., { path, error })`,
 * `operatorNotices.error("extensions", `${path}: ${error}`)`, and
 * `models-cli.ts` writing `${extPath}: ${error}` to stderr. Repeating the path
 * inside the sentence produced exactly the doubling this module removes --
 * `Failed to load extension: /p/x.ts: Failed to load extension: SyntaxError`
 * was what `veyyon models` printed. The path belongs to the caller; the
 * diagnosis and the remedy belong here.
 */

/**
 * The four artifact kinds, spelled as they are named to an operator. Used both
 * as the singular noun and, with an `s`, as the plural, so the wording stays
 * one substitution rather than a table.
 */
export type ExtensibilityArtifact = "extension" | "hook" | "custom command" | "custom tool";

/** How each kind names the object its factory must return or register. */
const FACTORY_HINT: Record<ExtensibilityArtifact, string> = {
	extension: "export default (api) => { api.on(...) }",
	hook: "export default (api) => { api.on(...) }",
	"custom command": "export default (api) => ({ name, description, execute })",
	"custom tool": "export default (api) => ({ name, description, parameters, execute })",
};

/**
 * Importing the file threw. The cause is whatever the runtime said, which is
 * usually a `SyntaxError` or a failed import of a dependency the artifact
 * assumed was resolvable from the directory it lives in.
 */
export function moduleImportFailedMessage(kind: ExtensibilityArtifact, cause: string): string {
	return (
		`Importing this ${kind} threw, so it is not active in this run: ${cause}. ` +
		`Fix: correct that file, then start a new veyyon session, because ${kind}s are imported once at startup.`
	);
}

/**
 * The module imported cleanly and exports no callable default. Every loader
 * calls the default export with its API object, so a file exporting named
 * functions only registers nothing and reports nothing without this.
 */
export function factoryExportMissingMessage(kind: ExtensibilityArtifact): string {
	return (
		`This ${kind} has no default export that is a function, so it is not active in this run. ` +
		`Fix: give the file one that takes the ${kind} API and registers on it ` +
		`(\`${FACTORY_HINT[kind]}\`), then start a new veyyon session.`
	);
}

/**
 * Two artifacts claim one name. `owner` names what already holds it when that is
 * known -- a built-in, or another file -- because "conflicts with existing tool"
 * did not say whether the operator was fighting veyyon or their own second copy.
 */
export function nameConflictMessage(kind: ExtensibilityArtifact, name: string, owner: string): string {
	return (
		`The name "${name}" is already taken by ${owner}, so this ${kind} is not active in this run. ` +
		`Fix: rename it in its own source, or delete whichever of the two you do not want, ` +
		`then start a new veyyon session.`
	);
}

/**
 * A required field on the object the factory returned is missing or the wrong
 * type. `field` is the property name as the author writes it; `requirement`
 * says what it has to be, in the author's terms rather than a type name.
 */
export function invalidArtifactFieldMessage(kind: ExtensibilityArtifact, field: string, requirement: string): string {
	return (
		`This ${kind} has no usable \`${field}\`, so it is not active in this run: ${requirement}. ` +
		`Fix: set \`${field}\` on the object the default export returns, then start a new veyyon session.`
	);
}
