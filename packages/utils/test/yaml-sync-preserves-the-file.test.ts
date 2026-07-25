/**
 * What a settings save is allowed to change in the user's file, and what it must not.
 *
 * `config.yml` is a file people edit by hand. Saving a setting used to re-serialize the
 * whole settings object with `YAML.stringify`, which produces a semantically identical file
 * and silently discards everything that is not a value: the comments they wrote, the blank
 * lines they grouped keys with, the quoting they chose, and the order they arranged things
 * in. Changing one setting from the UI deleted the comment at the top of their config, and
 * every existing settings test passed, because all of them compared VALUES.
 *
 * `syncYamlTextToSettings` is the one writer now, and these tests hold it to the rule: the
 * target object decides the CONTENT, the existing file decides the FORM. Assertions are on
 * exact output text, because "the comment is still there somewhere" is not the contract —
 * the contract is that the bytes around the change are untouched.
 */
import { describe, expect, it } from "bun:test";
import { syncYamlTextToSettings } from "@veyyon/utils/yaml-sync";
import * as YAML from "yaml";

describe("what the file keeps", () => {
	it("keeps a leading comment when a value changes", () => {
		// THE regression. This comment is the first thing the user sees in their config
		// and it vanished the first time they changed a setting in the UI.
		const before = "# A comment a user wrote\ntemperature: 0.7\n";
		expect(syncYamlTextToSettings(before, { temperature: 0.9 })).toBe("# A comment a user wrote\ntemperature: 0.9\n");
	});

	it("keeps a comment attached to the key being changed", () => {
		const before = "temperature: 0.7 # tuned for my hardware\ntopK: 40\n";
		expect(syncYamlTextToSettings(before, { temperature: 0.9, topK: 40 })).toBe(
			"temperature: 0.9 # tuned for my hardware\ntopK: 40\n",
		);
	});

	it("keeps blank lines the user used to group keys", () => {
		const before = "temperature: 0.7\n\n# search\ntopK: 40\n";
		expect(syncYamlTextToSettings(before, { temperature: 0.7, topK: 60 })).toBe(
			"temperature: 0.7\n\n# search\ntopK: 60\n",
		);
	});

	it("keeps the user's key order and appends a new key at the end", () => {
		// Not alphabetical, not the object's insertion order: THEIR order. A save that
		// reorders the file makes every diff in a dotfiles repo unreadable.
		const before = "topK: 40\ntemperature: 0.7\n";
		const after = syncYamlTextToSettings(before, { temperature: 0.7, topK: 40, topP: 0.9 });
		expect(after).toBe("topK: 40\ntemperature: 0.7\ntopP: 0.9\n");
	});

	it("keeps quoting the user chose on values it is not changing", () => {
		const before = "theme:\n  dark: 'titanium'\ntemperature: 0.7\n";
		expect(syncYamlTextToSettings(before, { theme: { dark: "titanium" }, temperature: 0.9 })).toBe(
			"theme:\n  dark: 'titanium'\ntemperature: 0.9\n",
		);
	});

	it("keeps a credential in a nested block byte-identical", () => {
		// A re-serialization that re-quotes or re-indents a secret is how a working MCP
		// server stops working after an update.
		const before = [
			"mcpServers:",
			"  paid-api:",
			"    command: node",
			"    env:",
			"      API_TOKEN: sk-live-do-not-touch-me",
			"temperature: 0.7",
			"",
		].join("\n");
		const after = syncYamlTextToSettings(before, {
			mcpServers: { "paid-api": { command: "node", env: { API_TOKEN: "sk-live-do-not-touch-me" } } },
			temperature: 0.9,
		});
		expect(after).toContain("      API_TOKEN: sk-live-do-not-touch-me");
		expect(after).toBe(before.replace("temperature: 0.7", "temperature: 0.9"));
	});

	it("keeps a sequence's formatting when its contents are unchanged", () => {
		const before = "mcpServers:\n  api:\n    args:\n      - server.js\n      - --port=1\ntopK: 40\n";
		const after = syncYamlTextToSettings(before, {
			mcpServers: { api: { args: ["server.js", "--port=1"] } },
			topK: 60,
		});
		expect(after).toBe(before.replace("topK: 40", "topK: 60"));
	});

	it("keeps a block scalar the user wrote", () => {
		const before = "systemPrompt: |\n  line one\n  line two\ntopK: 40\n";
		const after = syncYamlTextToSettings(before, { systemPrompt: "line one\nline two\n", topK: 60 });
		expect(after).toBe(before.replace("topK: 40", "topK: 60"));
	});

	it("changes nothing at all when the target matches the file", () => {
		// An idle save must be a no-op on disk. Anything else means every launch
		// rewrites the user's config for no reason.
		const before = "# mine\ntemperature: 0.7\n\ntheme:\n  dark: 'titanium'\n";
		expect(syncYamlTextToSettings(before, { temperature: 0.7, theme: { dark: "titanium" } })).toBe(before);
	});
});

describe("what the target decides", () => {
	it("writes a new nested key, creating the block it lives in", () => {
		expect(
			syncYamlTextToSettings("temperature: 0.7\n", { temperature: 0.7, display: { showTokenUsage: true } }),
		).toBe("temperature: 0.7\ndisplay:\n  showTokenUsage: true\n");
	});

	it("removes a key the target no longer has", () => {
		// This is how a reset reaches the file: the setting is absent from the object,
		// so its line has to go, and the keys around it stay put.
		const before = "# mine\ntemperature: 0.7\ntopK: 40\n";
		expect(syncYamlTextToSettings(before, { topK: 40 })).toBe("# mine\ntopK: 40\n");
	});

	it("carries a comment off a removed key instead of deleting it with the key", () => {
		// A comment sits on the node it precedes, so deleting the first key of a file
		// deleted the header comment above it: resetting one setting silently ate the
		// top of the user's config. A comment in a slightly different place is
		// recoverable; a deleted one is not.
		const before = "# my whole config\ntemperature: 0.7\n# search depth\ntopK: 40\n";
		const after = syncYamlTextToSettings(before, { topK: 40 });
		expect(after).toBe("# my whole config\n# search depth\ntopK: 40\n");
	});

	it("keeps a removed last key's comment as a trailing document comment", () => {
		// Nothing follows it, so there is no sibling to carry it to. It goes to the end
		// of the file rather than being dropped.
		const before = "topK: 40\n# only mattered for temperature\ntemperature: 0.7\n";
		const after = syncYamlTextToSettings(before, { topK: 40 });
		expect(after).toContain("# only mattered for temperature");
		expect(after).not.toContain("temperature: 0.7");
	});

	it("treats an undefined value as a removal, not as a null", () => {
		// `getByPath` answers `undefined` for a reset setting. Writing `key: null`
		// instead of removing the key would leave a value that overrides the default.
		const before = "temperature: 0.7\ntopK: 40\n";
		const after = syncYamlTextToSettings(before, { temperature: undefined, topK: 40 });
		expect(after).toBe("topK: 40\n");
		expect(after).not.toContain("null");
	});

	it("removes a nested key without removing its parent block", () => {
		const before = "display:\n  showTokenUsage: true\n  cacheMissMarker: true\n";
		expect(syncYamlTextToSettings(before, { display: { showTokenUsage: true } })).toBe(
			"display:\n  showTokenUsage: true\n",
		);
	});

	it("replaces a scalar with a block when the target's shape changed", () => {
		const after = syncYamlTextToSettings("theme: titanium\n", { theme: { dark: "titanium" } });
		expect(YAML.parse(after)).toEqual({ theme: { dark: "titanium" } });
	});

	it("replaces a sequence wholesale rather than merging into it", () => {
		// A list is a value. Merging would leave an entry the user removed.
		const after = syncYamlTextToSettings("tools:\n  - read\n  - write\n", { tools: ["read"] });
		expect(YAML.parse(after)).toEqual({ tools: ["read"] });
	});

	it("writes null when the target really is null", () => {
		const after = syncYamlTextToSettings("temperature: 0.7\n", { temperature: null });
		expect(after).toBe("temperature: null\n");
		expect(YAML.parse(after)).toEqual({ temperature: null });
	});

	it("starts a fresh document from an empty or comments-only file", () => {
		expect(syncYamlTextToSettings("", { temperature: 0.7 })).toBe("temperature: 0.7\n");
		expect(syncYamlTextToSettings("   \n", { temperature: 0.7 })).toBe("temperature: 0.7\n");
		// A comments-only file is a real file the user wrote: its comment survives. The
		// blank line is how YAML separates a DOCUMENT-level comment (which is what a
		// comment with no node under it is) from the body, and it is the price of not
		// dropping the line.
		expect(syncYamlTextToSettings("# nothing set yet\n", { temperature: 0.7 })).toBe(
			"# nothing set yet\n\ntemperature: 0.7\n",
		);
	});

	it("writes an empty document for an empty target", () => {
		expect(YAML.parse(syncYamlTextToSettings("", {}))).toEqual({});
	});
});

describe("what it refuses to overwrite", () => {
	it("refuses a file that does not parse, naming the parse error", () => {
		// The one case where the file is unreadable to us AND overwriting destroys
		// something we cannot reconstruct. The caller's retry path is the honest answer
		// (Law 10: fail closed, never a fallback that clobbers).
		expect(() => syncYamlTextToSettings("temperature: 0.7\n  bad: indent\n", { temperature: 0.9 })).toThrow(
			/does not parse/,
		);
	});

	it("refuses a file whose root is a sequence", () => {
		expect(() => syncYamlTextToSettings("- one\n- two\n", { temperature: 0.9 })).toThrow(/not a YAML mapping/);
	});

	it("refuses a file whose root is a bare scalar", () => {
		expect(() => syncYamlTextToSettings("just a string\n", { temperature: 0.9 })).toThrow(/not a YAML mapping/);
	});

	it("leaves the input string untouched when it refuses", () => {
		// The caller keeps the text to report; a mutation here would corrupt the
		// message about the corruption.
		const before = "- one\n";
		expect(() => syncYamlTextToSettings(before, {})).toThrow();
		expect(before).toBe("- one\n");
	});
});

describe("a sequence with comments inside it", () => {
	/**
	 * A changed sequence used to be replaced wholesale, which took every comment inside it.
	 * `WATCHDOG.yml` is a list of advisors with a comment above each one saying what it is
	 * for, so changing one advisor's model deleted the notes on all of them. Entries are
	 * matched by position now and only the changed entry is touched.
	 */
	it("changes one entry and leaves the comments on the others", () => {
		const text = [
			"advisors:",
			"  # boundaries",
			"  - name: Architecture",
			"    model: old/model",
			"  # the paranoid one",
			"  - name: Security",
			"",
		].join("\n");

		const written = syncYamlTextToSettings(text, {
			advisors: [{ name: "Architecture", model: "new/model" }, { name: "Security" }],
		});

		expect(written).toBe(
			[
				"advisors:",
				"  # boundaries",
				"  - name: Architecture",
				"    model: new/model",
				"  # the paranoid one",
				"  - name: Security",
				"",
			].join("\n"),
		);
	});

	it("leaves a sequence of scalars alone when only one element changed", () => {
		const text = ["tools:", "  # the safe three", "  - read", "  - grep", "  - glob", ""].join("\n");

		const written = syncYamlTextToSettings(text, { tools: ["read", "bash", "glob"] });

		expect(written).toBe(["tools:", "  # the safe three", "  - read", "  - bash", "  - glob", ""].join("\n"));
	});

	it("replaces a sequence wholesale when its length changed", () => {
		// Position is the only correspondence a list carries, so a different length has no
		// honest pairing. Documented behaviour, pinned so it cannot change by accident.
		const text = ["tools:", "  # the safe three", "  - read", "  - grep", ""].join("\n");

		const written = syncYamlTextToSettings(text, { tools: ["read"] });

		expect(YAML.parse(written)).toEqual({ tools: ["read"] });
	});

	it("recurses into a nested sequence inside a sequence entry", () => {
		const text = [
			"advisors:",
			"  - name: Security",
			"    tools:",
			"      # only reads",
			"      - read",
			"      - grep",
			"",
		].join("\n");

		const written = syncYamlTextToSettings(text, {
			advisors: [{ name: "Security", tools: ["read", "glob"] }],
		});

		expect(written).toContain("# only reads");
		expect(written).toContain("- glob");
		expect(written).not.toContain("- grep");
	});

	it("leaves an unchanged sequence byte-identical", () => {
		const text = ["advisors:", "  # mine", "  - name: Security", "    tools:", "      - read", ""].join("\n");

		expect(syncYamlTextToSettings(text, { advisors: [{ name: "Security", tools: ["read"] }] })).toBe(text);
	});
});

describe("a key the caller renamed", () => {
	/**
	 * A rename reaches the writer as a deletion plus an addition, which moved the key to the
	 * end of the file and stranded the comment above it. The keybindings name migration
	 * renames EVERY legacy key at once, so a migrated `keybindings.yml` came back with its
	 * keys reversed out of the user's order and every comment collected at the bottom. Told
	 * about the rename, the writer relabels the key in place.
	 */
	it("relabels the key in place, keeping its position and its comment", () => {
		const text = ["# my bindings", "interrupt: ctrl+x", "", "# and this one", "fork: ctrl+f", ""].join("\n");

		const written = syncYamlTextToSettings(
			text,
			{ "app.interrupt": "ctrl+x", "app.session.fork": "ctrl+f" },
			{ renamedKeys: { interrupt: "app.interrupt", fork: "app.session.fork" } },
		);

		expect(written).toBe("# my bindings\napp.interrupt: ctrl+x\n\n# and this one\napp.session.fork: ctrl+f\n");
	});

	it("changes the value at the same time when the target has a new one", () => {
		// Renaming must not shadow the ordinary job of the writer.
		const written = syncYamlTextToSettings(
			"interrupt: ctrl+x\n",
			{ "app.interrupt": "ctrl+g" },
			{
				renamedKeys: { interrupt: "app.interrupt" },
			},
		);

		expect(written).toBe("app.interrupt: ctrl+g\n");
	});

	it("leaves a key alone when the file already has the new name too", () => {
		// Both spellings present: the target decides which survives, and the old one is
		// deleted the usual way. Renaming here would produce a duplicate key.
		const written = syncYamlTextToSettings(
			"interrupt: ctrl+x\napp.interrupt: ctrl+g\n",
			{
				"app.interrupt": "ctrl+g",
			},
			{ renamedKeys: { interrupt: "app.interrupt" } },
		);

		expect(written).toBe("app.interrupt: ctrl+g\n");
	});

	it("ignores renames for keys the file does not have", () => {
		const written = syncYamlTextToSettings(
			"topK: 40\n",
			{ topK: 40 },
			{
				renamedKeys: { interrupt: "app.interrupt" },
			},
		);

		expect(written).toBe("topK: 40\n");
	});

	it("keeps a quoted key quoted after a rename", () => {
		// The quoting is the user's, and a key with dots reads better quoted anyway.
		const written = syncYamlTextToSettings(
			'"interrupt": ctrl+x\n',
			{ "app.interrupt": "ctrl+x" },
			{
				renamedKeys: { interrupt: "app.interrupt" },
			},
		);

		expect(written).toBe('"app.interrupt": ctrl+x\n');
	});

	it("does nothing when no renames are passed, which is every other caller", () => {
		// The negative twin: settings and the global config do not rename anything, so the
		// delete-and-append behaviour has to be exactly what it was.
		const written = syncYamlTextToSettings("interrupt: ctrl+x\n", { "app.interrupt": "ctrl+x" });

		expect(written).toBe("app.interrupt: ctrl+x\n");
	});
});

describe("a deletion that leaves a blank line behind", () => {
	/**
	 * Deleting the first key carried its comment down to the next key, and brought the blank
	 * line that had separated them along for the ride: the file came back starting with an
	 * empty line the user never typed. Found by the keybindings migration, which deletes a
	 * legacy binding name and writes the new one, so every migrated file grew a blank first
	 * line.
	 */
	it("does not leave a blank first line when the first key is removed", () => {
		const text = ["# my bindings", "interrupt: ctrl+x", "", "# leave this one alone", "fork: ctrl+f", ""].join("\n");

		const written = syncYamlTextToSettings(text, { fork: "ctrl+f" });

		expect(written).toBe("# my bindings\n# leave this one alone\nfork: ctrl+f\n");
		expect(written.startsWith("\n")).toBe(false);
	});

	it("keeps a blank-line separator when the key removed was not the first", () => {
		// The negative twin: the blank line above `fork` is the user's grouping and has to
		// survive a deletion elsewhere in the file.
		const text = ["a: 1", "b: 2", "", "# group two", "fork: ctrl+f", ""].join("\n");

		const written = syncYamlTextToSettings(text, { a: 1, fork: "ctrl+f" });

		expect(written).toBe("a: 1\n\n# group two\nfork: ctrl+f\n");
	});

	it("keeps the blank line the user put above the second key when the first survives", () => {
		// Nothing is deleted here at all, so the file must come back untouched.
		const text = ["a: 1", "", "b: 2", ""].join("\n");

		expect(syncYamlTextToSettings(text, { a: 1, b: 2 })).toBe(text);
	});
});

describe("the round trip is a fixed point", () => {
	it("produces the same output when run twice with the same target", () => {
		// A writer that keeps changing the file on every save churns the user's dotfiles
		// repo, and its output is not something a test can assert on.
		const before = "# mine\ntemperature: 0.7\n\ndisplay:\n  showTokenUsage: true\n";
		const target = { temperature: 0.9, display: { showTokenUsage: true }, topP: 0.5 };
		const once = syncYamlTextToSettings(before, target);
		expect(syncYamlTextToSettings(once, target)).toBe(once);
	});

	it("parses back to exactly the target, for a config touching every shape", () => {
		const before = [
			"# a user's file",
			"theme:",
			"  dark: 'titanium'",
			"",
			"mcpServers:",
			"  api:",
			"    args:",
			"      - server.js",
			"    env:",
			"      TOKEN: keep-me",
			"tools:",
			"  - read",
			"futureKey: from-a-newer-build",
			"",
		].join("\n");
		const target = {
			theme: { dark: "obsidian" },
			mcpServers: { api: { args: ["server.js", "--verbose"], env: { TOKEN: "keep-me" } } },
			tools: ["read", "write"],
			futureKey: "from-a-newer-build",
			temperature: 0.7,
		};
		const after = syncYamlTextToSettings(before, target);
		expect(YAML.parse(after)).toEqual(target);
		// The parts the target did not change are still the user's bytes.
		expect(after).toContain("# a user's file");
		expect(after).toContain("      TOKEN: keep-me");
		expect(after).toContain("futureKey: from-a-newer-build");
	});
});
