import { OptionalChainRemovalMutation } from "./access";
import { CallArgumentSwapMutation } from "./call";
import { DuplicateLineLiteralFlipMutation } from "./duplicate";
import { IdentifierMultiEditMutation } from "./identifier";
import { SwapNamedImportsMutation } from "./import";
import { BooleanLiteralFlipMutation, OffByOneMutation } from "./literal";
import {
	NullishCoalescingSwapMutation,
	RemoveNegationMutation,
	SwapArithmeticMutation,
	SwapComparisonMutation,
	SwapEqualityMutation,
	SwapIncDecMutation,
	SwapLogicalMutation,
} from "./operator";
import { RegexQuantifierSwapMutation } from "./regex";
import {
	DeleteStatementMutation,
	RemoveEarlyReturnMutation,
	SwapAdjacentLinesMutation,
	SwapIfElseBranchesMutation,
} from "./structural";
import type { Mutation } from "./types";
import { UnicodeHyphenMutation } from "./unicode";

export class MutationNotFoundError extends Error {
	constructor(id: string, available: readonly string[]) {
		const formatted = available.length > 0 ? available.join(", ") : "(none)";
		super(`Unknown mutation "${id}". Registered mutations: ${formatted}`);
		this.name = "MutationNotFoundError";
	}
}

export class DuplicateMutationError extends Error {
	constructor(id: string) {
		super(`A different mutation is already registered as "${id}".`);
		this.name = "DuplicateMutationError";
	}
}

export class MutationRegistry {
	readonly #members = new Map<string, Mutation>();

	register(member: Mutation): void {
		const existing = this.#members.get(member.id);
		if (existing === member) return;
		if (existing) throw new DuplicateMutationError(member.id);
		this.#members.set(member.id, member);
	}

	get(id: string): Mutation | undefined {
		return this.#members.get(id);
	}

	has(id: string): boolean {
		return this.#members.has(id);
	}

	list(): readonly Mutation[] {
		return [...this.#members.values()];
	}

	listIds(): readonly string[] {
		return [...this.#members.keys()];
	}

	require(id: string): Mutation {
		const member = this.#members.get(id);
		if (!member) throw new MutationNotFoundError(id, this.listIds());
		return member;
	}

	categoryMap(): Record<string, string[]> {
		const map: Record<string, string[]> = {};
		for (const member of this.#members.values()) {
			const category = member.category;
			const list = map[category] ?? [];
			list.push(member.id);
			map[category] = list;
		}
		return map;
	}

	clear(): void {
		this.#members.clear();
	}
}

const defaultRegistry = new MutationRegistry();

export function registerMutation(mutation: Mutation): void {
	defaultRegistry.register(mutation);
}

export function requireMutation(id: string): Mutation {
	return defaultRegistry.require(id);
}

export function getMutation(id: string): Mutation | undefined {
	return defaultRegistry.get(id);
}

export function allMutations(): readonly Mutation[] {
	return defaultRegistry.list();
}

export function mutationIds(): readonly string[] {
	return defaultRegistry.listIds();
}

export function mutationCategoryMap(): Record<string, string[]> {
	return defaultRegistry.categoryMap();
}

export function clearMutationRegistry(): void {
	defaultRegistry.clear();
}

export const BUILTIN_MUTATIONS: readonly Mutation[] = [
	new SwapComparisonMutation(),
	new SwapEqualityMutation(),
	new SwapLogicalMutation(),
	new RemoveNegationMutation(),
	new SwapIncDecMutation(),
	new SwapArithmeticMutation(),
	new BooleanLiteralFlipMutation(),
	new OptionalChainRemovalMutation(),
	new CallArgumentSwapMutation(),
	new NullishCoalescingSwapMutation(),
	new RegexQuantifierSwapMutation(),
	new UnicodeHyphenMutation(),
	new IdentifierMultiEditMutation(),
	new DuplicateLineLiteralFlipMutation(),
	new SwapAdjacentLinesMutation(),
	new SwapIfElseBranchesMutation(),
	new RemoveEarlyReturnMutation(),
	new SwapNamedImportsMutation(),
	new DeleteStatementMutation(),
	new OffByOneMutation(),
];

export function registerBuiltinMutations(): void {
	for (const mutation of BUILTIN_MUTATIONS) {
		registerMutation(mutation);
	}
}

registerBuiltinMutations();

export const ALL_MUTATIONS: readonly Mutation[] = BUILTIN_MUTATIONS;
export const CATEGORY_MAP: Record<string, string[]> = defaultRegistry.categoryMap();
