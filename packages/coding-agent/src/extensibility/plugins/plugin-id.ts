/** Plugin identity: the single owner of plugin/marketplace name-segment validation and `"name@marketplace"` ID parsing. */

/** A single name segment: lowercase alnum, interior dots/hyphens, no leading/trailing separator. */
const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Maximum length of one name segment (plugin name or marketplace name). */
const MAX_NAME_LENGTH = 64;

/** Maximum length of a full `"name@marketplace"` ID. */
const MAX_ID_LENGTH = 128;

/** Validate a plugin or marketplace name segment. */
export function isValidNameSegment(s: string): boolean {
	return s.length > 0 && s.length <= MAX_NAME_LENGTH && NAME_RE.test(s);
}

/** Build canonical plugin ID: `"name@marketplace"`. Both segments are validated. */
export function buildPluginId(name: string, marketplace: string): string {
	if (!isValidNameSegment(name)) {
		throw new Error(`Invalid plugin name: "${name}"`);
	}
	if (!isValidNameSegment(marketplace)) {
		throw new Error(`Invalid marketplace name: "${marketplace}"`);
	}
	const id = `${name}@${marketplace}`;
	if (id.length > MAX_ID_LENGTH) {
		throw new Error(`Plugin ID exceeds ${MAX_ID_LENGTH} characters: "${id}"`);
	}
	return id;
}

/** Parse `"name@marketplace"` → `{ name, marketplace }` or `null`. */
export function parsePluginId(id: string): { name: string; marketplace: string } | null {
	const atIndex = id.lastIndexOf("@");
	if (atIndex <= 0 || atIndex === id.length - 1) return null;

	const name = id.slice(0, atIndex);
	const marketplace = id.slice(atIndex + 1);

	if (!isValidNameSegment(name) || !isValidNameSegment(marketplace)) return null;

	return { name, marketplace };
}
