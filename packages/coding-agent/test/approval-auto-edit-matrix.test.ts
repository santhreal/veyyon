/**
 * auto-edit mode: allow read/write, prompt exec.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "../src/tools/approval";

describe("resolveApproval auto-edit matrix", () => {
	it("allows read", () => {
		expect(
			resolveApproval({ name: "read", approval: "read" }, {}, "auto-edit", {}).policy,
		).toBe("allow");
	});
	it("allows write", () => {
		expect(
			resolveApproval({ name: "write", approval: "write" }, {}, "auto-edit", {}).policy,
		).toBe("allow");
	});
	it("prompts exec", () => {
		expect(
			resolveApproval({ name: "bash", approval: "exec" }, {}, "auto-edit", {}).policy,
		).toBe("prompt");
	});
	it("write alias mode same as auto-edit", () => {
		expect(
			resolveApproval({ name: "write", approval: "write" }, {}, "write", {}).policy,
		).toBe("allow");
		expect(
			resolveApproval({ name: "bash", approval: "exec" }, {}, "write", {}).policy,
		).toBe("prompt");
	});
});
