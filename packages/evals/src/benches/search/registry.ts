/**
 * The three axes of the search bench, each populated by explicit registration.
 *
 * A corpus, a case suite and an arm are all values, so extending the bench along any axis
 * is a registration rather than an edit to the runner. Following the package's rule, nothing
 * here scans the filesystem: a member that no index module registers does not exist, and a
 * lookup for an unregistered id refuses while naming what is registered.
 *
 * Registration is idempotent for an identical member and refuses a different member under a
 * name already taken, because the registry is process-wide: two test files that both call
 * `registerBuiltinSearchBench()` must not fight, while a redefinition under a taken id is a
 * collision the run should not silently resolve.
 */
import { DIRECT_ENGINE_ARM, type SearchArm, UNIFIED_TOOL_ARM } from "./arms";
import { MONOREPO_SCOPING_SUITE, type SearchCaseSuite, UNIFIED_SEARCH_SUITE } from "./cases";
import { MONOREPO_CORPUS, type SearchCorpusSpec, TYPESCRIPT_PROJECT_CORPUS } from "./corpus";

/** What kind of member a refusal is about, so the message names the axis. */
export type SearchBenchAxis = "corpus" | "case suite" | "arm";

export class SearchBenchMemberNotFoundError extends Error {
	constructor(axis: SearchBenchAxis, id: string, available: readonly string[]) {
		const formatted = available.length > 0 ? available.join(", ") : "(none)";
		super(`Unknown search bench ${axis} "${id}". Registered ${axis}s: ${formatted}`);
		this.name = "SearchBenchMemberNotFoundError";
	}
}

export class DuplicateSearchBenchMemberError extends Error {
	constructor(axis: SearchBenchAxis, id: string) {
		super(`A different search bench ${axis} is already registered as "${id}".`);
		this.name = "DuplicateSearchBenchMemberError";
	}
}

class SearchBenchAxisRegistry<T extends { readonly id: string }> {
	readonly #members = new Map<string, T>();
	readonly #axis: SearchBenchAxis;

	constructor(axis: SearchBenchAxis) {
		this.#axis = axis;
	}

	register(member: T): void {
		const existing = this.#members.get(member.id);
		if (existing === member) return;
		if (existing) throw new DuplicateSearchBenchMemberError(this.#axis, member.id);
		this.#members.set(member.id, member);
	}

	get(id: string): T | undefined {
		return this.#members.get(id);
	}

	has(id: string): boolean {
		return this.#members.has(id);
	}

	list(): readonly T[] {
		return [...this.#members.values()];
	}

	listIds(): readonly string[] {
		return [...this.#members.keys()];
	}

	require(id: string): T {
		const member = this.#members.get(id);
		if (!member) throw new SearchBenchMemberNotFoundError(this.#axis, id, this.listIds());
		return member;
	}
}

const corpora = new SearchBenchAxisRegistry<SearchCorpusSpec>("corpus");
const caseSuites = new SearchBenchAxisRegistry<SearchCaseSuite>("case suite");
const arms = new SearchBenchAxisRegistry<SearchArm>("arm");

export function registerSearchCorpus(spec: SearchCorpusSpec): void {
	corpora.register(spec);
}

export function registerSearchCaseSuite(suite: SearchCaseSuite): void {
	caseSuites.register(suite);
}

export function registerSearchArm(arm: SearchArm): void {
	arms.register(arm);
}

export function requireSearchCorpus(id: string): SearchCorpusSpec {
	return corpora.require(id);
}

export function requireSearchCaseSuite(id: string): SearchCaseSuite {
	return caseSuites.require(id);
}

export function requireSearchArm(id: string): SearchArm {
	return arms.require(id);
}

export function searchCorpora(): readonly SearchCorpusSpec[] {
	return corpora.list();
}

export function searchCaseSuites(): readonly SearchCaseSuite[] {
	return caseSuites.list();
}

export function searchArms(): readonly SearchArm[] {
	return arms.list();
}

export function searchCorpusIds(): readonly string[] {
	return corpora.listIds();
}

export function searchCaseSuiteIds(): readonly string[] {
	return caseSuites.listIds();
}

export function searchArmIds(): readonly string[] {
	return arms.listIds();
}

/**
 * Register everything this package ships.
 *
 * Every entrypoint calls this — the CLI, each test file that drives a run — and calling it
 * twice is a no-op rather than a duplicate-id refusal.
 */
export function registerBuiltinSearchBench(): void {
	registerSearchCorpus(TYPESCRIPT_PROJECT_CORPUS);
	registerSearchCorpus(MONOREPO_CORPUS);
	registerSearchCaseSuite(UNIFIED_SEARCH_SUITE);
	registerSearchCaseSuite(MONOREPO_SCOPING_SUITE);
	registerSearchArm(UNIFIED_TOOL_ARM);
	registerSearchArm(DIRECT_ENGINE_ARM);
}
