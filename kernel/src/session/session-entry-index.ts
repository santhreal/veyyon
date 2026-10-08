import type { Usage } from "@veyyon/ai";
import { isRecord } from "@veyyon/utils/type-guards";
import { walkBranchPath } from "./session-context";
import type { SessionEntry, SessionTreeNode, UsageStatistics } from "./session-entries";

export function emptyUsageStatistics(): UsageStatistics {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
	};
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (!isRecord(details)) return undefined;
	const maybeUsage = details.usage;
	if (maybeUsage === null || typeof maybeUsage !== "object") return undefined;
	// A task result's details are written by the task tool, whose `usage` is the child's `Usage`.
	const usage = maybeUsage as Usage;
	return usage;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

/** Add what `entry` spent to `target`, as {@link SessionEntryIndex} counts it. */
export function addEntryUsage(target: UsageStatistics, entry: SessionEntry): void {
	addUsage(target, entryUsage(entry));
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

/**
 * Maintains the derived views over a session's entry list: id lookup, the
 * resolved label map, the active leaf, and the running usage totals. Kept in
 * lockstep with the manager's `#entries` so reads stay O(1) instead of
 * rescanning the whole journal.
 */
export class SessionEntryIndex {
	/**
	 * Id → entry, as a null-prototype object rather than a `Map`, so an id such as `__proto__` or
	 * `toString` is an own key like any other. A `Map` of the 108,163 ids of a resumed session held
	 * 5.70 MiB of heap and answered 540,815 lookups in 13.9 ms; the object holds 2.92 MiB and
	 * answers them in 7.7 ms.
	 */
	#entriesById: Record<string, SessionEntry | undefined> = Object.create(null);
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#usage = emptyUsageStatistics();
	/**
	 * Root→leaf path of `#leaf`, or undefined until a reader asks for it. An empty index holds the
	 * empty path, so a rebuild of a session that never branches ends holding its whole path. An
	 * append to the leaf extends it in place; anything else that can change the walk (a leaf move,
	 * an insert off the leaf, a shadowed id) drops it. Every startup reader walks the active branch,
	 * and the walk of the 108,163 entries of a resumed session cost 18 ms, nearly all of it the
	 * lookup of each parent id.
	 */
	#leafPath: SessionEntry[] | undefined = [];

	clear(): void {
		this.#entriesById = Object.create(null);
		this.#labels.clear();
		this.#leaf = null;
		this.#leafPath = [];
		this.#usage = emptyUsageStatistics();
	}

	/**
	 * Index `entries` from scratch. `usage` is their totals when the caller already folded them in
	 * this order with {@link addEntryUsage}: a load that moves entries to disk as it reads them
	 * folds each one first, and the fold here would read each moved one back.
	 */
	rebuild(entries: readonly SessionEntry[], usage?: UsageStatistics): void {
		this.clear();
		for (const entry of entries) this.#link(entry);
		if (usage !== undefined) this.#usage = { ...usage };
		else for (const entry of entries) addEntryUsage(this.#usage, entry);
	}

	insert(entry: SessionEntry): void {
		this.#link(entry);
		addEntryUsage(this.#usage, entry);
	}

	#link(entry: SessionEntry): void {
		// The new leaf's path is the old leaf's path plus this entry exactly when it hangs off the
		// old leaf, null included, and does not shadow an id already in the index. An empty id is
		// never extended onto: a walk from the empty leaf finds no entry.
		const leafPath =
			this.#leafPath !== undefined &&
			entry.parentId === this.#leaf &&
			entry.id !== "" &&
			this.#entriesById[entry.id] === undefined
				? this.#leafPath
				: undefined;
		this.#entriesById[entry.id] = entry;
		this.#leaf = entry.id;
		leafPath?.push(entry);
		this.#leafPath = leafPath;

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}
	}

	has(id: string): boolean {
		return this.#entriesById[id] !== undefined;
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById[id];
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById[this.#leaf] : undefined;
	}

	setLeaf(id: string | null): void {
		if (id !== this.#leaf) this.#leafPath = undefined;
		this.#leaf = id;
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		return id === this.#leaf ? this.leafPath().slice() : walkBranchPath(this, this.#lookup(id));
	}

	/**
	 * The active branch, root→leaf. Shared with the index: read it, never mutate
	 * it. {@link pathTo} returns a copy for callers that keep or edit the array.
	 */
	leafPath(): readonly SessionEntry[] {
		this.#leafPath ??= walkBranchPath(this, this.#lookup(this.#leaf));
		return this.#leafPath;
	}

	#lookup(id: string | null | undefined): SessionEntry | undefined {
		return id ? this.#entriesById[id] : undefined;
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = roots.slice();
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			for (let ci = 0; ci < node.children.length; ci++) stack.push(node.children[ci]!);
		}

		return roots;
	}
}
