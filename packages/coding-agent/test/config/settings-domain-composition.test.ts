/**
 * SETTINGS_SCHEMA is composed by spreading the settings-domains slices.
 * Unlike the former single object literal (where TypeScript hard-errors on a
 * duplicate key), a key defined in two domain files would silently last-write
 * win in the spread. This guard makes that collision a loud test failure.
 *
 * The slice list comes from `SETTINGS_DOMAIN_SLICES`, which sits beside the spread
 * itself. It used to be retyped here, and when the Subagents domain was added the
 * copy was not updated: the guard kept passing while covering one slice less than
 * the schema actually had.
 */
import { describe, expect, it } from "bun:test";
import { SETTINGS_DOMAIN_SLICES, SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";

describe("SETTINGS_SCHEMA domain composition", () => {
	it("no setting path is defined in two domain slices", () => {
		const owners = new Map<string, string>();
		const collisions: string[] = [];
		for (const [domain, slice] of Object.entries(SETTINGS_DOMAIN_SLICES)) {
			for (const path of Object.keys(slice)) {
				const owner = owners.get(path);
				if (owner) collisions.push(`${path} (in ${owner} and ${domain})`);
				owners.set(path, domain);
			}
		}
		expect(collisions).toEqual([]);
		// The spread lost nothing: the composed schema holds every domain key.
		expect(Object.keys(SETTINGS_SCHEMA).length).toBe(owners.size);
	});
});
