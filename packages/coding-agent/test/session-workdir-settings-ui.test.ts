import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getUi, SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingDef, getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";

describe("session.workdir settings UI", () => {
	it("exposes string type with tab/group/label for the settings UI", () => {
		const definition = SETTINGS_SCHEMA["session.workdir"];
		expect(definition).toBeDefined();
		expect(definition.type).toBe("string");

		const ui = getUi("session.workdir");
		expect(ui).toBeDefined();
		expect(ui?.tab).toBe("interaction");
		expect(ui?.group).toBe("Profile");
		expect(ui?.label).toBe("Default Working Directory");
		expect(typeof ui?.description).toBe("string");
		expect((ui?.description ?? "").length).toBeGreaterThan(0);
	});

	// WHY: the schema-block test above passes even if the setting is invisible in the
	// actual rendered settings screen, because the screen is not built from the schema
	// directly — it is built by `pathToSettingDef` / `getSettingDef`, and the selector's
	// item switch (`#defToItem`) has NO explicit "string" case. A schema `"string"`
	// setting reaches an editable control ONLY via the string->"text" mapping in
	// settings-defs. If that mapping (or this path's handling) regressed, `session.workdir`
	// would silently drop out of the UI while the schema still looked correct — which is
	// exactly the "cant even be set in settings" failure. This pins the rendered control.
	it("surfaces as an editable text control, not silently dropped by the string->UI mapping", () => {
		const def = getSettingDef("session.workdir");
		expect(def).toBeDefined();
		if (!def) throw new Error("session.workdir produced no settings-UI definition");
		expect(def.type).toBe("text");
		expect(def.tab).toBe("interaction");
		expect(def.group).toBe("Profile");
		expect(def.label).toBe("Default Working Directory");
	});

	// WHY: resolvable-by-exact-path is weaker than reachable-in-the-tab. A user opens the
	// Interaction tab and scans its groups; this proves `session.workdir` is actually in
	// that tab's rendered list under the "Profile" group heading, not merely addressable.
	it("appears in the Interaction tab's rendered setting list under the Profile group", () => {
		const interactionDefs = getSettingsForTab("interaction");
		const workdir = interactionDefs.find(d => d.path === "session.workdir");
		expect(workdir).toBeDefined();
		expect(workdir?.group).toBe("Profile");
	});
});

describe("session.workdir is settable through the settings layer", () => {
	// WHY: the core of the user report is "cant even be set". This proves the settings
	// layer accepts, stores, and returns the value — the same `set`/`get` the settings
	// screen's text-input persist path uses. Default-unset returns nothing, preserving
	// today's launch-from-current-directory behavior when the setting is left blank.
	it("defaults to unset so launch falls back to the current directory", () => {
		const settings = Settings.isolated();
		expect(settings.get("session.workdir")).toBeUndefined();
	});

	it("accepts and returns a set value (set -> get round-trip)", () => {
		const settings = Settings.isolated();
		settings.set("session.workdir", "/work/project");
		expect(settings.get("session.workdir")).toBe("/work/project");
	});

	it("honors a value provided as a starting override", () => {
		const settings = Settings.isolated({ "session.workdir": "/work/other" });
		expect(settings.get("session.workdir")).toBe("/work/other");
	});

	it("clears back to empty when a previously set value is set to an empty string", () => {
		const settings = Settings.isolated();
		settings.set("session.workdir", "/work/project");
		settings.set("session.workdir", "");
		// applySessionWorkdir treats an empty (or whitespace) value as "no workdir"
		// via `settings.get(...)?.trim()`, so clearing to "" restores launch-from-cwd.
		expect(settings.get("session.workdir")).toBe("");
	});

	// WHY: the strongest rebuttal of "cant even be set". This drives the REAL persist
	// path a live settings screen uses (not an in-memory isolated instance): a
	// persisting Settings.init writes the value to the profile config.yml on flush,
	// and a fresh Settings.init from the same agent dir reads it back verbatim. If the
	// value did not survive a restart the setting would feel un-settable even though the
	// in-memory set worked, so this locks set -> flush -> reload against the on-disk file.
	it("persists to the profile config and reloads across a fresh Settings.init", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-workdir-"));
		try {
			const first = await Settings.init({ agentDir: dir });
			first.set("session.workdir", "/work/reload-me");
			await first.flush();

			// The value is a real line in the profile config file, not just memory.
			const configYml = await fs.readFile(path.join(dir, "config.yml"), "utf8");
			expect(configYml).toContain("workdir: /work/reload-me");

			const reopened = await Settings.init({ agentDir: dir });
			expect(reopened.get("session.workdir")).toBe("/work/reload-me");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
