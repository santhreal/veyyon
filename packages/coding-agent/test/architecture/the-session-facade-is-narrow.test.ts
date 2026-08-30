/**
 * WHY: `AgentSessionFacade` exists to be the ONE session API a front end holds,
 * so its value is entirely in what it refuses to expose. The defect class this
 * closes is facade creep: a member added for one caller's convenience, a
 * re-export that hands the whole `AgentSession` back, or a terminal import that
 * drags the TUI into a graphical client's module graph. Any of those and the
 * facade is a second name for the class it was meant to narrow.
 *
 * The member set is read off a live instance rather than a hardcoded list, so a
 * new public member on the implementation turns this red until someone records
 * the decision here. The reachability walk is derived from the import graph at
 * run time for the same reason.
 *
 * What it does not catch: a member that keeps its name and widens its meaning
 * (`submit` growing an options bag), and a leak through a type the facade
 * already exposes.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { z } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { PERMISSION_OPTIONS } from "@veyyon/coding-agent/session/agent-session-permissions";
import { createSessionFacade } from "@veyyon/coding-agent/session/facade";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { TempDir } from "@veyyon/utils";
import {
	importSpecifiers,
	repoPath,
	repoRelative,
	resolveSpecifier,
	valueImportSpecifiers,
} from "./helpers/module-graph";

/**
 * The whole facade surface. Pinned by exact equality: a member added to the
 * implementation, or one removed from it, fails here first.
 */
const FACADE_MEMBERS = [
	"approveTool",
	"contextUsage",
	"interrupt",
	"model",
	"on",
	"provider",
	"rejectTool",
	"retry",
	"running",
	"start",
	"stop",
	"submit",
	"tokenCount",
] as const;

const noopSchema = z.object({ value: z.string() });
const noopTool: AgentTool<typeof noopSchema, { value: string }> = {
	name: "record",
	label: "Record",
	description: "Record a value",
	parameters: noopSchema,
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
	},
};

/**
 * Every member name reachable on an instance, own and inherited, minus `Object`'s.
 * `#private` fields are absent from the language's own reflection, so what this
 * returns is exactly the surface a caller can reach.
 */
function publicMembers(instance: object): string[] {
	const names = new Set<string>();
	for (let node: object | null = instance; node && node !== Object.prototype; node = Object.getPrototypeOf(node)) {
		for (const key of Object.getOwnPropertyNames(node)) {
			if (key === "constructor") continue;
			names.add(key);
		}
	}
	return [...names].sort();
}

describe("the facade's surface", () => {
	it("exposes exactly the members a front end is given", async () => {
		const tempDir = TempDir.createSync("@pi-facade-narrow-");
		try {
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			authStorage.setRuntimeApiKey("mock", "test-key");
			const mock = createMockModel({ responses: [{ content: [{ type: "text", text: "hi" }], stopReason: "stop" }] });
			const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
			settings.setModelRole("default", `${mock.provider}/${mock.id}`);
			const tools = [noopTool as AgentTool];
			const session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
					convertToLlm,
					streamFn: mock.stream,
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			});
			try {
				expect(publicMembers(createSessionFacade(session))).toEqual([...FACADE_MEMBERS]);
			} finally {
				await session.dispose();
			}
		} finally {
			await tempDir.remove();
		}
	});

	it("keeps the two permission rungs approveTool and rejectTool select", () => {
		const ids = PERMISSION_OPTIONS.map(option => option.optionId);
		expect(ids).toContain("allow_once");
		expect(ids).toContain("reject_once");
		expect(PERMISSION_OPTIONS.find(option => option.optionId === "allow_once")?.kind).toBe("allow_once");
		expect(PERMISSION_OPTIONS.find(option => option.optionId === "reject_once")?.kind).toBe("reject_once");
	});
});

describe("the facade's module graph", () => {
	const facade = repoPath("packages/coding-agent/src/session/facade.ts");
	const sessionRuntime = repoPath("packages/coding-agent/src/session/agent-session.ts");

	/**
	 * Files the facade reaches on its own, with the session runtime treated as an
	 * opaque boundary, and only edges that survive type erasure followed.
	 *
	 * `agent-session.ts` transitively reaches `main.ts` and the whole terminal
	 * tree, which is the coupling this pull request set out to describe rather than
	 * one it has already removed; walking through it would measure the package, not
	 * the facade. A `import type` edge is followed by neither a bundler nor a
	 * runtime, so it is not what "drags the TUI in" means.
	 */
	function facadeOwnGraph(): string[] {
		const seen = new Set<string>([sessionRuntime]);
		const queue = [facade];
		const visited: string[] = [];
		while (queue.length > 0) {
			const file = queue.pop();
			if (!file || seen.has(file)) continue;
			seen.add(file);
			visited.push(file);
			for (const specifier of valueImportSpecifiers(file)) {
				const resolved = resolveSpecifier(file, specifier);
				if (resolved) queue.push(resolved);
			}
		}
		return visited;
	}

	/**
	 * Runtime TUI edges in the facade's own graph, pinned by exact equality so a
	 * new one turns this red. The list is empty and shrink-only: an entry leaves
	 * when the edge is gone, and none is added.
	 *
	 * `session/image-visibility.ts` held the last one. It read
	 * `TERMINAL.imageProtocol` to decide whether a picture a tool produced reached
	 * the screen; now the front end installs that answer through
	 * `setImageDisplayProbe`, so the capability arrives as a value the session is
	 * told rather than one it reads out of a rendering singleton, and a client that
	 * draws no pictures gets the truthful sentence instead of a terminal's.
	 */
	const LEGACY_TUI_EDGES: string[] = [];

	it("names no terminal module, and no TUI package", () => {
		const offenders: string[] = [];
		for (const file of facadeOwnGraph()) {
			for (const specifier of valueImportSpecifiers(file)) {
				const external = specifier.startsWith("@veyyon/tui");
				const terminal = /(^|\/)modes\/(terminal|acp|rpc)(\/|$)/.test(specifier);
				if (external || terminal) offenders.push(`${repoRelative(file)} -> ${specifier}`);
			}
		}
		expect([...new Set(offenders)].sort()).toEqual(LEGACY_TUI_EDGES);
	});

	it("imports the session runtime and nothing else from outside its own directory tree", () => {
		const specifiers = importSpecifiers(facade).filter(specifier => specifier.startsWith("."));
		expect(specifiers.sort()).toEqual(["./agent-session", "./agent-session-types", "./client-bridge", "./messages"]);
	});
});
