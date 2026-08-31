/**
 * Terminal drawing for the ask tool. The tool half in `ask.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import { type Component, Markdown, type MarkdownTheme, renderInlineMarkdown, Text } from "@veyyon/tui";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { getMarkdownTheme } from "../../theme/markdown-theme";
import type { Theme } from "../../theme/theme";
import { framedBlock, renderStatusLine } from "../../tui";
import { formatErrorMessage, formatMeta, formatTitle } from "../core/render-utils";
import { type AskToolDetails, optionMarker } from "./ask";

// =============================================================================
// TUI Renderer
// =============================================================================

interface AskRenderOption {
	label: string;
	description?: string;
}

interface AskRenderArgs {
	question?: string;
	options?: AskRenderOption[];
	multi?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		options: AskRenderOption[];
		multi?: boolean;
	}>;
}

/**
 * Coerce an untrusted option list (streamed or model-mangled call args) into
 * well-formed render options. Bare strings become labels; entries without a
 * string label are dropped.
 */
function normalizeRenderOptions(raw: unknown): AskRenderOption[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: AskRenderOption[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push({ label: entry });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const { label, description } = entry as Partial<AskRenderOption>;
		if (typeof label !== "string") continue;
		out.push(typeof description === "string" ? { label, description } : { label });
	}
	return out;
}

/**
 * Coerce untrusted `questions` call args into a renderable array. Models
 * occasionally double-encode the array as a JSON string — a bare string passes
 * a truthy `.length` check but has no `.map`, which used to crash the TUI
 * render loop. Partially streamed args can also be missing fields.
 */
function normalizeRenderQuestions(raw: unknown): NonNullable<AskRenderArgs["questions"]> | undefined {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(raw)) return undefined;
	const out: NonNullable<AskRenderArgs["questions"]> = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Partial<NonNullable<AskRenderArgs["questions"]>[number]>;
		out.push({
			id: typeof q.id === "string" ? q.id : "?",
			question: typeof q.question === "string" ? q.question : "",
			options: normalizeRenderOptions(q.options) ?? [],
			multi: q.multi === true,
		});
	}
	return out;
}

/** Render a custom free-text answer as a status line plus indented continuation rows. */
function renderCustomInputLines(uiTheme: Theme, customInput: string): string[] {
	const lines = customInput.split("\n");
	const out: string[] = [
		` ${uiTheme.styledSymbol("status.success", "success")} ${uiTheme.fg("toolOutput", lines[0] ?? "")}`,
	];
	for (let i = 1; i < lines.length; i++) out.push(`   ${uiTheme.fg("toolOutput", lines[i])}`);
	return out;
}

/** Render an answer note with tab replacement and line-width clamping. */
function renderNoteLines(uiTheme: Theme, note: string, width: number): string[] {
	const prefix = " Note: ";
	const continuationPrefix = "       ";
	const firstLineWidth = Math.max(1, width - visibleWidth(prefix));
	const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
	return replaceTabs(note)
		.split("\n")
		.map((line, index) => {
			const linePrefix = index === 0 ? `${uiTheme.fg("dim", " Note:")} ` : continuationPrefix;
			const maxWidth = index === 0 ? firstLineWidth : continuationWidth;
			return `${linePrefix}${uiTheme.fg("toolOutput", truncateToWidth(line, maxWidth))}`;
		});
}

/** Render the offered options for a question form as flat marker bullets (no tree guides). */
function renderQuestionOptionLines(
	uiTheme: Theme,
	mdTheme: MarkdownTheme,
	options: AskRenderOption[],
	multi: boolean | undefined,
): string[] {
	const out: string[] = [];
	for (const opt of options) {
		const optLabel = renderInlineMarkdown(opt.label, mdTheme, t => uiTheme.fg("muted", t));
		out.push(` ${uiTheme.fg("dim", optionMarker(uiTheme, multi, false))} ${optLabel}`);
		if (opt.description?.trim()) {
			const description = renderInlineMarkdown(opt.description.trim(), mdTheme, t => uiTheme.fg("dim", t));
			out.push(`   ${uiTheme.fg("dim", "↳")} ${description}`);
		}
	}
	return out;
}

/**
 * Render the answered option list for a question: every offered option with its
 * selection marker filled in, plus any custom free-text answer. Flat marker
 * bullets — the frame is the container, so no tree guides are drawn.
 */
function renderAnswerOptionLines(
	uiTheme: Theme,
	mdTheme: MarkdownTheme,
	options: string[] | undefined,
	selectedOptions: string[] | undefined,
	multi: boolean | undefined,
	customInput: string | undefined,
	note: string | undefined,
	width: number,
): string[] {
	const selected = new Set(selectedOptions ?? []);
	// Prefer the full recorded option set; fall back to the selected labels when
	// details omit the options array.
	const list = options && options.length > 0 ? options : (selectedOptions ?? []);

	// Nothing was chosen (and no custom answer) → a lone cancelled marker.
	if (selected.size === 0 && customInput === undefined && note === undefined) {
		return [` ${uiTheme.styledSymbol("status.warning", "warning")} ${uiTheme.fg("warning", "Cancelled")}`];
	}

	const out: string[] = [];
	for (const label of list) {
		const isSelected = selected.has(label);
		const marker = optionMarker(uiTheme, multi, isSelected);
		const markerStyled = isSelected ? uiTheme.fg("success", marker) : uiTheme.fg("dim", marker);
		const labelStyled = renderInlineMarkdown(label, mdTheme, t =>
			isSelected ? uiTheme.fg("toolOutput", t) : uiTheme.fg("muted", t),
		);
		out.push(` ${markerStyled} ${labelStyled}`);
	}
	if (customInput !== undefined) out.push(...renderCustomInputLines(uiTheme, customInput));
	if (note !== undefined) out.push(...renderNoteLines(uiTheme, note, width));
	return out;
}

export const askToolRenderer = {
	mergeCallAndResult: true,
	callIsLiveWidget: true,
	renderCall(args: AskRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const label = formatTitle("Ask", uiTheme);
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };
		const md = (text: string, width: number) =>
			new Markdown(text, 1, 0, mdTheme, accentStyle).render(Math.max(1, width - 3 + 1));

		// Multi-part questions: one divider-labelled section per question.
		// Call args are untrusted (partially streamed or model-mangled) and a
		// throw here takes down the whole TUI render loop — normalize first.
		const questions = normalizeRenderQuestions(args.questions);
		if (questions && questions.length > 0) {
			const header = `${label} ${uiTheme.fg("muted", `${questions.length} questions`)}`;
			return framedBlock(uiTheme, width => {
				const sections = questions.map(q => {
					const meta: string[] = [];
					if (q.multi) meta.push("multi");
					if (q.options?.length) meta.push(`options:${q.options.length}`);
					const metaStr = meta.length > 0 ? uiTheme.fg("dim", ` · ${meta.join(" · ")}`) : "";
					// md() returns a shared cached array (module-level Markdown LRU) — copy before appending.
					const mdLines = md(q.question, width);
					const lines = q.options?.length
						? [...mdLines, ...renderQuestionOptionLines(uiTheme, mdTheme, q.options, q.multi)]
						: mdLines;
					return { label: `${uiTheme.fg("dim", `[${q.id}]`)}${metaStr}`, lines };
				});
				return { header, sections, state: "pending", borderColor: "borderMuted", width };
			});
		}

		// Single question
		if (typeof args.question !== "string" || !args.question) {
			const errorLine = formatErrorMessage("No question provided", uiTheme);
			return framedBlock(uiTheme, width => ({
				header: errorLine,
				sections: [],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const question = args.question;
		const meta: string[] = [];
		if (args.multi) meta.push("multi");
		const questionOptions = normalizeRenderOptions(args.options);
		if (questionOptions?.length) meta.push(`options:${questionOptions.length}`);
		const header = `${label}${formatMeta(meta, uiTheme)}`;
		const multi = args.multi;
		return framedBlock(uiTheme, width => {
			// md() returns a shared cached array (module-level Markdown LRU) — copy before appending.
			const mdLines = md(question, width);
			const bodyLines = questionOptions?.length
				? [...mdLines, ...renderQuestionOptionLines(uiTheme, mdTheme, questionOptions, multi)]
				: mdLines;
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: "pending",
				borderColor: "borderMuted",
				width,
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AskToolDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const { details } = result;
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };
		const md = (text: string, width: number) =>
			new Markdown(text, 1, 0, mdTheme, accentStyle).render(Math.max(1, width - 3 + 1));

		if (!details) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			const header = renderStatusLine({ icon: "warning", title: "Ask" }, uiTheme);
			const body = fallback ? `\n${uiTheme.fg("dim", fallback)}` : "";
			return new Text(`${header}${body}`, 0, 0);
		}

		// Chat redirect: user chose "Chat about this" instead of answering.
		if (details.chatRedirect) {
			const header = renderStatusLine({ icon: "info", title: "Ask", meta: ["chat redirect"] }, uiTheme);
			const questions = details.questions ?? [];
			return framedBlock(uiTheme, width => ({
				header,
				sections: questions.length > 0 ? [{ lines: questions.flatMap(q => md(q, width)) }] : [],
				state: "warning",
				borderColor: "borderMuted",
				width,
			}));
		}

		// Multi-part results: one divider-labelled section per question.
		if (details.results && details.results.length > 0) {
			const results = details.results;
			const hasAnySelection = results.some(
				r =>
					r.customInput !== undefined ||
					r.note !== undefined ||
					(r.selectedOptions && r.selectedOptions.length > 0),
			);
			const header = renderStatusLine(
				{
					icon: hasAnySelection ? "success" : "warning",
					title: "Ask",
					meta: [`${results.length} questions`],
				},
				uiTheme,
			);
			return framedBlock(uiTheme, width => {
				const sections = results.map(r => {
					// md() returns a shared cached array (module-level Markdown LRU) — copy before appending.
					const lines = [
						...md(r.question, width),
						...renderAnswerOptionLines(
							uiTheme,
							mdTheme,
							r.options,
							r.selectedOptions,
							r.multi,
							r.customInput,
							r.note,
							width,
						),
					];
					return { label: uiTheme.fg("dim", `[${r.id}]`), lines };
				});
				return {
					header,
					sections,
					state: hasAnySelection ? "success" : "warning",
					borderColor: "borderMuted",
					width,
				};
			});
		}

		// Single question result
		if (!details.question) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			return new Text(fallback, 0, 0);
		}

		const question = details.question;
		const hasSelection =
			details.customInput !== undefined ||
			details.note !== undefined ||
			(details.selectedOptions && details.selectedOptions.length > 0);
		const header = renderStatusLine(
			hasSelection
				? { iconOverride: uiTheme.styledSymbol("tool.ask", "accent"), title: "Ask" }
				: { icon: "warning", title: "Ask" },
			uiTheme,
		);
		const dOptions = details.options;
		const dSelected = details.selectedOptions;
		const dMulti = details.multi;
		const dCustom = details.customInput;
		const dNote = details.note;
		const dTimedOut = details.timedOut;
		return framedBlock(uiTheme, width => {
			// md() returns a shared cached array (module-level Markdown LRU) — copy before appending.
			const bodyLines = [
				...md(question, width),
				...renderAnswerOptionLines(uiTheme, mdTheme, dOptions, dSelected, dMulti, dCustom, dNote, width),
			];
			if (dTimedOut) {
				// Distinguish auto-selection from a real user choice in the transcript.
				bodyLines.push(uiTheme.fg("dim", "auto-selected after timeout — not a user choice"));
			}
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: hasSelection ? "success" : "warning",
				borderColor: "borderMuted",
				width,
			};
		});
	},
};
