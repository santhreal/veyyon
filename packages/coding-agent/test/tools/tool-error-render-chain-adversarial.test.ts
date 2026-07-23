import { describe, expect, it } from "bun:test";
import { renderError, ToolAbortError, ToolError, throwIfAborted } from "@veyyon/coding-agent/tools/tool-errors";

/**
 * ToolError render chains and abort interaction with exact messages.
 */

class CustomToolError extends ToolError {
	override render(): string {
		return `CUSTOM:${this.message}`;
	}
}

describe("ToolError render chain adversarial", () => {
	it("subclass render is used by renderError", () => {
		expect(renderError(new CustomToolError("x"))).toBe("CUSTOM:x");
	});

	it("context is retained but not required for render", () => {
		const err = new ToolError("fail", { path: "/x", code: 7 });
		expect(err.context).toEqual({ path: "/x", code: 7 });
		expect(err.render()).toBe("fail");
		expect(renderError(err)).toBe("fail");
	});

	it("throwIfAborted after abort with custom ToolAbortError preserves message", () => {
		const ac = new AbortController();
		const custom = new ToolAbortError("user-cancel");
		ac.abort(custom);
		try {
			throwIfAborted(ac.signal);
			expect(true).toBe(false);
		} catch (e) {
			expect(e).toBe(custom);
			expect((e as Error).message).toBe("user-cancel");
		}
	});

	it("renderError of nested cause-like object stringifies safely", () => {
		const out = renderError({ toString: () => "obj-error" });
		expect(out).toContain("obj-error");
	});

	it("ToolError is instanceof Error and name is ToolError", () => {
		const err = new ToolError("m");
		expect(err instanceof Error).toBe(true);
		expect(err instanceof ToolError).toBe(true);
		expect(err.name).toBe("ToolError");
	});
});
