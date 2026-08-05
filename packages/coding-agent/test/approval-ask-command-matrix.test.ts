/**
 * `ask-command`: reads and workspace writes run unasked, anything that executes
 * asks. The rung used to be spelled `auto-edit` (and before that `write`); both
 * names are still accepted from stored configs and the CLI, so they are pinned
 * here as landing on the same rung rather than on a rung of their own.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "../src/tools/approval";

describe("resolveApproval ask-command matrix", () => {
	it("allows read", () => {
		expect(resolveApproval({ name: "read", approval: "read" }, {}, "ask-command", {}).policy).toBe("allow");
	});
	it("allows write", () => {
		expect(resolveApproval({ name: "write", approval: "write" }, {}, "ask-command", {}).policy).toBe("allow");
	});
	it("prompts exec", () => {
		expect(resolveApproval({ name: "bash", approval: "exec" }, {}, "ask-command", {}).policy).toBe("prompt");
	});
	it("legacy auto-edit alias resolves to the same rung", () => {
		expect(resolveApproval({ name: "read", approval: "read" }, {}, "auto-edit", {}).policy).toBe("allow");
		expect(resolveApproval({ name: "write", approval: "write" }, {}, "auto-edit", {}).policy).toBe("allow");
		expect(resolveApproval({ name: "bash", approval: "exec" }, {}, "auto-edit", {}).policy).toBe("prompt");
	});
	it("legacy write alias resolves to the same rung", () => {
		expect(resolveApproval({ name: "read", approval: "read" }, {}, "write", {}).policy).toBe("allow");
		expect(resolveApproval({ name: "write", approval: "write" }, {}, "write", {}).policy).toBe("allow");
		expect(resolveApproval({ name: "bash", approval: "exec" }, {}, "write", {}).policy).toBe("prompt");
	});
});
