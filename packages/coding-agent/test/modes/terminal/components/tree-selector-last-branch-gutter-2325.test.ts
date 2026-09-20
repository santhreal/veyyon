import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/tree-selector";
import * as themeModule from "@veyyon/coding-agent/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@veyyon/kernel/session/session-entries";
import { cardBodyLines } from "../../../helpers/modal-card";

let counter = 0;
function makeNode(role: "user" | "assistant", text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${counter++}`;
	const message: AgentMessage =
		role === "user"
			? { role: "user", content: text, timestamp: counter }
			: ({
					role: "assistant",
					content: [{ type: "text", text }],
					timestamp: counter,
					stopReason: "stop",
				} as AgentMessage);
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function chain(parent: SessionTreeNode, ...specs: Array<["user" | "assistant", string]>): SessionTreeNode {
	let cur = parent;
	for (const [role, text] of specs) {
		const n = makeNode(role, text, cur.entry.id);
		cur.children.push(n);
		cur = n;
	}
	return cur;
}

function renderStripped(tree: SessionTreeNode[], leafId: string, width = 120): string[] {
	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		() => {},
		() => {},
	);
	// The tree now paints inside a ModalShell card, so the connector columns
	// these assertions measure start after the card's left border.
	return cardBodyLines(selector.render(width));
}

// Issue #2325 tree shape: a parent that branches into several sub-sessions
// where the LAST sibling (`└─`) carries a chain of flattened message rows
// that itself branches again deeper down.
describe("issue #2325: connectors terminate at `└─` and chain columns stay stable", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders no vertical in the `└─` corner column and keeps chain rows on one anchor column", () => {
		counter = 0;
		const root = makeNode("user", "proceed with implementation");
		const asst = chain(root, ["assistant", "resp"]);
		const b1 = makeNode("user", "first review head", asst.entry.id);
		const b2 = makeNode("user", "plain review head", asst.entry.id);
		const b3 = makeNode("user", "second review head", asst.entry.id);
		asst.children.push(b1, b2, b3);
		const leaf = chain(b1, ["assistant", "b1 reply"], ["user", "active leaf"]);

		// Chain under the LAST sibling b3, with a branch point partway down.
		const fixIt = chain(b3, ["assistant", "fix-asst"], ["user", "fix it all"]);
		const revAsst = chain(fixIt, ["assistant", "rev-asst"]);
		const t1 = makeNode("user", "review the fixes", revAsst.entry.id);
		const t2 = makeNode("user", "other thread", revAsst.entry.id);
		revAsst.children.push(t1, t2);
		chain(t1, ["user", "all findings done"], ["user", "still have findings"]);

		const rendered = renderStripped([root], leaf.entry.id);
		const findRow = (needle: string): string => {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			return row;
		};

		// Every row reserves a three-cell cursor lane, then the rail, then a
		// two-cell node mark between the rail and its text: `●` at the current
		// leaf, `•` elsewhere on the active path, blank off it. Every row asserted
		// here is off the active path (the leaf is under b1), so the mark's cells
		// are blank and fold into the whitespace runs below. After the mark comes
		// the fixed-width kind column, which is where each `\S` below lands.
		const MARK = 2;
		const CURSOR = 3;
		const rail = (indentCols: number, glyph: string, gapAfter: number) =>
			new RegExp(`^\\s{${CURSOR + indentCols}}${glyph}\\s{${gapAfter + MARK}}\\S`);

		// b3 is the last sibling: its connector is `└─` on the first rail column.
		expect(findRow("second review head")).toMatch(rail(0, "└─", 1));

		// Chain rows under the `└─` head: the corner column must stay
		// blank — no `│` running down from the `└─` — and every chain row is
		// anchored by `│` on the same column, one level right (below the head's
		// content). Exact prefix: the cursor lane, 3 spaces, `│`, 2 spaces, the
		// mark, then the kind column.
		for (const needle of ["fix-asst", "fix it all", "rev-asst"]) {
			const row = findRow(needle);
			expect(row).not.toMatch(/^\s{3}│/);
			expect(row).toMatch(rail(3, "│", 2));
		}

		// The deeper branch point keeps stable columns: connectors sit directly
		// below the chain content column (two rail levels in), with nothing
		// dangling in the outer corner columns.
		expect(findRow("review the fixes")).toMatch(rail(6, "├─", 1));
		expect(findRow("other thread")).toMatch(rail(6, "└─", 1));

		// Continuations of the non-last grandchild ride its sibling line at the
		// same column — no drift back into outer columns.
		for (const needle of ["all findings done", "still have findings"]) {
			const row = findRow(needle);
			expect(row).toMatch(rail(6, "│", 5));
		}
	});
});
