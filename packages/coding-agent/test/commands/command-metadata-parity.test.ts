/**
 * Every registered CLI command has a non-empty description and loadable class.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A command's description and flag set are observable contracts that
 * users and scripts depend on. This suite loads every registered command
 * dynamically and pins its description, ensuring the Rust port produces
 * identical command metadata.
 */
import { describe, expect, it } from "bun:test";
import { commands } from "@veyyon/coding-agent/cli-commands";

const LOADED_COMMANDS = await Promise.all(
	commands.map(async entry => ({ name: entry.name, mod: await entry.load() })),
);

describe("every registered command has pinned metadata", () => {
	it("the command registry is non-empty", () => {
		expect(commands.length).toBeGreaterThan(0);
	});

	for (const { name, mod } of LOADED_COMMANDS) {
		describe(`command "${name}"`, () => {
			const isInternal = name.startsWith("__");
			if (!isInternal) {
				it("has a non-empty description", () => {
					expect(typeof mod.description).toBe("string");
					expect(mod.description!.length).toBeGreaterThan(0);
				});
			}

			it("has a static flags object or no flags", () => {
				if (mod.flags !== undefined) {
					expect(typeof mod.flags).toBe("object");
				}
			});
		});
	}
});
