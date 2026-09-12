import { beforeAll, describe, expect, it } from "bun:test";
import { UserMessageSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/user-message-selector";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("UserMessageSelectorComponent", () => {
	it("fuzzy-filters overflowing message lists from typed input", () => {
		const selected: string[] = [];
		const messages = Array.from({ length: 11 }, (_, index) => ({
			id: `message-${index}`,
			text: index === 7 ? "Deploy the needle rollback plan" : `Routine status update ${index}`,
		}));
		const component = new UserMessageSelectorComponent(
			messages,
			id => selected.push(id),
			() => {},
		);
		const list = component.getMessageList();

		for (const char of "needle") {
			list.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Deploy the needle rollback plan");
		expect(rendered).not.toContain("Routine status update");
		expect(rendered).toContain("Search: needle");

		list.handleInput("\n");
		expect(selected).toEqual(["message-7"]);
	});

	// Backspace removes one code point, including a surrogate pair, without clearing
	// the preceding query. This covers the selector path, not terminal key decoding.
	it.each(["x", "\u{1f680}", "\u0301"])("removes one trailing code point %s and retains the prior filter", suffix => {
		const selected: string[] = [];
		const component = new UserMessageSelectorComponent(
			Array.from({ length: 11 }, (_, index) => ({
				id: `message-${index}`,
				text: index === 7 ? "needle" : `Routine status update ${index}`,
			})),
			id => selected.push(id),
			() => {},
		);
		const list = component.getMessageList();
		list.handleInput(" ");
		for (const char of "needle") list.handleInput(char);
		const beforeEdit = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		list.handleInput(suffix);
		list.handleInput("\x7f");
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toBe(beforeEdit);
		expect(rendered).toContain("Search: needle");
		expect(rendered).not.toContain("Routine status update");
		list.handleInput("\n");
		expect(selected).toEqual(["message-7"]);
	});
});
