import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@veyyon/agent-core";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "@veyyon/coding-agent/config/settings-schema";
import { BashTool, type BashToolInput } from "@veyyon/coding-agent/tools/bash";
import { checkBashInterception, UNIFIED_SEARCH_REDIRECTS } from "@veyyon/coding-agent/tools/bash-interceptor";
import { normalizeToolName } from "@veyyon/coding-agent/tools/builtin-names";
import { searchSchema } from "@veyyon/coding-agent/tools/search";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = makeToolSession({
		settings: {
			get(key: string) {
				if (key === "bashInterceptor.enabled") return true;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getBashInterceptorRules() {
				return rules;
			},
		},
	});

	return new BashTool(session);
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && cat package.json" }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow("Use read instead");
	});
});

// WHY: the redirect messages once told the model to pass `purpose: "match"`, a
// field the ablation-era search facade took and the shipped `search` tool does
// not. A message naming a field the schema rejects costs a refused call, and the
// old suite pinned the retired word, so it went red on the cutover instead of
// catching it. These cases read the accepted vocabulary out of `searchSchema`
// and sweep every entry of the retired-primitive table, so adding a redirect in
// a vocabulary the tool does not take fails here. Not covered: whether the
// patterns match the right commands, which the rule-specific describes below do.
const SEARCH_TYPES: string[] = searchSchema.shape.type.options;

describe("default unified-search redirects", () => {
	it.each([
		["grep -R needle src", "text"],
		["find src -name '*.ts'", "files"],
	])("routes %s to search type %s", (command, type) => {
		const result = checkBashInterception(command, ["search"], DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("search");
		expect(result.message).toContain(`type: "${type}"`);
	});

	it("names an accepted search type in every default rule that routes to search", () => {
		const searchRules = DEFAULT_BASH_INTERCEPTOR_RULES.filter(rule => rule.tool === "search");
		expect(searchRules.length).toBeGreaterThan(0);
		for (const rule of searchRules) {
			const named = SEARCH_TYPES.filter(type => rule.message.includes(`type: "${type}"`));
			expect(named).toHaveLength(1);
			expect(rule.message).not.toContain("purpose:");
		}
	});

	it.each(Object.keys(UNIFIED_SEARCH_REDIRECTS))("redirects a rule still naming %s to search", primitive => {
		expect(normalizeToolName(primitive)).toBe("search");
		const rules: BashInterceptorRule[] = [
			{ pattern: "^\\s*probe\\s+", tool: primitive, message: "unused: the primitive is gone" },
		];
		const result = checkBashInterception("probe needle", ["search"], rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("search");
		expect(result.message).toContain(UNIFIED_SEARCH_REDIRECTS[primitive]);
		const named = SEARCH_TYPES.filter(type => result.message?.includes(`type: "${type}"`));
		expect(named).toHaveLength(1);
		expect(result.message).not.toContain("purpose:");
	});

	it("does not redirect a retired primitive when search itself is inactive", () => {
		const rules: BashInterceptorRule[] = [
			{ pattern: "^\\s*probe\\s+", tool: "grep", message: "unused: the primitive is gone" },
		];
		expect(checkBashInterception("probe needle", ["bash"], rules).block).toBe(false);
	});

	it("does not block when no replacement tool is active", () => {
		expect(checkBashInterception("grep -R needle src", ["bash"], DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});
});

describe("default echo/printf redirect rule", () => {
	const tools = ["write"];

	it("blocks unquoted redirects to files", () => {
		expect(checkBashInterception("echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi >> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception('printf "%s" foo > /tmp/x', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks clobber and variable-target redirects", () => {
		expect(checkBashInterception("echo hi >| out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi > $OUT", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block /dev device sink redirects", () => {
		expect(checkBashInterception("echo result > /dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo done > /dev/null 2>&1", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo "" > /dev/tty', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo x > /dev/stdout", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "marker" > /dev/stderr', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo x > "/dev/null"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks real paths that resemble /dev sinks", () => {
		expect(checkBashInterception("echo data > ./dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo data > /devices/x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("keeps scanning after allowed /dev sink redirects", () => {
		expect(
			checkBashInterception("echo data > /dev/null > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
		expect(
			checkBashInterception("printf x > /dev/stdout >> real.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});

	it("does not block `>` inside quoted text or fd duplication", () => {
		expect(checkBashInterception('echo "a -> b"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "<p>hi</p>"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("printf 'use 2>&1'", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "err" >&2', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});
});

describe("default launch rules", () => {
	const tools = ["launch"];

	it.each(["bun run dev", "vite --host 0.0.0.0", "lldb ./app", "bun test --watch", "nohup server", "server &"])(
		"routes %s to launch",
		command => {
			const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(result.block).toBe(true);
			expect(result.suggestedTool).toBe("launch");
		},
	);

	it.each(["git diff -w", "docker compose up -d", "bun test", "printf 'server &'"])(
		"does not misclassify finite command %s",
		command => {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		},
	);
});

describe("BashTool argument validation", () => {
	it("preserves async requests so disabled async mode returns the explicit error", async () => {
		const tool = createBashTool([]);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-call",
			name: tool.name,
			arguments: { command: "echo should-not-run", async: true },
		});

		await expect(tool.execute("tool-call", args as unknown as BashToolInput)).rejects.toThrow(
			"Async bash execution is disabled",
		);
	});
});
