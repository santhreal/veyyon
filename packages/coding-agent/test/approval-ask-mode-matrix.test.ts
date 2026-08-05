/**
 * ask mode prompts for every tier, reads included.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "../src/tools/approval";

describe("resolveApproval ask mode", () => {
	it("prompts read", () => {
		expect(resolveApproval({ name: "read", approval: "read" }, {}, "ask", {}).policy).toBe("prompt");
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
