import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

/**
 * Code mutations for edit benchmark generation.
 *
 * Each mutation introduces a subtle bug that tests edit precision, not bug-finding
 * ability. The mutation can be trivial - what matters is whether the model can
 * surgically apply the patch in difficult contexts.
 */
export interface MutationInfo {
	lineNumber: number;
	originalSnippet: string;
	mutatedSnippet: string;
}

export interface Mutation {
	readonly id: string;
	readonly name: string;
	readonly category: string;
	readonly fixHint: string;
	readonly isMultiEdit: boolean;
	readonly isStructural: boolean;
	readonly allowsMultipleHunks: boolean;

	canApply(content: string): boolean;
	mutate(content: string, rng: () => number): [string, MutationInfo];
	describe(info: MutationInfo): string;
}

export type Candidate<TNode extends t.Node = t.Node, TMeta = unknown> = {
	path: NodePath<TNode>;
	meta?: TMeta;
};

export type SourceRange = {
	start: number;
	end: number;
};

export type SourceEdit = SourceRange & {
	replacement: string;
};

export type Parsed = {
	ast: t.File;
	code: string;
};
