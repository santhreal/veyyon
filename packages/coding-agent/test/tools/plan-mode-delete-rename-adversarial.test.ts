import { describe, expect, it } from "bun:test";
import { enforcePlanModeWrite } from "@veyyon/coding-agent/tools/plan-mode-guard";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Plan mode hard-denies rename and delete with exact error strings.
 */

describe("plan mode delete/rename adversarial", () => {
	function planSession() {
		return makeToolSession({
			cwd: "/tmp/plan-del",
			hasUI: false,
			getSessionFile: () => null,
			getArtifactsDir: () => "/tmp/plan-del-artifacts",
			getSessionId: () => "p1",
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://plan.md" }),
		});
	}

	it("delete of a local:// path is denied", () => {
		expect(() => enforcePlanModeWrite(planSession(), "local://plan.md", { op: "delete" })).toThrow(ToolError);
		expect(() => enforcePlanModeWrite(planSession(), "local://plan.md", { op: "delete" })).toThrow(
			/deleting files is not allowed/i,
		);
	});

	it("delete of a tree path is denied", () => {
		expect(() => enforcePlanModeWrite(planSession(), "src/a.ts", { op: "delete" })).toThrow(
			/deleting files is not allowed/i,
		);
	});

	it("rename is denied for both tree and local targets", () => {
		expect(() => enforcePlanModeWrite(planSession(), "src/a.ts", { move: "src/b.ts" })).toThrow(
			/renaming files is not allowed/i,
		);
		expect(() => enforcePlanModeWrite(planSession(), "local://a.md", { move: "local://b.md" })).toThrow(
			/renaming files is not allowed/i,
		);
	});

	it("create and update ops still hit tree read-only for tree paths", () => {
		expect(() => enforcePlanModeWrite(planSession(), "src/a.ts", { op: "create" })).toThrow(
			/working tree is read-only/i,
		);
		expect(() => enforcePlanModeWrite(planSession(), "src/a.ts", { op: "update" })).toThrow(
			/working tree is read-only/i,
		);
	});

	it("disabled plan mode allows delete/rename without throwing", () => {
		const s = makeToolSession({
			cwd: "/tmp/plan-del",
			hasUI: false,
			getSessionFile: () => null,
			getPlanModeState: () => ({ enabled: false }),
		});
		expect(() => enforcePlanModeWrite(s, "src/a.ts", { op: "delete" })).not.toThrow();
		expect(() => enforcePlanModeWrite(s, "src/a.ts", { move: "src/b.ts" })).not.toThrow();
	});
});
