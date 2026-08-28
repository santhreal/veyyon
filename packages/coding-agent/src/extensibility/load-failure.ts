/** The sentences every extensibility load failure says. extension modules, custom tools and custom commands -- and each had written */

/** The four artifact kinds, spelled as they are named to an operator. Used both as the singular noun and, with an `s`, as the plural, so the wording stays */
export type ExtensibilityArtifact = "extension" | "hook" | "custom command" | "custom tool";

/** How each kind names the object its factory must return or register. */
const FACTORY_HINT: Record<ExtensibilityArtifact, string> = {
	extension: "export default (api) => { api.on(...) }",
	hook: "export default (api) => { api.on(...) }",
	"custom command": "export default (api) => ({ name, description, execute })",
	"custom tool": "export default (api) => ({ name, description, parameters, execute })",
};

/** Importing the file threw. The cause is whatever the runtime said, which is usually a `SyntaxError` or a failed import of a dependency the artifact */
export function moduleImportFailedMessage(kind: ExtensibilityArtifact, cause: string): string {
	return (
		`Importing this ${kind} threw, so it is not active in this run: ${cause}. ` +
		`Fix: correct that file, then start a new veyyon session, because ${kind}s are imported once at startup.`
	);
}

/** The module imported cleanly and exports no callable default. Every loader calls the default export with its API object, so a file exporting named */
export function factoryExportMissingMessage(kind: ExtensibilityArtifact): string {
	return (
		`This ${kind} has no default export that is a function, so it is not active in this run. ` +
		`Fix: give the file one that takes the ${kind} API and registers on it ` +
		`(\`${FACTORY_HINT[kind]}\`), then start a new veyyon session.`
	);
}

/** Two artifacts claim one name. `owner` names what already holds it when that is known -- a built-in, or another file -- because "conflicts with existing tool" */
export function nameConflictMessage(kind: ExtensibilityArtifact, name: string, owner: string): string {
	return (
		`The name "${name}" is already taken by ${owner}, so this ${kind} is not active in this run. ` +
		`Fix: rename it in its own source, or delete whichever of the two you do not want, ` +
		`then start a new veyyon session.`
	);
}

/** A required field on the object the factory returned is missing or the wrong type. `field` is the property name as the author writes it; `requirement` */
export function invalidArtifactFieldMessage(kind: ExtensibilityArtifact, field: string, requirement: string): string {
	return (
		`This ${kind} has no usable \`${field}\`, so it is not active in this run: ${requirement}. ` +
		`Fix: set \`${field}\` on the object the default export returns, then start a new veyyon session.`
	);
}
