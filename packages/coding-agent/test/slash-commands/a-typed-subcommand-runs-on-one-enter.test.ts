/**
 * WHY: while the composer's completion list is open, Enter accepts the
 * highlighted item instead of submitting. A subcommand's completion kept
 * offering itself after it was typed in full, so `/room new` + Enter only
 * appended a space, and the command ran on a second Enter. Every declared
 * subcommand that takes no argument had the same two-Enter step.
 *
 * The class: every builtin command's declared subcommands, read from the
 * registry at run time. A subcommand typed in full that takes no argument
 * offers no completion, so the list is closed and one Enter runs it; one that
 * takes an argument still completes, so Enter adds the space the argument
 * goes after; a partial name still lists its matches.
 *
 * What it does NOT catch: the editor's own Enter handling with the list open
 * (the engine's suites), and commands whose completions are not built from
 * their declared subcommands (`/secret` completes its terminal grammar).
 */

import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMANDS } from "@veyyon/coding-agent/slash-commands/builtin-registry";

const DECLARED = BUILTIN_SLASH_COMMANDS.filter(command => command.name !== "secret" && command.subcommands);

describe("a typed subcommand", () => {
	it("is read from a registry that declares subcommands, /room's included", () => {
		expect(DECLARED.length).toBeGreaterThan(10);
		expect(DECLARED.find(command => command.name === "room")?.subcommands?.map(sub => sub.name)).toEqual([
			"list",
			"new",
			"say",
			"help",
		]);
	});

	it("runs on one Enter when it takes no argument, and completes when it takes one", async () => {
		const wrong: string[] = [];
		for (const command of DECLARED) {
			const complete = command.getArgumentCompletions;
			if (!complete) {
				wrong.push(`/${command.name} declares subcommands and completes none`);
				continue;
			}
			for (const sub of command.subcommands ?? []) {
				if (sub.name.includes(" ")) continue;
				const offered = await complete(sub.name);
				const others = (command.subcommands ?? []).filter(o => o !== sub && o.name.startsWith(sub.name));
				if (!sub.usage && others.length === 0) {
					if (offered !== null) wrong.push(`/${command.name} ${sub.name} still offers a completion`);
				} else if (!Array.isArray(offered) || !offered.some(item => item.value === `${sub.name} `)) {
					wrong.push(`/${command.name} ${sub.name} offers no completion for itself`);
				}
				const partial = sub.name.slice(0, -1);
				if (partial.length > 0) {
					const listed = await complete(partial);
					if (!Array.isArray(listed) || !listed.some(item => item.value === `${sub.name} `)) {
						wrong.push(`/${command.name} ${partial} does not list ${sub.name}`);
					}
				}
			}
		}
		expect(wrong).toEqual([]);
	});
});
