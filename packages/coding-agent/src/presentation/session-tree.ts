/**
 * The session tree as a host draws it: the order and indent of its rows, the
 * filter modes that show each row, and the one line each row reads. The
 * terminal's `/tree` picker and the desktop's tree sheet both read this, so an
 * entry sits, filters and reads the same in either host.
 */
import { ThinkingLevel } from "@veyyon/agent-core";
import type { SessionTreeNode } from "@veyyon/kernel/session/session-entries";
import { truncateToWidth } from "@veyyon/utils/width";
import type { TreeFilterMode } from "../config/settings-schema";
import type { ThemeColor } from "../theme/theme";
import { shortenPath, TRUNCATE_LENGTHS } from "../tools/core/render-utils";
import { canonicalizeMessage } from "../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "./transcript-builder";

/** A vertical line an ancestor branch point draws down the rows beneath it. */
export interface TreeGutter {
	/** The drawn level of the connector the line continues. */
	position: number;
	/** `│` while more siblings follow below, a space under the last one. */
	show: boolean;
}

/** One entry of the tree in the order it is drawn. */
export interface FlatTreeNode {
	node: SessionTreeNode;
	/**
	 * The level the row is drawn at: a single-child chain stays flat and a
	 * branch point indents its children. Several roots hang under a virtual
	 * branching root that is not drawn, so its level is not counted.
	 */
	depth: number;
	/** The row draws a connector (`├─` or `└─`): its parent has more than one child. */
	showConnector: boolean;
	/** With a connector, the row is the last sibling (`└─`) rather than one of several (`├─`). */
	isLast: boolean;
	/** The lines of every ancestor branch point that pass this row. */
	gutters: TreeGutter[];
	/** The row is a root under the virtual branching root of a tree with several roots. */
	isVirtualRootChild: boolean;
}

/** A tool call as a tool result row names it. */
export interface TreeToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** The rows of a tree, and the tool calls its tool results are named after. */
export interface FlattenedSessionTree {
	nodes: FlatTreeNode[];
	/** Every tool call an assistant entry made, by call id. */
	toolCalls: Map<string, TreeToolCall>;
}

/** One row's line: a role marker in its own tone, then the rest of the row. */
export interface TreeEntryRow {
	/** The role marker (`user: `, `[branch summary]: `), or empty when the whole row is one tone. */
	prefix: string;
	prefixTone: ThemeColor | undefined;
	text: string;
	/** The tone of `text`; none draws it in the row's default. */
	textTone: ThemeColor | undefined;
}

/** The length a row keeps of an entry's text before cutting it. */
const ENTRY_TEXT_LIMIT = 200;

/**
 * Flatten `roots` into the rows a tree draws, in pre-order with the branch
 * holding `leafId` first at every level.
 *
 * Indentation: at level 0 a row stays at 0 unless its parent has more than one
 * child; the first generation under a branch point at level 1 or deeper goes one
 * further, grouping the subtree; deeper single-child chains stay flat.
 */
export function flattenSessionTree(roots: readonly SessionTreeNode[], leafId: string | null): FlattenedSessionTree {
	const nodes: FlatTreeNode[] = [];
	const toolCalls = new Map<string, TreeToolCall>();
	const multipleRoots = roots.length > 1;

	// Which subtrees hold the leaf, so the current branch is drawn first. A
	// pre-order list walked backwards visits children before parents without
	// recursing, which a deep session would overflow.
	const containsActive = new Map<SessionTreeNode, boolean>();
	const preOrder: SessionTreeNode[] = [];
	const preOrderStack = roots.slice();
	while (preOrderStack.length > 0) {
		const node = preOrderStack.pop()!;
		preOrder.push(node);
		for (let i = node.children.length - 1; i >= 0; i--) preOrderStack.push(node.children[i]);
	}
	for (let i = preOrder.length - 1; i >= 0; i--) {
		const node = preOrder[i];
		let has = leafId !== null && node.entry.id === leafId;
		for (const child of node.children) {
			if (containsActive.get(child)) has = true;
		}
		containsActive.set(node, has);
	}

	// Stack items: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild].
	// Several roots are children of a virtual root that branches.
	type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, TreeGutter[], boolean];
	const stack: StackItem[] = [];
	const orderedRoots = roots.slice().sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
	for (let i = orderedRoots.length - 1; i >= 0; i--) {
		const isLast = i === orderedRoots.length - 1;
		stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
	}

	while (stack.length > 0) {
		const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;
		const entry = node.entry;
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type === "toolCall") toolCalls.set(block.id, { name: block.name, arguments: block.arguments });
			}
		}

		const depth = multipleRoots ? Math.max(0, indent - 1) : indent;
		nodes.push({ node, depth, showConnector, isLast, gutters, isVirtualRootChild });

		const children = node.children;
		const multipleChildren = children.length > 1;
		const prioritized: SessionTreeNode[] = [];
		const rest: SessionTreeNode[] = [];
		for (const child of children) (containsActive.get(child) ? prioritized : rest).push(child);
		const orderedChildren = prioritized.concat(rest);

		// A branch point indents its children; so does the first generation
		// after a branch below level 0; a single-child chain stays flat.
		const childIndent = multipleChildren || (justBranched && indent > 0) ? indent + 1 : indent;

		// A displayed connector (not a virtual root child's) continues down its
		// descendants as a gutter at the connector's level.
		const connectorDisplayed = showConnector && !isVirtualRootChild;
		const connectorPosition = Math.max(0, depth - 1);
		const childGutters = connectorDisplayed
			? gutters.concat([{ position: connectorPosition, show: !isLast }])
			: gutters;

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

	return { nodes, toolCalls };
}

/** The ids on the path from the root to `leafId`. */
export function sessionTreeActivePath(nodes: readonly FlatTreeNode[], leafId: string | null): Set<string> {
	const path = new Set<string>();
	const byId = new Map<string, FlatTreeNode>();
	for (const flat of nodes) byId.set(flat.node.entry.id, flat);
	let currentId = leafId;
	while (currentId) {
		path.add(currentId);
		const flat = byId.get(currentId);
		if (!flat) break;
		currentId = flat.node.entry.parentId ?? null;
	}
	return path;
}

/**
 * Whether filter `mode` shows `node`. An assistant turn holding only tool calls
 * shows in none, unless it is the current leaf, which always stays visible, or
 * it ended in an error or an abort.
 */
export function isTreeEntryShown(node: SessionTreeNode, mode: TreeFilterMode, leafId: string | null): boolean {
	const entry = node.entry;
	if (entry.type === "message" && entry.message.role === "assistant" && entry.id !== leafId) {
		const { stopReason } = entry.message;
		const endedAbnormally = Boolean(stopReason) && stopReason !== "stop" && stopReason !== "toolUse";
		if (!hasText(entry.message.content) && !endedAbnormally) return false;
	}

	// Settings, titles, lifecycle markers and labels: bookkeeping, which the
	// default view hides. The conversation is its messages and what replaced them.
	const isBookkeeping =
		entry.type !== "message" &&
		entry.type !== "custom_message" &&
		entry.type !== "compaction" &&
		entry.type !== "branch_summary";
	switch (mode) {
		case "user-only":
			return entry.type === "message" && entry.message.role === "user";
		case "no-tools":
			return !isBookkeeping && !(entry.type === "message" && entry.message.role === "toolResult");
		case "labeled-only":
			return node.label !== undefined;
		case "all":
			return true;
		default:
			return !isBookkeeping;
	}
}

/** The text blocks of a message's content, joined and cut at the row limit. */
export function treeEntryText(content: unknown): string {
	if (typeof content === "string") return content.slice(0, ENTRY_TEXT_LIMIT);
	if (!Array.isArray(content)) return "";
	let result = "";
	for (const block of content) {
		if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		result += block.text;
		if (result.length >= ENTRY_TEXT_LIMIT) return result.slice(0, ENTRY_TEXT_LIMIT);
	}
	return result;
}

/** The line a row reads for `node`, with each part's tone. */
export function treeEntryRow(node: SessionTreeNode, toolCalls: ReadonlyMap<string, TreeToolCall>): TreeEntryRow {
	const entry = node.entry;
	// The tag as written, for an entry a newer writer added after this build.
	const tag: string = entry.type;
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			switch (message.role) {
				case "user":
					return marked("user: ", "accent", normalize(treeEntryText(message.content)));
				case "developer":
					return marked("developer: ", "dim", normalize(treeEntryText(message.content)), "muted");
				case "assistant": {
					const presentation = resolveAssistantErrorPresentation(message);
					if (presentation.kind === "compact-recovered") {
						return marked("assistant: ", "success", presentation.text, "dim");
					}
					const text = normalize(treeEntryText(message.content));
					if (text) return marked("assistant: ", "success", text);
					if (presentation.kind === "full") {
						return marked("assistant: ", "success", normalize(presentation.text).slice(0, 80), "error");
					}
					if (message.stopReason === "aborted") return marked("assistant: ", "success", "(aborted)", "muted");
					return marked("assistant: ", "success", "(no content)", "muted");
				}
				case "toolResult": {
					const call = toolCalls.get(message.toolCallId);
					return whole(
						call ? formatToolCall(call.name, call.arguments) : `[${message.toolName ?? "tool"}]`,
						"muted",
					);
				}
				case "bashExecution":
					return whole(`[bash]: ${normalize(message.command ?? "")}`, "dim");
				default:
					return whole(`[${message.role}]`, "dim");
			}
		}
		case "custom_message": {
			const content =
				typeof entry.content === "string"
					? entry.content
					: entry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
			return marked(`[${entry.customType}]: `, "customMessageLabel", normalize(content));
		}
		case "compaction":
			return whole(`[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`, "borderAccent");
		case "branch_summary":
			return marked("[branch summary]: ", "warning", normalize(entry.summary));
		case "model_change":
			return whole(`[model: ${entry.model}]`, "dim");
		case "thinking_level_change":
			return whole(`[thinking: ${entry.thinkingLevel ?? ThinkingLevel.Off}]`, "dim");
		case "custom":
			return whole(`[custom: ${entry.customType}]`, "dim");
		case "label":
			return whole(`[label: ${entry.label ?? "(cleared)"}]`, "dim");
		case "service_tier_change": {
			const tiers = Object.entries(entry.serviceTier ?? {}).map(([family, tier]) => `${family} ${tier}`);
			return whole(`[service tier: ${tiers.join(", ") || "default"}]`, "dim");
		}
		case "title_change":
			return whole(`[title: ${normalize(entry.title)}]`, "dim");
		case "mode_change":
			return whole(`[mode: ${entry.mode}]`, "dim");
		case "ttsr_injection":
			return whole(`[rules: ${entry.injectedRules.join(", ")}]`, "dim");
		case "mcp_tool_selection":
			return whole(`[mcp tools: ${entry.selectedToolNames.join(", ") || "none"}]`, "dim");
		case "session_init":
			return whole("[session start]", "dim");
		case "subagent_spawn":
			return whole(`[agent ${entry.agentName}: ${entry.status}]`, "dim");
		case "settings_snapshot":
			return whole(
				entry.kind === "full" ? "[settings]" : `[settings: ${Object.keys(entry.values).join(", ")}]`,
				"dim",
			);
		case "session_lifecycle":
			return whole(`[session ${entry.state}: ${entry.reason}]`, "dim");
		case "session_checkpoint":
			return whole("[checkpoint]", "dim");
		default: {
			// A new entry type fails to compile here; one a newer file wrote
			// still reads as its type.
			const _exhaustive: never = entry;
			return whole(`[${tag}]`, "dim");
		}
	}
}

function marked(prefix: string, prefixTone: ThemeColor, text: string, textTone?: ThemeColor): TreeEntryRow {
	return { prefix, prefixTone, text, textTone };
}

function whole(text: string, textTone: ThemeColor): TreeEntryRow {
	return { prefix: "", prefixTone: undefined, text, textTone };
}

function normalize(text: string): string {
	return text.replace(/[\n\t]/g, " ").trim();
}

function hasText(content: unknown): boolean {
	if (typeof content === "string") return Boolean(canonicalizeMessage(content));
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string" && canonicalizeMessage(block.text)) return true;
	}
	return false;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "read": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let display = path;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				display += `:${start}${end ? `-${end}` : ""}`;
			}
			return `[read: ${display}]`;
		}
		case "write":
			return `[write: ${shortenPath(String(args.path || args.file_path || ""))}]`;
		case "edit":
			return `[edit: ${shortenPath(String(args.path || args.file_path || ""))}]`;
		case "bash": {
			const rawCmd = String(args.command || "");
			const cmd = rawCmd
				.replace(/[\n\t]/g, " ")
				.trim()
				.slice(0, 50);
			return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
		}
		case "search": {
			const type = String(args.type || "?");
			const input = String(args.input || "");
			const scope = typeof args.path === "string" ? ` in ${shortenPath(args.path)}` : "";
			return `[search:${type} ${input}${scope}]`;
		}
		case "ls":
			return `[ls: ${shortenPath(String(args.path || "."))}]`;
		default: {
			// A custom tool: its name and its arguments as truncated JSON.
			const rawArgs = typeof args === "string" ? args : JSON.stringify(args ?? {});
			return `[${name}: ${truncateToWidth(rawArgs ?? "{}", TRUNCATE_LENGTHS.SHORT)}]`;
		}
	}
}
