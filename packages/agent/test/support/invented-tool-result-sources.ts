import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PACKAGES_DIR } from "../../../utils/test/support/package-sources";

/**
 * Read the variant spaces of the loop's invented tool results out of the source,
 * at run time.
 *
 * A hardcoded list of skip reasons goes stale the day someone adds one, and it goes
 * stale in silence: the suite stays green and the new member is exactly the one
 * nobody thought about. Deriving the union from the declaration means a new member
 * has nowhere to hide, because the test that enumerates decisions is comparing
 * against the declaration itself.
 */

const LOOP = "agent/src/agent-loop.ts";
const TYPES = "agent/src/types.ts";

/** `agent-loop.ts` with comments removed, so prose cannot supply a union member. */
export async function loopSource(): Promise<string> {
	const text = await fs.readFile(path.join(PACKAGES_DIR, LOOP), "utf8");
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The type expression a named field or parameter is declared with.
 *
 * Handles the two shapes this file uses: an interface property (`source: ...;`) and
 * a function parameter (`reason: ...,`). Both terminate at the first delimiter that
 * is not inside a nested bracket, which is enough because neither carries an object
 * or generic type.
 */
function declaredType(source: string, owner: string, field: string): string {
	const ownerAt = source.search(new RegExp(`(?:interface|function)\\s+${owner}\\b`));
	if (ownerAt === -1) throw new Error(`${owner} not found in ${LOOP} (renamed?)`);
	const fieldAt = source.indexOf(`${field}:`, ownerAt);
	if (fieldAt === -1) throw new Error(`${owner}.${field} not found in ${LOOP} (renamed?)`);
	const from = fieldAt + field.length + 1;
	let depth = 0;
	for (let i = from; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
		else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
			if (depth === 0) return source.slice(from, i);
			depth--;
		} else if (depth === 0 && (ch === ";" || ch === ",")) {
			return source.slice(from, i);
		}
	}
	throw new Error(`could not delimit the type of ${owner}.${field}`);
}

/** String-literal members of an aliased union declared in `agent/src/types.ts`. */
async function aliasMembers(alias: string): Promise<string[]> {
	const text = await fs.readFile(path.join(PACKAGES_DIR, TYPES), "utf8");
	const declaration = new RegExp(`export type ${alias}\\s*=([^;]+);`).exec(text);
	if (!declaration) throw new Error(`${alias} is not an exported type alias in ${TYPES}`);
	return [...declaration[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

/**
 * Every string-literal member of `owner.field`, with any referenced union alias
 * expanded.
 *
 * Throws rather than returning a short list when a reference cannot be resolved: a
 * silently truncated union is precisely the failure this exists to prevent.
 */
export async function unionMembers(source: string, owner: string, field: string): Promise<string[]> {
	const declared = declaredType(source, owner, field);
	const members = [...declared.matchAll(/"([^"]+)"/g)].map(m => m[1]);
	for (const reference of declared.matchAll(/\b([A-Z][\w$]*)\b/g)) {
		members.push(...(await aliasMembers(reference[1])));
	}
	if (members.length === 0) throw new Error(`${owner}.${field} declares no string members`);
	return [...new Set(members)];
}
