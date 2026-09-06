/**
 * Regression guard for PR review feedback on #2190.
 *
 * Agents inherit the parent's custom-tool source *paths* (a cheap FS scan
 * the parent already paid for), but each session MUST rebuild its own
 * `LoadedCustomTool[]` so factories see the agent's `CustomToolAPI`
 * (cwd, exec, pushPendingAction, UI). Forwarding the parent's loaded tool
 * instances would route execution and pending actions back to the parent —
 * wrong for isolated tasks and for queue routing.
 *
 * This file does not exercise the live SDK end-to-end (that path requires
 * a real worker spawn and is covered by the broader test suite); it pins
 * down the loader contract that the SDK now depends on.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CustomToolAPI,
	loadCustomTools,
	type ToolPathWithSource,
} from "@veyyon/coding-agent/extensibility/custom-tools";
import { removeWithRetries } from "@veyyon/utils";

describe("loadCustomTools per-session binding (#2190 review fix)", () => {
	let tmp: string;
	let toolPath: string;

	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-tool-binding-"));
		toolPath = path.join(tmp, "echo-cwd.ts");
		// Factory exposes the API it was bound to so the test can inspect it.
		await fs.writeFile(
			toolPath,
			[
				"export default function (api) {",
				"  return {",
				"    name: 'echo_cwd_' + api.cwd.replace(/[^a-z0-9]/gi, '_'),",
				"    description: 'returns the cwd the factory was bound to',",
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: api.cwd }] }; },",
				"    __boundApi: api,",
				"  };",
				"}",
			].join("\n"),
		);
	});

	afterAll(async () => {
		await removeWithRetries(tmp);
	});

	it("binds each load to the cwd passed to loadCustomTools", async () => {
		const paths: ToolPathWithSource[] = [{ path: toolPath }];
		const parentResult = await loadCustomTools(paths, "/tmp/parent-cwd", []);
		const agentResult = await loadCustomTools(paths, "/tmp/agent-cwd", []);

		expect(parentResult.errors).toEqual([]);
		expect(agentResult.errors).toEqual([]);
		expect(parentResult.tools).toHaveLength(1);
		expect(agentResult.tools).toHaveLength(1);

		expect(parentResult.tools[0]).toBeDefined();
		expect(agentResult.tools[0]).toBeDefined();
		const parentApi = (parentResult.tools[0]!.tool as unknown as { __boundApi: CustomToolAPI }).__boundApi;
		const agentApi = (agentResult.tools[0]!.tool as unknown as { __boundApi: CustomToolAPI }).__boundApi;

		expect(parentApi.cwd).toBe("/tmp/parent-cwd");
		expect(agentApi.cwd).toBe("/tmp/agent-cwd");
		expect(agentApi).not.toBe(parentApi);
		// Different tool instances — a session must never see the other's tool.
		expect(agentResult.tools[0]?.tool).not.toBe(parentResult.tools[0]?.tool);
	});

	it("routes pushPendingAction to the loader's own callback, not a shared one", async () => {
		const parentLog: string[] = [];
		const agentLog: string[] = [];

		const parentResult = await loadCustomTools([{ path: toolPath }], "/tmp/parent-cwd", [], action =>
			parentLog.push(`parent:${action.label}`),
		);
		const agentResult = await loadCustomTools([{ path: toolPath }], "/tmp/agent-cwd", [], action =>
			agentLog.push(`agent:${action.label}`),
		);

		expect(parentResult.tools[0]).toBeDefined();
		expect(agentResult.tools[0]).toBeDefined();
		const parentApi = (parentResult.tools[0]!.tool as unknown as { __boundApi: CustomToolAPI }).__boundApi;
		const agentApi = (agentResult.tools[0]!.tool as unknown as { __boundApi: CustomToolAPI }).__boundApi;

		// Cast: the test fixture exposes the runtime API verbatim.
		parentApi.pushPendingAction({
			label: "ping",
			sourceToolName: "echo",
			apply: async () => ({ content: [] }),
		});
		agentApi.pushPendingAction({
			label: "ping",
			sourceToolName: "echo",
			apply: async () => ({ content: [] }),
		});

		expect(parentLog).toEqual(["parent:ping"]);
		expect(agentLog).toEqual(["agent:ping"]);
	});
});
