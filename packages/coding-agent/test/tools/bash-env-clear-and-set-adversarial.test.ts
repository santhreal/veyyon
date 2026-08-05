import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

function bashSession(cwd: string) {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "bash-env2",
		allocateOutputArtifact: async kind => ({
			id: `${kind}-1`,
			path: path.join(cwd, `${kind}-1.txt`),
		}),
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	});
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("");
}

describe("BashTool env set/unset adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-env2-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("export then printf sees the variable", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e1", {
			command: "export FOO=bar; printf '%s\\n' \"$FOO\"",
			timeout: 15,
		});
		expect(textOf(result)).toContain("bar");
	});

	it("unset removes a previously exported variable in the same shell", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e2", {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: ${FOO-missing} is shell parameter expansion, not a JS template
			command: "export FOO=bar; unset FOO; printf '<%s>\\n' \"${FOO-missing}\"",
			timeout: 15,
		});
		expect(textOf(result)).toContain("missing");
	});

	/**
	 * THE BUG THIS LOCKS OUT: `bash` handing the shell a `HOME` that is not the one the
	 * process resolved. Tools that shell out write caches, credentials and config under
	 * `$HOME`, so a wrong value scatters state into the wrong tree, and an EMPTY one
	 * makes `cd`, `~` expansion and every dotfile lookup resolve against `/`.
	 *
	 * WHY IT WAS REWRITTEN. The previous assertion was
	 * `expect(textOf(result).trim().length).toBeGreaterThan(0)`, which cannot fail on
	 * either half of that. A shell that printed a diagnostic, a wrong path, or any other
	 * non-empty byte satisfied it, and the test's own name ("HOME is non-empty") was the
	 * strongest thing it checked. It is also exactly the assertion that survives the
	 * repo-wide test-home sandbox unchanged, which is the tell: it never read the value.
	 *
	 * IF IT REGRESSES: a bash tool call writes into a home directory nobody chose.
	 */
	it("gives the shell the same HOME the process resolved, not merely a non-empty one", async () => {
		const tool = new BashTool(bashSession(tmpDir) as never);
		const result = await tool.execute("e3", {
			command: "printf '%s\\n' \"$HOME\"",
			timeout: 15,
		});

		// The resolved path, byte for byte, from the command's FIRST output line: the
		// result also carries a wall-time footer, and comparing the whole blob would
		// force a substring check, which is the weaker assertion this test is replacing.
		// `os.homedir()` is what every other home-touching code path in the process
		// reads, so equality here is the contract.
		expect(textOf(result).trim().split("\n")[0]).toBe(os.homedir());
		// And it is a real absolute path, so an `os.homedir()` that itself went empty
		// cannot make the line above pass by comparing "" to "".
		expect(path.isAbsolute(os.homedir())).toBe(true);
	});
});
