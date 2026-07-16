/**
 * SETTINGS_SCHEMA is composed by spreading the nine settings-domains slices.
 * Unlike the former single object literal (where TypeScript hard-errors on a
 * duplicate key), a key defined in two domain files would silently last-write
 * win in the spread. This guard makes that collision a loud test failure.
 */
import { describe, expect, it } from "bun:test";
import { APPEARANCE_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/appearance";
import { CONTEXT_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/context";
import { EDITING_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/editing";
import { GENERAL_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/general";
import { INTERACTION_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/interaction";
import { MODEL_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/model";
import { PROVIDERS_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/providers";
import { TASKS_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/tasks";
import { TOOLS_SETTINGS } from "@veyyon/pi-coding-agent/config/settings-domains/tools";
import { SETTINGS_SCHEMA } from "@veyyon/pi-coding-agent/config/settings-schema";

const DOMAINS: Record<string, Record<string, unknown>> = {
	general: GENERAL_SETTINGS,
	appearance: APPEARANCE_SETTINGS,
	model: MODEL_SETTINGS,
	interaction: INTERACTION_SETTINGS,
	context: CONTEXT_SETTINGS,
	editing: EDITING_SETTINGS,
	tools: TOOLS_SETTINGS,
	tasks: TASKS_SETTINGS,
	providers: PROVIDERS_SETTINGS,
};

describe("SETTINGS_SCHEMA domain composition", () => {
	it("no setting path is defined in two domain slices", () => {
		const owners = new Map<string, string>();
		const collisions: string[] = [];
		for (const [domain, slice] of Object.entries(DOMAINS)) {
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
