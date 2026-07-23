/**
 * ask mode allows read, prompts write and exec.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "../src/tools/approval";

describe("resolveApproval ask mode", () => {
	it("allows read", () => {
		expect(resolveApproval({ name: "read", approval: "read" }, {}, "ask", {}).policy).toBe("allow");
	});
	it("prompts write", () => {
		expect(resolveApproval({ name: "write", approval: "write" }, {}, "ask", {}).policy).toBe("prompt");
	});
	it("prompts exec", () => {
		expect(resolveApproval({ name: "bash", approval: "exec" }, {}, "ask", {}).policy).toBe("prompt");
	});
	it("always-ask same for write", () => {
		expect(resolveApproval({ name: "write", approval: "write" }, {}, "always-ask", {}).policy).toBe("prompt");
	});
});
