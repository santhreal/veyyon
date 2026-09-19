import { ThinkingLevel } from "@veyyon/agent-core";
import type { SessionEntry, SessionTreeNode } from "@veyyon/kernel/session/session-entries";
import { type Component, Input } from "@veyyon/tui";
import { HoverController } from "@veyyon/tui/utils/hover-controller";
import { fuzzyMatch } from "@veyyon/utils/fuzzy";
import { extractPrintableText, matchesKey } from "@veyyon/utils/keys";
import type { HoverFadeOptions } from "@veyyon/utils/motion";
import { routeSgrMouseInput, type SgrMouseEvent } from "@veyyon/utils/mouse";
import { padding } from "@veyyon/utils/padding";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import type { TreeFilterMode } from "../../../../config/settings-schema";
import { resolveAssistantErrorPresentation } from "../../../../presentation/transcript-builder";
import { type ThemeColor, theme } from "../../../../theme/theme";
import { shortenPath, TRUNCATE_LENGTHS } from "../../../../tools/core/render-utils";
import { canonicalizeMessage } from "../../../../utils/thinking-display";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../utils/keybinding-matchers";
import {
	computeModalDims,
	MODAL_SIZING_LARGE,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	pointerMotionEnabled,
	renderModalShell,
	sizingForArea,
} from "../chrome/modal-shell";
import { routeModalChrome } from "./select-list-mouse-routing";
import {
	centeredWindow,
	highlightTokens,
	hoverBandAt,
	renderScrollableList,
	searchTokens,
	selectionBand,
} from "./selector-helpers";

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
interface GutterInfo {
	position: number; // displayIndent level where the connector was shown
	show: boolean; // true = show │, false = show spaces
}

/** Flattened tree node for navigation */
interface FlatNode {
	node: SessionTreeNode;
	/** Indentation level (each level = 3 chars) */
	indent: number;
	/** Whether to show connector (├─ or └─) - true if parent has multiple children */
	showConnector: boolean;
	/** If showConnector, true = last sibling (└─), false = not last (├─) */
	isLast: boolean;
	/** Gutter info for each ancestor branch point */
	gutters: GutterInfo[];
	/** True if this node is a root under a virtual branching root (multiple roots) */
	isVirtualRootChild: boolean;
}

/** Filter mode for tree display */
type FilterMode = TreeFilterMode;

/**
 * The order `ctrl+O` steps through, forwards and backwards, and the one list of
 * modes the card names in its header. Kept equal to the `treeFilterMode` setting's
 * declared values by
 * `test/modes/terminal/components/the-session-tree-card-hugs-its-rows.test.ts`, so a
 * mode added to the setting cannot quietly be unreachable from the keybinding.
 */
export const TREE_FILTER_MODES = [
	"default",
	"no-tools",
	"user-only",
	"labeled-only",
	"all",
] as const satisfies readonly FilterMode[];

/**
 * Cells the node mark occupies on every row, on the active path or off it. The
 * column is reserved unconditionally so entry text at one depth starts at one
 * column whatever a row's state is.
 */
const MARK_COLS = 2;

/**
 * Cells the leading cursor lane occupies: a margin cell, the caret and a gap.
 *
 * The margin cell is why it is three and not two: the rail used to start on the
 * card's first content column, so a root row's text sat against the border.
 */
const CURSOR_COLS = 3;

/**
 * Cells the entry-kind column occupies, and the gap between it and entry text.
 *
 * Ten because that is the longest tool name the column has to carry
 * (`web_search`), and the kinds it carries besides a tool name — `user`,
 * `assistant`, `developer`, `bash`, `summary` — are shorter.
 */
const KIND_COLS = 10;
const KIND_GAP = 1;

/** Cells the right-hand age column occupies: a gap and three glyphs of age. */
const AGE_COLS = 6;

/** Row width below which the age column is dropped for entry text. */
const AGE_MIN_ROW_COLS = 48;

/**
 * Tree list component with selection and ASCII art visualization
 */
/**
 * One recorded tool call, for the row that reports it.
 *
 * The arguments are `unknown` because a session file holds whatever the
 * provider streamed: the parsed object in the ordinary case, and the raw JSON
 * string when the turn ended before it parsed.
 */
interface ToolCallInfo {
	name: string;
	arguments: unknown;
}

/**
 * One row's content, split into the two columns that carry it.
 *
 * The kind is a column of its own rather than a prefix inside the text, so the
 * entry text of every row at one depth starts at one offset and the kinds read
 * down the card as a column. Spelling it into the text (`user: `, `[bash]: `,
 * `[read: path]`) put the start of the content wherever the kind's own length
 * left it, which is what made a card of mixed entries read as ragged.
 */
interface EntryCells {
	/** The kind column's plain text: a role, a tool name, or an entry type. */
	kind: string;
	/** Colour the kind column carries. */
	tone: ThemeColor;
	/**
	 * Entry text, PLAIN and never repeating the kind.
	 *
	 * Plain because the row is what paints it: a search match is painted inside
	 * this text, and a highlight nested in an already-coloured run ends the run
	 * at its own reset, so the row's colour would stop at the first match.
	 */
	text: string;
	/** Colour the entry text carries; the terminal's own foreground when absent. */
	textTone?: ThemeColor;
}

/**
 * Cells a path may spend on a row before its leading directories are dropped.
 */
const PATH_TAIL_COLS = 44;

/**
 * A path as a row's text: the home directory collapsed to `~`, and the leading
 * directories dropped behind `…/` once it runs past {@link PATH_TAIL_COLS}.
 *
 * A path on this card is read from its end. The file name is what distinguishes
 * one row from the next, and the directories in front of it are shared with
 * every other row in the same session, so a row-width path is cut from the
 * LEFT. Cut from the right — which is what row truncation does to it otherwise
 * — every deep row reads `packages/coding-agent/src/modes/terminal/compone…`
 * and no two of them can be told apart.
 */
function tailPath(value: unknown): string {
	const shortened = shortenPath(value);
	if (visibleWidth(shortened) <= PATH_TAIL_COLS) return shortened;
	const segments = shortened.split("/");
	let tail = truncateToWidth(segments.pop() ?? shortened, PATH_TAIL_COLS - 2);
	for (let i = segments.length - 1; i >= 0; i--) {
		const wider = `${segments[i]}/${tail}`;
		if (visibleWidth(wider) + 2 > PATH_TAIL_COLS) break;
		tail = wider;
	}
	return `…/${tail}`;
}

/**
 * Argument keys that name what a call was about, most telling first.
 *
 * A tool the card knows nothing else about gets one of these values as its row
 * text, because a serialized argument object spends the row on braces, quotes
 * and key names: `{"query":"terminal tree column ali…` says less in more cells
 * than `terminal tree view column alignment`.
 */
const ARG_SUMMARY_KEYS = [
	"command",
	"query",
	"input",
	"path",
	"url",
	"expression",
	"pattern",
	"name",
	"prompt",
	"task",
	"message",
] as const;

/** The one argument value that best names a call, or its serialized arguments. */
function argSummary(args: unknown): string {
	// A session can record arguments that were never parsed into an object: the
	// raw JSON the provider streamed. It is returned as it stands, because
	// `Object.entries` on a string walks its characters and answers `{`.
	if (typeof args === "string") return args;
	if (typeof args !== "object" || args === null) return JSON.stringify(args ?? {});
	const fields: Record<string, unknown> = args as Record<string, unknown>;
	for (const key of ARG_SUMMARY_KEYS) {
		const value = fields[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	for (const [key, value] of Object.entries(fields)) {
		// `i` is the caller's own one-line intent, which every tool carries. It
		// restates the row's kind column instead of naming what was operated on.
		if (key === "i") continue;
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return JSON.stringify(fields);
}

/**
 * Entry types the default filter hides: session bookkeeping rather than the
 * conversation. `ctrl+O` to `all` shows them.
 *
 * A mode change, a title change, a tier change, a session header and an
 * injected-rules record used to pass the default filter and paint a row with
 * nothing on it, because the row builder had no case for them: a card of a real
 * session carried blank rows a user could select and jump to. They are
 * bookkeeping on the same footing as a model change, so they are hidden with
 * it, and they now draw their own kind and text in `all`.
 */
const BOOKKEEPING_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"label",
	"custom",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"mode_change",
	"title_change",
	"session_init",
	"ttsr_injection",
	"mcp_tool_selection",
]);

class TreeList implements Component {
	#flatNodes: FlatNode[] = [];
	#filteredNodes: FlatNode[] = [];
	/** Rows the filter mode admits, search aside — what the card sizes itself against. */
	#modeRowCount = 0;
	#selectedIndex = 0;
	#filterMode: FilterMode;
	#searchQuery = "";
	/**
	 * The query as tokens, kept beside it because both the filter and the row
	 * highlight read them and a per-row re-split would tokenize the same query
	 * once per visible row, every frame.
	 */
	#searchTokens: string[] = [];
	#toolCallMap: Map<string, ToolCallInfo> = new Map();
	#multipleRoots = false;
	#activePathIds: Set<string> = new Set();
	#lastSelectedId: string | null = null;
	/** Rows the card can spare for tree entries; the shell decides it per frame. */
	#maxVisibleLines: number;
	/** Pointer-highlighted entry (never the selected one; selection owns its row). */
	#hover = new HoverController<number>();
	/** Per-render map of 0-based rendered line → filtered-node index. */
	#hitRows: (number | undefined)[] = [];

	onSelect?: (entryId: string) => void;
	onCancel?: () => void;
	onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	constructor(
		tree: SessionTreeNode[],
		private readonly currentLeafId: string | null,
		maxVisibleLines: number,
		initialFilterMode: FilterMode = "default",
		initialSelectedId?: string,
	) {
		this.#maxVisibleLines = maxVisibleLines;
		this.#filterMode = initialFilterMode;
		this.#multipleRoots = tree.length > 1;
		this.#flatNodes = this.#flattenTree(tree);
		this.#buildActivePath();
		this.#applyFilter();

		// Start with initialSelectedId if provided, otherwise current leaf
		const targetId = initialSelectedId ?? currentLeafId;
		this.#selectedIndex = this.#findNearestVisibleIndex(targetId);
		this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? null;
	}

	/** Build the set of entry IDs on the path from root to current leaf */
	#buildActivePath(): void {
		this.#activePathIds.clear();
		if (!this.currentLeafId) return;

		// Build a map of id -> entry for parent lookup
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.#flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Walk from leaf to root
		let currentId: string | null = this.currentLeafId;
		while (currentId) {
			this.#activePathIds.add(currentId);
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}
	}

	/**
	 * Find the index of the nearest visible entry, walking up the parent chain if needed.
	 * Returns the index in filteredNodes, or the last index as fallback.
	 */
	#findNearestVisibleIndex(entryId: string | null): number {
		if (this.#filteredNodes.length === 0) return 0;

		// Build a map for parent lookup
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.#flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Build a map of visible entry IDs to their indices in filteredNodes
		const visibleIdToIndex = new Map<string, number>(this.#filteredNodes.map((node, i) => [node.node.entry.id, i]));

		// Walk from entryId up to root, looking for a visible entry
		let currentId = entryId;
		while (currentId !== null) {
			const index = visibleIdToIndex.get(currentId);
			if (index !== undefined) return index;
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}

		// Fallback: last visible entry
		return this.#filteredNodes.length - 1;
	}

	#flattenTree(roots: SessionTreeNode[]): FlatNode[] {
		const result: FlatNode[] = [];
		this.#toolCallMap.clear();

		// Indentation rules:
		// - At indent 0: stay at 0 unless parent has >1 children (then +1)
		// - At indent 1: children always go to indent 2 (visual grouping of subtree)
		// - At indent 2+: stay flat for single-child chains, +1 only if parent branches

		// Stack items: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
		type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];

		// Determine which subtrees contain the active leaf (to sort current branch first)
		// Use iterative post-order traversal to avoid stack overflow
		const containsActive = new Map<SessionTreeNode, boolean>();
		const leafId = this.currentLeafId;
		{
			// Build list in pre-order, then process in reverse for post-order effect
			const allNodes: SessionTreeNode[] = [];
			const preOrderStack: SessionTreeNode[] = roots.slice();
			while (preOrderStack.length > 0) {
				const node = preOrderStack.pop()!;
				allNodes.push(node);
				// Push children in reverse so they're processed left-to-right
				for (let i = node.children.length - 1; i >= 0; i--) {
					preOrderStack.push(node.children[i]);
				}
			}
			// Process in reverse (post-order): children before parents
			for (let i = allNodes.length - 1; i >= 0; i--) {
				const node = allNodes[i];
				let has = leafId !== null && node.entry.id === leafId;
				for (const child of node.children) {
					if (containsActive.get(child)) {
						has = true;
					}
				}
				containsActive.set(node, has);
			}
		}

		// Add roots in reverse order, prioritizing the one containing the active leaf
		// If multiple roots, treat them as children of a virtual root that branches
		const multipleRoots = roots.length > 1;
		const orderedRoots = roots.slice().sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		for (let i = orderedRoots.length - 1; i >= 0; i--) {
			const isLast = i === orderedRoots.length - 1;
			stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
		}

		while (stack.length > 0) {
			const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			// Extract tool calls from assistant messages for later lookup
			const entry = node.entry;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = (entry.message as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
							const tc = block as { id: string; name: string; arguments: unknown };
							this.#toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
						}
					}
				}
			}

			result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

			const children = node.children;
			const multipleChildren = children.length > 1;

			// Order children so the branch containing the active leaf comes first
			const orderedChildren = (() => {
				const prioritized: SessionTreeNode[] = [];
				const rest: SessionTreeNode[] = [];
				for (const child of children) {
					if (containsActive.get(child)) {
						prioritized.push(child);
					} else {
						rest.push(child);
					}
				}
				return prioritized.concat(rest);
			})();

			// Calculate child indent
			let childIndent: number;
			if (multipleChildren) {
				// Parent branches: children get +1
				childIndent = indent + 1;
			} else if (justBranched && indent > 0) {
				// First generation after a branch: +1 for visual grouping
				childIndent = indent + 1;
			} else {
				// Single-child chain: stay flat
				childIndent = indent;
			}

			// Build gutters for children
			// If this node showed a connector, add a gutter entry for descendants
			// Only add gutter if connector is actually displayed (not suppressed for virtual root children)
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			// When connector is displayed, add a gutter entry at the connector's position
			// Connector is at position (displayIndent - 1), so gutter should be there too
			const currentDisplayIndent = this.#multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters: GutterInfo[] = connectorDisplayed
				? gutters.concat([{ position: connectorPosition, show: !isLast }])
				: gutters;

			// Add children in reverse order
			for (let i = orderedChildren.length - 1; i >= 0; i--) {
				const childIsLast = i === orderedChildren.length - 1;
				stack.push([
					orderedChildren[i],
					childIndent,
					multipleChildren,
					multipleChildren,
					childIsLast,
					childGutters,
					false,
				]);
			}
		}

		return result;
	}

	#applyFilter(): void {
		// Update lastSelectedId only when we have a valid selection (non-empty list)
		// This preserves the selection when switching through empty filter results
		if (this.#filteredNodes.length > 0) {
			this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? this.#lastSelectedId;
		}

		this.#searchTokens = searchTokens(this.#searchQuery);

		// Two passes, because the card sizes itself against the first one. The rows
		// the FILTER MODE admits are what the tree naturally wants to show; the
		// search narrows that live, and resizing the card per keystroke would be
		// worse than the rows it saves.
		const modeVisible = this.#flatNodes.filter(flatNode => this.#passesMode(flatNode));
		this.#modeRowCount = modeVisible.length;
		this.#filteredNodes =
			this.#searchTokens.length === 0
				? modeVisible
				: modeVisible.filter(flatNode => {
						const nodeText = this.#getSearchableText(flatNode.node);
						return this.#searchTokens.every(token => fuzzyMatch(token, nodeText).matches);
					});

		// Try to preserve cursor on the same node, or find nearest visible ancestor
		if (this.#lastSelectedId) {
			this.#selectedIndex = this.#findNearestVisibleIndex(this.#lastSelectedId);
		} else if (this.#selectedIndex >= this.#filteredNodes.length) {
			// Clamp index if out of bounds
			this.#selectedIndex = Math.max(0, this.#filteredNodes.length - 1);
		}

		// Update lastSelectedId to the actual selection (may have changed due to parent walk)
		if (this.#filteredNodes.length > 0) {
			this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? this.#lastSelectedId;
		}
	}

	/** Whether the current filter mode admits this row, search aside. */
	#passesMode(flatNode: FlatNode): boolean {
		const entry = flatNode.node.entry;
		const isCurrentLeaf = entry.id === this.currentLeafId;

		// Skip assistant messages with only tool calls (no text) unless error/aborted
		// Always show current leaf so active position is visible
		if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
			const msg = entry.message as { stopReason?: string; content?: unknown };
			const hasText = this.#hasTextContent(msg.content);
			const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
			// Only hide if no text AND not an error/aborted message
			if (!hasText && !isErrorOrAborted) {
				return false;
			}
		}

		const isSettingsEntry = BOOKKEEPING_ENTRY_TYPES.has(entry.type);

		switch (this.#filterMode) {
			case "user-only":
				// Just user messages
				return entry.type === "message" && entry.message.role === "user";
			case "no-tools":
				// Default minus tool results
				return !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
			case "labeled-only":
				// Just labeled entries
				return flatNode.node.label !== undefined;
			case "all":
				// Show everything
				return true;
			default:
				// Default mode: hide settings/bookkeeping entries
				return !isSettingsEntry;
		}
	}

	/** Get searchable text content from a node */
	#getSearchableText(node: SessionTreeNode): string {
		const entry = node.entry;
		const parts: string[] = [];

		if (node.label) {
			parts.push(node.label);
		}

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.#extractContent(msg.content));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				if (msg.role === "toolResult") {
					// The row shows the tool's name and its argument summary, so the
					// search has to reach both: a card where `read` matches nothing is
					// a card whose visible text the search cannot see.
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					const call = toolMsg.toolCallId ? this.#toolCallMap.get(toolMsg.toolCallId) : undefined;
					const name = call?.name ?? toolMsg.toolName;
					if (name) parts.push(name);
					if (call) parts.push(this.#formatToolCall(call.name, call.arguments));
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (typeof entry.content === "string") {
					parts.push(entry.content);
				} else {
					parts.push(this.#extractContent(entry.content));
				}
				break;
			}
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "model_change":
				parts.push("model", entry.model);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel ?? ThinkingLevel.Off);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
			case "mode_change":
				parts.push("mode", entry.mode);
				break;
			case "title_change":
				parts.push("title", entry.title);
				break;
			case "session_init":
				parts.push("session");
				break;
			case "ttsr_injection":
				parts.push("rules", ...entry.injectedRules);
				break;
			case "mcp_tool_selection":
				parts.push("mcp", ...entry.selectedToolNames);
				break;
			case "service_tier_change":
				parts.push("tier");
				break;
		}

		return parts.join(" ");
	}

	invalidate(): void {}

	getSearchQuery(): string {
		return this.#searchQuery;
	}

	/**
	 * The card's height request: rows the filter mode admits, so a nine-entry
	 * session gets a nine-row card instead of a twenty-row one with eleven blank
	 * rows under the tree. Deliberately blind to the search query, which would
	 * resize the card on every keystroke.
	 */
	naturalRowCount(): number {
		return this.#modeRowCount;
	}

	/** Rows on screen right now (mode and search applied). */
	visibleRowCount(): number {
		return this.#filteredNodes.length;
	}

	/** Every entry in the session tree, whatever the filter hides. */
	totalRowCount(): number {
		return this.#flatNodes.length;
	}

	/** The active filter mode, named for the header row. */
	filterName(): FilterMode {
		return this.#filterMode;
	}

	/** Size the viewport to the rows the card can spare this frame. */
	setMaxVisibleLines(rows: number): void {
		this.#maxVisibleLines = Math.max(1, rows);
	}

	/** Resolve a rendered line (0-based within this list) to a filtered-node index. */
	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/**
	 * Band the entry under the pointer (null clears). Returns true on change.
	 *
	 * The band paints on every row, the cursor row included: the pointer does not move the cursor, so
	 * suppressing it there left a row nothing could point at.
	 */
	setHoverIndex(index: number | null): boolean {
		if (this.#hover.key === index) return false;
		this.#hover.set(index);
		return true;
	}

	/**
	 * Fade the pointer band instead of switching it. The frames between two mouse
	 * reports have no input to hang off, so the card lends its repaint.
	 * `enabled: false` is the switched band.
	 */
	setHoverMotion(options: HoverFadeOptions): void {
		this.#hover.setMotion(options);
	}

	/** Drop the fade and forget the pointer, so no timer outlives the card. */
	disposeHoverMotion(): void {
		this.#hover.dispose();
	}

	/** Move the selection one step for a wheel notch (wraps like the arrow keys). */
	handleWheel(delta: -1 | 1): void {
		const total = this.#filteredNodes.length;
		if (total === 0) return;
		this.#selectedIndex =
			delta < 0
				? this.#selectedIndex === 0
					? total - 1
					: this.#selectedIndex - 1
				: this.#selectedIndex === total - 1
					? 0
					: this.#selectedIndex + 1;
	}

	/** Move to the entry under the pointer and jump to it, exactly as Enter does. */
	clickItem(index: number): void {
		const target = this.#filteredNodes[index];
		if (!target) return;
		this.#selectedIndex = index;
		this.onSelect?.(target.node.entry.id);
	}

	updateNodeLabel(entryId: string, label: string | undefined): void {
		for (const flatNode of this.#flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				break;
			}
		}
	}

	#getFilterLabel(): string {
		switch (this.#filterMode) {
			case "no-tools":
				return " [no-tools]";
			case "user-only":
				return " [user]";
			case "labeled-only":
				return " [labeled]";
			case "all":
				return " [all]";
			default:
				return "";
		}
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		// Cleared here, not only in `#buildRows`: an empty filter result returns
		// before the rows are built, and a stale map would answer clicks with the
		// entries the previous filter showed.
		this.#hitRows = [];

		if (this.#filteredNodes.length === 0) {
			// Three empty-state shapes:
			//  - flatNodes empty               → no entries at all (truly fresh session).
			//  - search query rejects everything → tell the user the search is the cause.
			//  - filter mode rejects everything  → tell the user the filter is the cause and
			//    how to widen it. Otherwise fresh sessions whose only persisted entries are
			//    `model_change` + `thinking_level_change` (both hidden by the default filter)
			//    read as "broken /tree" — see #1909.
			if (this.#flatNodes.length === 0) {
				lines.push(truncateToWidth(theme.fg("muted", "  No entries found"), width));
				lines.push(truncateToWidth(theme.fg("muted", `  (0/0)${this.#getFilterLabel()}`), width));
			} else if (this.#searchQuery.length > 0) {
				lines.push(truncateToWidth(theme.fg("muted", `  No entries match search "${this.#searchQuery}"`), width));
				lines.push(truncateToWidth(theme.fg("muted", "  Press Backspace to clear the search"), width));
				lines.push(
					truncateToWidth(theme.fg("muted", `  (0/${this.#flatNodes.length})${this.#getFilterLabel()}`), width),
				);
			} else {
				const filterLabel = this.#getFilterLabel().trim() || "[default]";
				lines.push(
					truncateToWidth(
						theme.fg("muted", `  ${this.#flatNodes.length} entries hidden by the current filter ${filterLabel}`),
						width,
					),
				);
				lines.push(truncateToWidth(theme.fg("muted", "  Press Alt+A to show all, Alt+D for default"), width));
				lines.push(
					truncateToWidth(theme.fg("muted", `  (0/${this.#flatNodes.length})${this.#getFilterLabel()}`), width),
				);
			}
			return lines;
		}

		const { startIndex, endIndex } = centeredWindow(
			this.#selectedIndex,
			this.#filteredNodes.length,
			this.#maxVisibleLines,
		);

		lines.push(
			...renderScrollableList(
				{
					width,
					visibleRows: endIndex - startIndex,
					totalRows: this.#filteredNodes.length,
					scrollOffset: startIndex,
				},
				rowWidth => this.#buildRows(startIndex, endIndex, rowWidth),
			),
		);

		// The filter name is not appended here: it rides the header row beside the
		// counts, where the search query is, instead of spending a body row at the
		// far end of the card from the control that changes it.

		return lines;
	}

	/**
	 * Paint the rows for the window `[startIndex, endIndex)` at `rowWidth`.
	 *
	 * `rowWidth` comes from the ScrollView that will render these rows, so a
	 * selected row can be filled all the way to the pane edge without the fill
	 * being cut short and losing the escape that closes it.
	 */
	#buildRows(startIndex: number, endIndex: number, rowWidth: number): readonly string[] {
		// Cap the per-row gutter prefix so a content budget is always preserved.
		// Each indent level renders as 3 cells; deep branching would otherwise eat the
		// entire viewport (issue #1144). Reserve at least MIN_CONTENT_COLS for entry
		// text — or half the viewport, whichever is larger — and compress older gutter
		// levels off-screen behind a leading ellipsis when the row would exceed budget.
		const MIN_CONTENT_COLS = 24;
		// The age column is orientation, not content: at a fork it says which branch
		// is the recent one. A card too narrow to carry both spends its cells on the
		// entry text instead.
		const ageCols = rowWidth >= AGE_MIN_ROW_COLS ? AGE_COLS : 0;
		// Every fixed column a row spends outside the rail and its text.
		const OVERHEAD_COLS = CURSOR_COLS + MARK_COLS + KIND_COLS + KIND_GAP + ageCols;
		const contentReserve = Math.max(MIN_CONTENT_COLS, Math.floor(rowWidth / 2));
		const maxIndentLevels = Math.max(1, Math.floor((rowWidth - contentReserve - OVERHEAD_COLS) / 3));
		const textWidth = rowWidth - ageCols;

		const rows: string[] = [];
		this.#hitRows = [];

		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.#filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.#selectedIndex;

			// Row shape, left to right: cursor lane, rail, node mark, kind column,
			// label chip, entry text, age.
			const cursor = isSelected ? theme.fg("accent", ` ${theme.nav.cursor} `) : padding(CURSOR_COLS);

			// If multiple roots, shift display (roots at 0, not 1)
			const displayIndent = this.#multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// Build prefix with gutters at their correct positions, clamped to
			// `maxIndentLevels` cells so the content always fits. When clamped, the
			// leftmost cells represent the deepest visible ancestors and a `…` marker
			// indicates older branch context has been compressed.
			const hasConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const connectorSymbol = hasConnector ? (flatNode.isLast ? theme.tree.last : theme.tree.branch) : "";
			// Split by code point, not code unit: a themed glyph outside the BMP must not shed a lone surrogate.
			const connectorChars = hasConnector ? Array.from(connectorSymbol) : [];
			const renderedIndent = Math.min(displayIndent, maxIndentLevels);
			const scrollOffset = displayIndent - renderedIndent;
			const connectorPositionDisplay = hasConnector ? renderedIndent - 1 : -1;
			// Chain rows (no connector of their own) under a last-sibling (`└─`)
			// branch stay anchored by a vertical drawn one level RIGHT of the
			// suppressed gutter — the column where the row's own connector would
			// sit, directly below the branch head's content. Drawing it in the
			// `└─` column itself contradicts the corner and leaves dangling,
			// drifting verticals once the chain branches deeper (#2298, #2325).
			// Chains under `├─` heads need no extra anchor: the sibling line
			// (`show: true` gutter) already ties them to their branch.
			const nearestGutter = !hasConnector ? flatNode.gutters[flatNode.gutters.length - 1] : undefined;
			const chainAnchorLevel = nearestGutter && !nearestGutter.show ? nearestGutter.position + 1 : -1;

			// Build prefix char by char, placing gutters and connector at their positions
			const totalChars = renderedIndent * 3;
			const prefixChars: string[] = [];
			for (let i = 0; i < totalChars; i++) {
				const level = Math.floor(i / 3);
				const originalLevel = level + scrollOffset;
				const posInLevel = i % 3;

				// Check if there's a gutter at this level (translated to original tree depth)
				const gutter = flatNode.gutters.find(g => g.position === originalLevel);
				if (gutter) {
					// Gutters follow standard tree semantics: `│` only while more
					// siblings continue below (`show`), space below a `└─`.
					if (posInLevel === 0) {
						prefixChars.push(gutter.show ? theme.tree.vertical : " ");
					} else {
						prefixChars.push(" ");
					}
				} else if (originalLevel === chainAnchorLevel) {
					// Chain anchor for rows under a `└─` branch head.
					prefixChars.push(posInLevel === 0 ? theme.tree.vertical : " ");
				} else if (hasConnector && level === connectorPositionDisplay) {
					// Connector at this level
					if (posInLevel === 0) {
						prefixChars.push(connectorChars[0] ?? " ");
					} else if (posInLevel === 1) {
						prefixChars.push(connectorChars[1] ?? theme.tree.horizontal);
					} else {
						prefixChars.push(connectorChars[2] ?? " ");
					}
				} else {
					prefixChars.push(" ");
				}
			}
			// Mark the leftmost cell when ancestors were compressed off-screen.
			if (scrollOffset > 0 && prefixChars.length > 0) {
				prefixChars[0] = "…";
			}
			const prefix = prefixChars.join("");

			// The rail carries the active path in colour: accent while the row is on
			// the path from root to the current leaf, dim off it. Colour costs no
			// column, so the columns after it land at one offset on every row.
			const isOnActivePath = this.#activePathIds.has(entry.id);
			const rail = theme.fg(isOnActivePath ? "accent" : "dim", prefix);

			// Fixed-width node mark: `●` the current leaf, `•` the rest of the active
			// path, blank off it. Three states in one column that every row reserves,
			// so entry text at one depth starts at one column. The bullet it replaces
			// was painted only on active rows and shoved their text two cells right of
			// their own siblings, which is what made the card read as ragged.
			//
			// The path bullet is muted where the leaf's dot is bold accent: two
			// glyphs that differ by one pixel at a terminal's cell size are told
			// apart by weight and colour before shape.
			const mark =
				entry.id === this.currentLeafId
					? theme.bold(theme.fg("accent", `${theme.status.active} `))
					: isOnActivePath
						? theme.fg("muted", `${theme.md.bullet} `)
						: padding(MARK_COLS);

			// The kind column, then what the entry says. Both bold under the cursor,
			// and both carrying the search's own highlight: a query narrows the card
			// to the rows it kept and says nothing about WHY it kept them, so the
			// matched characters are painted gold — the product's colour for a
			// filter hit — inside the row's own tone.
			const cells = this.#entryCells(flatNode.node);
			const kindText = truncateToWidth(cells.kind, KIND_COLS);
			const kindStyled = highlightTokens(kindText, this.#searchTokens, {
				base: cells.tone,
				match: "matchHighlight",
			});
			const kind =
				(isSelected ? theme.bold(kindStyled) : kindStyled) + padding(KIND_COLS - visibleWidth(kindText) + KIND_GAP);

			// A label is the user's own landmark, so it keeps its warning colour; its
			// brackets are structure and recede.
			const label = flatNode.node.label
				? theme.fg("dim", "[") +
					highlightTokens(flatNode.node.label, this.#searchTokens, {
						base: "warning",
						match: "matchHighlight",
					}) +
					theme.fg("dim", "] ")
				: "";
			const painted = highlightTokens(cells.text, this.#searchTokens, {
				base: cells.textTone,
				match: "matchHighlight",
			});
			const content = isSelected ? theme.bold(painted) : painted;

			const text = truncateToWidth(cursor + rail + mark + kind + label + content, textWidth);
			const line = ageCols
				? text + padding(Math.max(0, textWidth - visibleWidth(text))) + theme.fg("dim", this.#ageCell(entry))
				: text;
			// The selection band is the ROW, not the text: pad to the full row width
			// before tinting so the highlight has the same shape on every entry. The
			// pointer borrows the same band; the cursor keeps its accent arrow, so
			// the two never read as one selection.
			const hoverStrength = isSelected ? 0 : this.#hover.strength(i);
			this.#hitRows[i - startIndex] = i;
			if (isSelected) rows.push(selectionBand(line, rowWidth));
			else if (hoverStrength > 0) rows.push(hoverBandAt(line, rowWidth, hoverStrength));
			else rows.push(line);
		}

		return rows;
	}

	/**
	 * The row's right-hand age cell, exactly {@link AGE_COLS} cells wide: a
	 * three-cell gap and a right-aligned coarse age (`12m`, `4h`, `3d`, `2w`,
	 * `1y`).
	 *
	 * Blank under a minute, and blank when the timestamp does not parse. The
	 * column is orientation at a fork — which branch is the recent one — so a
	 * whole card of entries written seconds ago has nothing to say there, and a
	 * missing timestamp is not worth a lie about when it happened.
	 */
	#ageCell(entry: SessionEntry): string {
		const at = Date.parse(entry.timestamp);
		if (Number.isNaN(at)) return padding(AGE_COLS);
		const minutes = Math.floor(Math.max(0, Date.now() - at) / 60_000);
		if (minutes < 1) return padding(AGE_COLS);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);
		const weeks = Math.floor(days / 7);
		const years = Math.floor(days / 365);
		const label =
			hours < 1
				? `${minutes}m`
				: days < 1
					? `${hours}h`
					: weeks < 1
						? `${days}d`
						: years < 1
							? `${weeks}w`
							: `${years}y`;
		return ` ${label.padStart(AGE_COLS - 1)}`;
	}

	/**
	 * Split one entry into its kind column and its text. See {@link EntryCells}.
	 */
	#entryCells(node: SessionTreeNode): EntryCells {
		const entry = node.entry;
		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					return { kind: "user", tone: "accent", text: normalize(this.#extractContent(msgWithContent.content)) };
				}
				if (role === "developer") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					return { kind: "developer", tone: "dim", text: content, textTone: "muted" };
				}
				if (role === "assistant") {
					const presentation = resolveAssistantErrorPresentation(msg);
					if (presentation.kind === "compact-recovered") {
						return { kind: "assistant", tone: "success", text: presentation.text, textTone: "dim" };
					}
					const msgWithContent = msg as { content?: unknown; stopReason?: string };
					const textContent = normalize(this.#extractContent(msgWithContent.content));
					if (textContent) return { kind: "assistant", tone: "success", text: textContent };
					if (presentation.kind === "full") {
						return {
							kind: "assistant",
							tone: "success",
							text: normalize(presentation.text).slice(0, 80),
							textTone: "error",
						};
					}
					const empty = msgWithContent.stopReason === "aborted" ? "(aborted)" : "(no content)";
					return { kind: "assistant", tone: "success", text: empty, textTone: "muted" };
				}
				if (role === "toolResult") {
					const toolMsg = msg as { toolCallId?: string; toolName?: string; content?: unknown };
					const call = toolMsg.toolCallId ? this.#toolCallMap.get(toolMsg.toolCallId) : undefined;
					// Compaction can carry the result across and drop the call that
					// made it, and the arguments ride the call. The row then reports
					// what came BACK, cut to the row's share, rather than spending a
					// selectable row on a tool name and nothing else.
					const text = call
						? this.#formatToolCall(call.name, call.arguments)
						: truncateToWidth(normalize(this.#extractContent(toolMsg.content)), TRUNCATE_LENGTHS.SHORT);
					return { kind: call?.name ?? toolMsg.toolName ?? "tool", tone: "muted", text, textTone: "muted" };
				}
				if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					return { kind: "bash", tone: "dim", text: normalize(bashMsg.command ?? ""), textTone: "dim" };
				}
				return { kind: role, tone: "dim", text: "" };
			}
			case "custom_message": {
				const content =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map(c => c.text)
								.join("");
				return { kind: entry.customType, tone: "customMessageLabel", text: normalize(content) };
			}
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				return { kind: "compaction", tone: "borderAccent", text: `${tokens}k tokens`, textTone: "borderAccent" };
			}
			case "branch_summary":
				return { kind: "summary", tone: "warning", text: normalize(entry.summary) };
			case "model_change":
				return { kind: "model", tone: "dim", text: entry.model, textTone: "dim" };
			case "thinking_level_change":
				return {
					kind: "thinking",
					tone: "dim",
					text: entry.thinkingLevel ?? ThinkingLevel.Off,
					textTone: "dim",
				};
			case "custom":
				return { kind: "custom", tone: "dim", text: entry.customType, textTone: "dim" };
			case "label":
				return { kind: "label", tone: "dim", text: entry.label ?? "(cleared)", textTone: "dim" };
			case "service_tier_change": {
				const tier = entry.serviceTier;
				const families = tier === null ? "(cleared)" : Object.values(tier).join(" ");
				return { kind: "tier", tone: "dim", text: families, textTone: "dim" };
			}
			case "mode_change":
				return { kind: "mode", tone: "dim", text: entry.mode, textTone: "dim" };
			case "title_change":
				return { kind: "title", tone: "dim", text: normalize(entry.title), textTone: "dim" };
			case "session_init":
				return { kind: "session", tone: "dim", text: `${entry.tools.length} tools`, textTone: "dim" };
			case "ttsr_injection":
				return { kind: "rules", tone: "dim", text: entry.injectedRules.join(" "), textTone: "dim" };
			case "mcp_tool_selection":
				return { kind: "mcp", tone: "dim", text: entry.selectedToolNames.join(" "), textTone: "dim" };
			default: {
				// An entry kind this card was not written for — a package's own,
				// merged into the union — still says WHICH kind it is. A blank row is
				// unreadable and unsearchable, and `all` mode shows every row.
				const unknown = entry as { type?: string };
				return { kind: unknown.type ?? "entry", tone: "dim", text: "" };
			}
		}
	}

	#extractContent(content: unknown): string {
		const maxLen = 200;
		if (typeof content === "string") return content.slice(0, maxLen);
		if (Array.isArray(content)) {
			let result = "";
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					result += (c as { text: string }).text;
					if (result.length >= maxLen) return result.slice(0, maxLen);
				}
			}
			return result;
		}
		return "";
	}

	#hasTextContent(content: unknown): boolean {
		if (typeof content === "string") return Boolean(canonicalizeMessage(content));
		if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					const text = (c as { text?: string }).text;
					if (text && canonicalizeMessage(text)) return true;
				}
			}
		}
		return false;
	}

	/**
	 * What one tool call did, as the row's text: its arguments, never its name.
	 *
	 * The name is the kind column, so repeating it here would spend the row's
	 * first cells saying the same word twice.
	 *
	 * Arguments the session recorded unparsed — the raw JSON string of a turn
	 * that ended mid-call — reach {@link argSummary} whatever the tool is,
	 * because a per-tool rule reading `args.path` off a string answers
	 * `undefined` and would spend the row on an empty cell.
	 */
	#formatToolCall(name: string, args: unknown): string {
		if (typeof args !== "object" || args === null) return this.#summarizeArgs(args);
		const fields: Record<string, unknown> = args as Record<string, unknown>;
		switch (name) {
			case "read": {
				const path = tailPath(fields.path || fields.file_path || "");
				const offset = typeof fields.offset === "number" ? fields.offset : undefined;
				const limit = typeof fields.limit === "number" ? fields.limit : undefined;
				if (offset === undefined && limit === undefined) return path;
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				return `${path}:${start}${end ? `-${end}` : ""}`;
			}
			case "write":
			case "edit":
				return tailPath(fields.path || fields.file_path || "");
			case "ls":
				return tailPath(fields.path || ".");
			case "bash": {
				const rawCmd = String(fields.command || "");
				const cmd = rawCmd
					.replace(/[\n\t]/g, " ")
					.trim()
					.slice(0, 50);
				return `${cmd}${rawCmd.length > 50 ? "..." : ""}`;
			}
			case "search": {
				const type = String(fields.type || "?");
				const input = String(fields.input || "");
				const scope = typeof fields.path === "string" ? ` in ${tailPath(fields.path)}` : "";
				return `${type} ${input}${scope}`;
			}
			default:
				return this.#summarizeArgs(fields);
		}
	}

	/** {@link argSummary} on one row: tabs flattened, and cut to the row's share. */
	#summarizeArgs(args: unknown): string {
		return truncateToWidth(
			argSummary(args)
				.replace(/[\n\t]/g, " ")
				.trim(),
			TRUNCATE_LENGTHS.SHORT,
		);
	}

	handleInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredNodes.length - 1 : this.#selectedIndex - 1;
		} else if (matchesSelectDown(keyData)) {
			this.#selectedIndex = this.#selectedIndex === this.#filteredNodes.length - 1 ? 0 : this.#selectedIndex + 1;
		} else if (matchesKey(keyData, "left")) {
			// Page up
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#maxVisibleLines);
		} else if (matchesKey(keyData, "right")) {
			// Page down
			this.#selectedIndex = Math.min(this.#filteredNodes.length - 1, this.#selectedIndex + this.#maxVisibleLines);
		} else if (matchesKey(keyData, "home")) {
			// The root, in one key. Left/Right page through a long trunk a screen at
			// a time, which is a poor way to reach the thing every path starts at.
			this.#selectedIndex = 0;
		} else if (matchesKey(keyData, "end")) {
			this.#selectedIndex = Math.max(0, this.#filteredNodes.length - 1);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id);
			}
		} else if (matchesAppInterrupt(keyData)) {
			if (this.#searchQuery) {
				this.#searchQuery = "";
				this.#applyFilter();
			} else {
				this.onCancel?.();
			}
		} else if (matchesKey(keyData, "ctrl+c")) {
			this.onCancel?.();
		} else if (matchesKey(keyData, "shift+ctrl+o") || matchesKey(keyData, "ctrl+shift+o")) {
			// Cycle filter backwards
			const at = TREE_FILTER_MODES.indexOf(this.#filterMode);
			this.#filterMode = TREE_FILTER_MODES[(at - 1 + TREE_FILTER_MODES.length) % TREE_FILTER_MODES.length];
			this.#applyFilter();
		} else if (matchesKey(keyData, "ctrl+o")) {
			// Cycle filter forwards: default → no-tools → user-only → labeled-only → all → default
			const at = TREE_FILTER_MODES.indexOf(this.#filterMode);
			this.#filterMode = TREE_FILTER_MODES[(at + 1) % TREE_FILTER_MODES.length];
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+d")) {
			this.#filterMode = "default";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+t")) {
			this.#filterMode = "no-tools";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+u")) {
			this.#filterMode = "user-only";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+l")) {
			this.#filterMode = "labeled-only";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+a")) {
			this.#filterMode = "all";
			this.#applyFilter();
		} else if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = this.#searchQuery.slice(0, -1);
				this.#applyFilter();
			}
		} else if (matchesKey(keyData, "shift+l") && !this.#searchQuery) {
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else {
			const printableText = extractPrintableText(keyData);
			if (printableText) {
				this.#searchQuery += printableText;
				this.#applyFilter();
			}
		}
	}
}

/** ModalShell footer chips. One array, so the chrome plan matches the chips the card paints. */
const TREE_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "move", keybindings: ["tui.select.up", "tui.select.down"] },
	{ label: "left/right page" },
	{ label: "home/end ends" },
	{ label: "shift+L label" },
	{ label: "ctrl+O filter" },
	{ label: "enter jump", clickable: true, id: "confirm" },
	{ label: "esc close", clickable: true, id: "close" },
];

/** Rows the tree keeps even on a short terminal. */
const MIN_TREE_ROWS = 3;

/** Label input component shown when editing a label */
class LabelInput implements Component {
	#input: Input;
	onSubmit?: (entryId: string, label: string | undefined) => void;
	onCancel?: () => void;

	constructor(
		private readonly entryId: string,
		currentLabel: string | undefined,
	) {
		this.#input = new Input();
		if (currentLabel) {
			this.#input.setValue(currentLabel);
		}
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const indent = "  ";
		const availableWidth = width - indent.length;
		lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
		lines.push(...this.#input.render(availableWidth).map(line => truncateToWidth(`${indent}${line}`, width)));
		lines.push(truncateToWidth(`${indent}${theme.fg("dim", "enter: save  esc: cancel")}`, width));
		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const value = this.#input.getValue().trim();
			this.onSubmit?.(this.entryId, value || undefined);
		} else if (matchesAppInterrupt(keyData)) {
			this.onCancel?.();
		} else {
			this.#input.handleInput(keyData);
		}
	}
}

/**
 * `/tree` picker: the session tree inside a floating ModalShell card, with the
 * label editor taking the body while it is open.
 */
export class TreeSelectorComponent implements Component {
	#treeList: TreeList;
	#labelInput: LabelInput | null = null;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	/** Frame row where the tree's own rows begin (shell body start). */
	#listRowStart = 0;
	#onRequestRender?: () => void;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		onSelect: (entryId: string) => void,
		private readonly onCancel: () => void,
		private readonly onLabelChangeCallback?: (entryId: string, label: string | undefined) => void,
		initialFilterMode: FilterMode = "default",
	) {
		// The viewport is re-sized from the chrome plan on every frame; this seed
		// only has to be positive for the first centered window.
		this.#treeList = new TreeList(tree, currentLeafId, MIN_TREE_ROWS, initialFilterMode);
		this.#treeList.onSelect = onSelect;
		this.#treeList.onCancel = onCancel;
		this.#treeList.onLabelEdit = (entryId, currentLabel) => this.#showLabelInput(entryId, currentLabel);

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
		// The pointer band fades only once the card has a repaint to lend it: the
		// frames between two mouse reports have no input to hang off. Same ambient
		// gate as the open unfold; without it the band is switched.
		this.#treeList.setHoverMotion({ requestRender: cb, enabled: pointerMotionEnabled() });
	}

	/** Settle the pointer band so no timer outlives a dismissed card. */
	dispose(): void {
		this.#treeList.disposeHoverMotion();
	}

	invalidate(): void {
		this.#treeList.invalidate();
	}

	#showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.#labelInput = new LabelInput(entryId, currentLabel);
		this.#labelInput.onSubmit = (id, label) => {
			this.#treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.#hideLabelInput();
		};
		this.#labelInput.onCancel = () => this.#hideLabelInput();
	}

	#hideLabelInput(): void {
		this.#labelInput = null;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}
		if (this.#labelInput) {
			this.#labelInput.handleInput(keyData);
		} else {
			this.#treeList.handleInput(keyData);
		}
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const consumed = routeModalChrome({
			shellGeometry: this.#shellGeometry,
			event,
			hoveredShortcutId: this.#hoveredShortcutId,
			onHoverShortcut: id => {
				this.#hoveredShortcutId = id;
				this.#onRequestRender?.();
			},
			onCancel: () => {
				// While the label editor owns the body, close means "abandon the edit"
				// — the same thing Esc does there — and the tree stays up.
				if (this.#labelInput) {
					this.#hideLabelInput();
					this.#onRequestRender?.();
					return;
				}
				this.onCancel();
			},
			onConfirm: () => this.handleInput("\n"),
		});
		if (consumed) return true;
		// The label editor has no rows to hit-test; only the chrome answers.
		if (this.#labelInput) return true;
		if (event.wheel !== null) {
			this.#treeList.handleWheel(event.wheel);
			this.#onRequestRender?.();
			return true;
		}
		const line = event.row - this.#listRowStart;
		if (event.motion) {
			if (this.#treeList.setHoverIndex(this.#treeList.hitTest(line) ?? null)) {
				this.#onRequestRender?.();
			}
			return true;
		}
		if (event.leftClick) {
			const index = this.#treeList.hitTest(line);
			if (index !== undefined) this.#treeList.clickItem(index);
			return true;
		}
		return true;
	}

	/**
	 * The card's header row: the search query on the left, and on the right the
	 * rows on screen out of the whole tree plus the filter mode that decided it.
	 *
	 * The filter used to be named on a body row at the bottom of the card, and
	 * only while it was not `default`, so the one view where entries are missing
	 * without explanation was the view that said nothing. Counts and mode sit
	 * beside the search because those three are what narrow the tree.
	 */
	#headerLine(contentWidth: number): string {
		const query = this.#treeList.getSearchQuery();
		const left = query
			? `${theme.fg("muted", "Search:")} ${theme.fg("accent", query)}`
			: theme.fg("dim", "Type to search");
		const status = `${this.#treeList.visibleRowCount()}/${this.#treeList.totalRowCount()}  ·  ${this.#treeList.filterName()}`;
		const gap = contentWidth - visibleWidth(left) - visibleWidth(status);
		if (gap < 2) return left;
		return left + padding(gap) + theme.fg("muted", status);
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = sizingForArea(MODAL_SIZING_LARGE, height);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		const chrome = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts: TREE_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			hasSearch: true,
		});

		let body: readonly string[];
		// Rows the card asks for. The label editor is three rows; the tree asks for
		// what its filter mode admits, so a short session gets a short card instead
		// of one sized for twenty entries with blank rows under the last one. The
		// list is then sized to the SAME number, because the shell truncates an
		// overrun silently and the row it would eat is the one under the cursor.
		//
		// MIN_TREE_ROWS is the floor whatever the tree holds: an empty result is
		// three rows of guidance (what hid the entries and which key widens it),
		// and a card sized to one row would show only the first of them.
		let bodyRows: number;
		if (this.#labelInput) {
			body = this.#labelInput.render(dims.contentWidth);
			bodyRows = body.length;
		} else {
			const natural = Math.max(MIN_TREE_ROWS, this.#treeList.naturalRowCount());
			bodyRows = Math.max(1, Math.min(chrome.maxBodyRows, natural));
			this.#treeList.setMaxVisibleLines(bodyRows);
			body = this.#treeList.render(dims.contentWidth);
		}

		const shell = renderModalShell({
			title: "Session Tree",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			preferredBodyRows: bodyRows,
			searchLine: this.#headerLine(dims.contentWidth),
			shortcuts: TREE_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#listRowStart = shell.geometry?.bodyRowStart ?? 0;
		return shell.lines;
	}
}
