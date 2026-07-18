import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls";

describe("VeyyonProtocolHandler", () => {
	it("treats veyyon://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("veyyon://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("veyyon://tools/read.md");
		const prefixed = await router.resolve("veyyon://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});

	it("no longer registers the pre-rebrand omp:// scheme", async () => {
		await expect(InternalUrlRouter.instance().resolve("omp://docs")).rejects.toThrow();
	});
});
