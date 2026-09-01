import { ToolError } from "../tools/tool-errors";

export interface PlanApprovalDetails {
	planFilePath: string;
	title: string;
	planExists: boolean;
}

export function normalizePlanTitle(title: string): { title: string; fileName: string } {
	const trimmed = title.trim();
	if (!trimmed) {
		throw new ToolError("Plan title is required and must not be empty.");
	}

	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
		throw new ToolError("Plan title must not contain path separators or '..'.");
	}

	const withoutExt = trimmed.replace(/\.md$/i, "");
	const sanitized = withoutExt
		.replace(/\s+/g, "-")
		.replace(/[^A-Za-z0-9_-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!sanitized) {
		throw new ToolError(
			"Plan title must contain at least one letter, number, underscore, or hyphen after sanitization.",
		);
	}

	const fileName = `${sanitized}.md`;
	return { title: sanitized, fileName };
}

export function resolvePlanTitle(input: { suppliedTitle?: unknown; planContent: string; planFilePath: string }): {
	title: string;
	fileName: string;
	source: "supplied" | "heading" | "filename" | "default";
} {
	const candidates: Array<{ value: string; source: "supplied" | "heading" | "filename" | "default" }> = [];
	if (typeof input.suppliedTitle === "string") {
		const trimmed = input.suppliedTitle.trim();
		if (trimmed) candidates.push({ value: trimmed, source: "supplied" });
	}
	const heading = firstLevelOneHeading(input.planContent);
	if (heading) candidates.push({ value: heading, source: "heading" });
	const stem = planFilenameStem(input.planFilePath);
	if (stem) candidates.push({ value: stem, source: "filename" });
	candidates.push({ value: "plan", source: "default" });

	for (const candidate of candidates) {
		try {
			const normalized = normalizePlanTitle(candidate.value);
			return { ...normalized, source: candidate.source };
		} catch {}
	}
	return { title: "plan", fileName: "plan.md", source: "default" };
}

function firstLevelOneHeading(planContent: string): string {
	const match = planContent.match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m);
	return match?.[1]?.trim() ?? "";
}

function planFilenameStem(planFilePath: string): string {
	const withoutScheme = planFilePath.replace(/^local:\/+/, "");
	const lastSegment = withoutScheme.split(/[\\/]/).pop() ?? "";
	return lastSegment.replace(/\.md$/i, "");
}

export function humanizePlanTitle(title: string): string {
	const spaced = title.replace(/[-_]+/g, " ").trim();
	if (!spaced) return "";
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function planFileUrlForSlug(slug: string): string {
	return `local://${slug}-plan.md`;
}

function planSlugFromSupplied(suppliedTitle: unknown): string | undefined {
	if (typeof suppliedTitle !== "string" || !suppliedTitle.trim()) return undefined;
	try {
		const { title } = normalizePlanTitle(suppliedTitle);
		const slug = title.replace(/-plan$/i, "");
		return slug || title;
	} catch {
		return undefined;
	}
}

export interface ResolveApprovedPlanInput {
	suppliedTitle?: unknown;
	statePlanFilePath: string;
	readPlan: (planUrl: string) => Promise<string | null>;
	listPlanFiles?: () => Promise<string[]>;
}

export interface ResolvedApprovedPlan {
	planFilePath: string;
	planContent: string;
	title: string;
}

export async function resolveApprovedPlan(input: ResolveApprovedPlanInput): Promise<ResolvedApprovedPlan> {
	const ordered: string[] = [];
	const consider = (url: string | undefined): void => {
		if (url && !ordered.includes(url)) ordered.push(url);
	};

	const slug = planSlugFromSupplied(input.suppliedTitle);
	consider(slug ? planFileUrlForSlug(slug) : undefined);
	consider(input.statePlanFilePath);

	for (const url of ordered) {
		const content = await input.readPlan(url);
		if (content !== null) return finalizeApprovedPlan(url, content, input.suppliedTitle);
	}

	if (input.listPlanFiles) {
		for (const url of await input.listPlanFiles()) {
			if (ordered.includes(url)) continue;
			const content = await input.readPlan(url);
			if (content !== null) return finalizeApprovedPlan(url, content, input.suppliedTitle);
		}
	}

	const target = ordered[0] ?? input.statePlanFilePath;
	throw new ToolError(
		`Plan file not found at ${target}. Write the finalized plan to ${target} before requesting approval.`,
	);
}

function finalizeApprovedPlan(planFilePath: string, planContent: string, suppliedTitle: unknown): ResolvedApprovedPlan {
	const { title } = resolvePlanTitle({ suppliedTitle, planContent, planFilePath });
	return { planFilePath, planContent, title };
}
