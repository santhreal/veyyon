import { ThinkingLevel } from "@veyyon/agent-core";
import {
	type Component,
	extractPrintableText,
	fuzzyMatch,
	HoverFade,
	type HoverFadeOptions,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	truncateToWidth,
} from "@veyyon/tui";
import type { TreeFilterMode } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { SessionTreeNode } from "../../session/session-entries";
import { toPathList } from "../../tools/path-utils";
import { shortenPath } from "../../tools/render-utils";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import {
	applyModalReveal,
	beginModalExit,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	modalRevealEnabled,
	planModalChrome,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { centeredWindow, hoverBandAt, renderScrollableList, selectionBand } from "./selector-helpers";

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
 * Tree list component with selection and ASCII art visualization
 */
/** Tool call info for lookup */
interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

class TreeList implements Component {
	#flatNodes: FlatNode[] = [];
	#filteredNodes: FlatNode[] = [];
	#selectedIndex = 0;
	#filterMode: FilterMode;
	#searchQuery = "";
	#toolCallMap: Map<string, ToolCallInfo> = new Map();
	#multipleRoots = false;
	#activePathIds: Set<string> = new Set();
	#lastSelectedId: string | null = null;
	/** Rows the card can spare for tree entries; the shell decides it per frame. */
	#maxVisibleLines: number;
	/** Pointer-highlighted entry (never the selected one; selection owns its row). */
	#hoveredIndex: number | null = null;
	/**
	 * The cross-fade, once the card has lent this list a repaint
	 * ({@link setHoverMotion}). Absent, the band is switched.
	 */
	#hoverFade?: HoverFade;
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
			const preOrderStack: SessionTreeNode[] = [...roots];
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
		const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
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
							const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
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
				return [...prioritized, ...rest];
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
				? [...gutters, { position: connectorPosition, show: !isLast }]
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

		const searchTokens = this.#searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		this.#filteredNodes = this.#flatNodes.filter(flatNode => {
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

			// Apply filter mode
			let passesFilter = true;
			// Entry types hidden in default view (settings/bookkeeping)
			const isSettingsEntry =
				entry.type === "label" ||
				entry.type === "custom" ||
				entry.type === "model_change" ||
				entry.type === "thinking_level_change";

			switch (this.#filterMode) {
				case "user-only":
					// Just user messages
					passesFilter = entry.type === "message" && entry.message.role === "user";
					break;
				case "no-tools":
					// Default minus tool results
					passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
					break;
				case "labeled-only":
					// Just labeled entries
					passesFilter = flatNode.node.label !== undefined;
					break;
				case "all":
					// Show everything
					passesFilter = true;
					break;
				default:
					// Default mode: hide settings/bookkeeping entries
					passesFilter = !isSettingsEntry;
					break;
			}

			if (!passesFilter) return false;

			// Apply fuzzy search filter
			if (searchTokens.length > 0) {
				const nodeText = this.#getSearchableText(flatNode.node);
				return searchTokens.every(token => fuzzyMatch(token, nodeText).matches);
			}

			return true;
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
		}

		return parts.join(" ");
	}

	invalidate(): void {}

	getSearchQuery(): string {
		return this.#searchQuery;
	}

	/** Size the viewport to the rows the card can spare this frame. */
	setMaxVisibleLines(rows: number): void {
		this.#maxVisibleLines = Math.max(1, rows);
	}

	/** Resolve a rendered line (0-based within this list) to a filtered-node index. */
	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/** Highlight the entry under the pointer (null clears). Returns true on change. */
	setHoverIndex(index: number | null): boolean {
		if (this.#hoveredIndex === index) return false;
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
		return true;
	}

	/**
	 * Fade the pointer band instead of switching it. The frames between two mouse
	 * reports have no input to hang off, so the card lends its repaint.
	 * `enabled: false` is the switched band.
	 */
	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade(options);
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	/** Drop the fade and forget the pointer, so no timer outlives the card. */
	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	/** Band strength for a row: 0 for the selected one, which owns its own styling. */
	#hoverStrength(index: number, isSelected: boolean): number {
		if (isSelected) return 0;
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
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

		const filterLabel = this.#getFilterLabel();
		if (filterLabel) {
			lines.push(truncateToWidth(theme.fg("muted", `  ${filterLabel.trim()}`), width));
		}

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
		const OVERHEAD_COLS = 4; // cursor (2) + a touch of breathing room
		const contentReserve = Math.max(MIN_CONTENT_COLS, Math.floor(rowWidth / 2));
		const maxIndentLevels = Math.max(1, Math.floor((rowWidth - contentReserve - OVERHEAD_COLS) / 3));

		const rows: string[] = [];
		this.#hitRows = [];

		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.#filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.#selectedIndex;

			// Build line: cursor + prefix + path marker + label + content
			const cursor = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";

			// If multiple roots, shift display (roots at 0, not 1)
			const displayIndent = this.#multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// Build prefix with gutters at their correct positions, clamped to
			// `maxIndentLevels` cells so the content always fits. When clamped, the
			// leftmost cells represent the deepest visible ancestors and a `…` marker
			// indicates older branch context has been compressed.
			const hasConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const connectorSymbol = hasConnector ? (flatNode.isLast ? theme.tree.last : theme.tree.branch) : "";
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

			// Active path marker - shown right before the entry text
			const isOnActivePath = this.#activePathIds.has(entry.id);
			const pathMarker = isOnActivePath ? theme.fg("accent", `${theme.md.bullet} `) : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
			const content = this.#getEntryDisplayText(flatNode.node, isSelected);

			const line = cursor + theme.fg("dim", prefix) + pathMarker + label + content;
			// The selection band is the ROW, not the text: pad to the full row width
			// before tinting so the highlight has the same shape on every entry. The
			// pointer borrows the same band; the cursor keeps its accent arrow, so
			// the two never read as one selection.
			const hoverStrength = this.#hoverStrength(i, isSelected);
			this.#hitRows[i - startIndex] = i;
			if (isSelected) rows.push(selectionBand(line, rowWidth));
			else if (hoverStrength > 0) rows.push(hoverBandAt(line, rowWidth, hoverStrength));
			else rows.push(truncateToWidth(line, rowWidth));
		}

		return rows;
	}

	#getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string {
		const entry = node.entry;
		let result: string;

		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					result = theme.fg("accent", "user: ") + content;
				} else if (role === "developer") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					result = theme.fg("dim", "developer: ") + theme.fg("muted", content);
				} else if (role === "assistant") {
					const presentation = resolveAssistantErrorPresentation(msg);
					if (presentation.kind === "compact-recovered") {
						result = theme.fg("success", "assistant: ") + theme.fg("dim", presentation.text);
						break;
					}
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					const textContent = normalize(this.#extractContent(msgWithContent.content));
					if (textContent) {
						result = theme.fg("success", "assistant: ") + textContent;
					} else if (presentation.kind === "full") {
						result =
							theme.fg("success", "assistant: ") + theme.fg("error", normalize(presentation.text).slice(0, 80));
					} else if (msgWithContent.stopReason === "aborted") {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
					} else {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
					}
				} else if (role === "toolResult") {
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					const toolCall = toolMsg.toolCallId ? this.#toolCallMap.get(toolMsg.toolCallId) : undefined;
					if (toolCall) {
						result = theme.fg("muted", this.#formatToolCall(toolCall.name, toolCall.arguments));
					} else {
						result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
					}
				} else if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
				} else {
					result = theme.fg("dim", `[${role}]`);
				}
				break;
			}
			case "custom_message": {
				const content =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map(c => c.text)
								.join("");
				result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
				break;
			}
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
				break;
			}
			case "branch_summary":
				result = theme.fg("warning", `[branch summary]: `) + normalize(entry.summary);
				break;
			case "model_change":
				result = theme.fg("dim", `[model: ${entry.model}]`);
				break;
			case "thinking_level_change":
				result = theme.fg("dim", `[thinking: ${entry.thinkingLevel ?? ThinkingLevel.Off}]`);
				break;
			case "custom":
				result = theme.fg("dim", `[custom: ${entry.customType}]`);
				break;
			case "label":
				result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
				break;
			default:
				result = "";
		}

		return isSelected ? theme.bold(result) : result;
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

	#formatToolCall(name: string, args: Record<string, unknown>): string {
		switch (name) {
			case "read": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				const offset = args.offset as number | undefined;
				const limit = args.limit as number | undefined;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					display += `:${start}${end ? `-${end}` : ""}`;
				}
				return `[read: ${display}]`;
			}
			case "write": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[write: ${path}]`;
			}
			case "edit": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[edit: ${path}]`;
			}
			case "bash": {
				const rawCmd = String(args.command || "");
				const cmd = rawCmd
					.replace(/[\n\t]/g, " ")
					.trim()
					.slice(0, 50);
				return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
			}
			case "grep": {
				const pattern = String(args.pattern || "");
				const searchPathsInput =
					typeof args.paths === "string" || Array.isArray(args.paths)
						? args.paths
						: typeof args.path === "string"
							? args.path
							: undefined;
				const paths = toPathList(searchPathsInput);
				const scope = paths.length > 0 ? paths.join(", ") : ".";
				return `[grep: /${pattern}/ in ${shortenPath(scope)}]`;
			}
			case "glob": {
				const globInput =
					typeof args.path === "string"
						? args.path
						: typeof args.paths === "string" || Array.isArray(args.paths)
							? args.paths
							: undefined;
				const paths = toPathList(globInput);
				const scope = paths.length > 0 ? paths.join(", ") : ".";
				return `[glob: ${shortenPath(scope)}]`;
			}
			case "ls": {
				const path = shortenPath(String(args.path || "."));
				return `[ls: ${path}]`;
			}
			default: {
				// Custom tool - show name and truncated JSON args
				const argsStr = JSON.stringify(args).slice(0, 40);
				return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
			}
		}
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
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.#filterMode);
			this.#filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
			this.#applyFilter();
		} else if (matchesKey(keyData, "ctrl+o")) {
			// Cycle filter forwards: default → no-tools → user-only → labeled-only → all → default
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.#filterMode);
			this.#filterMode = modes[(currentIndex + 1) % modes.length];
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
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		onSelect: (entryId: string) => void,
		private readonly onCancel: () => void,
		private readonly onLabelChangeCallback?: (entryId: string, label: string | undefined) => void,
		initialFilterMode: FilterMode = "default",
		/** Play the open unfold (TOUCH-5). Show site decides via modalRevealEnabled(). */
		reveal?: boolean,
	) {
		// The viewport is re-sized from the chrome plan on every frame; this seed
		// only has to be positive for the first centered window.
		this.#treeList = new TreeList(tree, currentLeafId, MIN_TREE_ROWS, initialFilterMode);
		this.#treeList.onSelect = onSelect;
		this.#treeList.onCancel = onCancel;
		this.#treeList.onLabelEdit = (entryId, currentLabel) => this.#showLabelInput(entryId, currentLabel);

		if (reveal) {
			this.#reveal.start(() => this.#onRequestRender?.());
		}

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
		// The pointer band fades only once the card has a repaint to lend it: the
		// frames between two mouse reports have no input to hang off. Same ambient
		// gate as the open unfold; without it the band is switched.
		this.#treeList.setHoverMotion({ requestRender: cb, enabled: modalRevealEnabled() });
	}

	/** Settle the reveal and the pointer band so no timer outlives a dismissed card. */
	dispose(): void {
		this.#reveal.stop();
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
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.#onRequestRender?.();
			})
		) {
			return true;
		}
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			// While the label editor owns the body, close means "abandon the edit"
			// — the same thing Esc does there — and the tree stays up.
			if (this.#labelInput) {
				this.#hideLabelInput();
				this.#onRequestRender?.();
				return true;
			}
			this.onCancel();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.handleInput("\n");
			return true;
		}
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

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = sizingForArea(MODAL_SIZING_LARGE, height);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		const query = this.#treeList.getSearchQuery();
		const searchLine = query
			? `${theme.fg("muted", "Search:")} ${theme.fg("accent", query)}`
			: theme.fg("dim", "Type to search");
		const chrome = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts: TREE_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			hasSearch: true,
		});

		let body: readonly string[];
		if (this.#labelInput) {
			body = this.#labelInput.render(dims.contentWidth);
		} else {
			// The tree owns the whole body minus the filter footer line the list
			// appends for a non-default filter; the shell truncates an overrun
			// silently, and the row it would eat is the one under the cursor.
			this.#treeList.setMaxVisibleLines(Math.max(MIN_TREE_ROWS, chrome.maxBodyRows - 1));
			body = this.#treeList.render(dims.contentWidth);
		}

		const shell = renderModalShell({
			title: "Session Tree",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			searchLine,
			shortcuts: TREE_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#listRowStart = shell.geometry?.bodyRowStart ?? 0;
		return applyModalReveal(shell, width, this.#reveal.value);
	}
}
