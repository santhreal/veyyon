export type CompactionKind = "local" | "openai-remote" | "azure-remote" | "codex-remote";

export interface CompactionSummaryView {
	kind: "compaction-summary";
	summary: string;
	tokensBefore: number;
	compactedBy?: string;
	warning?: string;
}

export interface BranchSummaryView {
	kind: "branch-summary";
	summary: string;
}

export interface HandoffSummaryView {
	kind: "handoff-summary";
	summary: string;
}

export type SummaryMessageView = CompactionSummaryView | BranchSummaryView | HandoffSummaryView;
