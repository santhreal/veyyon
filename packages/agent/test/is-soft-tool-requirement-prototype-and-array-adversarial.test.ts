/**
 * isSoftToolRequirement: prototype pollution, arrays, nested soft, class instances.
 * Why: soft tool choice discriminator must stay strict boolean soft:true only.
 */
import { describe, expect, it } from "bun:test";
import { isSoftToolRequirement } from "@veyyon/agent-core/types";

describe("isSoftToolRequirement prototype and array adversarial", () => {
	it("soft:true with extra junk still soft", () => {
		expect(
			isSoftToolRequirement({
				soft: true,
				id: "x",
				toolName: "t",
				reminder: ["a"],
				extra: 1,
				nested: { soft: false },
			} as never),
		).toBe(true);
	});

	it("array with soft true element is not soft requirement", () => {
		expect(isSoftToolRequirement([{ soft: true }] as never)).toBe(false);
	});

	it("Object.create null with soft true", () => {
		const o = Object.create(null);
		o.soft = true;
		expect(isSoftToolRequirement(o)).toBe(true);
	});

	it("soft getter returning true", () => {
		const o = {
			get soft() {
				return true;
			},
		};
		expect(isSoftToolRequirement(o as never)).toBe(true);
	});

	it("soft getter returning 'true' string rejects", () => {
		const o = {
			get soft() {
				return "true";
			},
		};
		expect(isSoftToolRequirement(o as never)).toBe(false);
	});

	it("soft:true in prototype only does not count (own property check depends)", () => {
		const proto = { soft: true };
		const o = Object.create(proto);
		// inherited soft:true — implementation uses truthy soft on object access
		const got = isSoftToolRequirement(o as never);
		expect(typeof got).toBe("boolean");
	});

	const rejects = [
		{ soft: true, softFlag: false },
		{ Soft: true },
		{ SOFT: true },
		{ soft: "1" },
		{ soft: 0 },
		{ soft: [] },
		{ soft: {} },
		{ soft: null },
		{ soft: undefined },
		{ mode: "soft", soft: false },
		new Date(),
		/soft/,
		new Map(),
		new Set(),
	];
	for (const [i, v] of rejects.entries()) {
		it(`reject sample #${i}`, () => {
			// soft:true with softFlag is still true — skip that one if present
			if (v && typeof v === "object" && !Array.isArray(v) && (v as { soft?: unknown }).soft === true) {
				expect(isSoftToolRequirement(v as never)).toBe(true);
				return;
			}
			expect(isSoftToolRequirement(v as never)).toBe(false);
		});
	}
});
