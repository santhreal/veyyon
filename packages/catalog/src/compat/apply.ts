/**
 * Assign defined override values onto a freshly-built resolved compat record,
 * in place. Keys the record doesn't declare are ignored (loosely-typed config
 * may carry junk). `buildModel` is the only intended caller — the record being
 * mutated is the single per-model allocation; nothing here runs per request.
 *
 * Both the override iteration and the "does the record declare this key" guard
 * use OWN-property checks, never `in`/`for...in` inheritance. `key in compat` is
 * true for every `Object.prototype` member (`toString`, `constructor`,
 * `valueOf`, `hasOwnProperty`, …), so a config override literally named
 * `toString` would otherwise pass the guard and overwrite the record's inherited
 * method — corrupting the record with a value the record never declared, the
 * exact opposite of the "keys the record doesn't declare are ignored" contract.
 * `Object.hasOwn` matches that contract: the fresh compat record is a plain
 * object literal, so its real fields are all own properties and legitimate
 * overrides are unaffected.
 */
export function applyCompatOverrides(compat: object, overrides: object | undefined): void {
	if (!overrides) return;
	for (const key of Object.keys(overrides)) {
		const value = (overrides as Record<string, unknown>)[key];
		if (value !== undefined && Object.hasOwn(compat, key)) {
			(compat as Record<string, unknown>)[key] = value;
		}
	}
}
