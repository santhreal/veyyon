import { DEFAULT_SIGIL, SUPPORTED_VERSION } from "./constants.js";
import type { AgentDict, HandleMeta, Vocabulary } from "./types.js";

export class ArgotConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgotConflictError";
	}
}

export function unionVocabularies(vocabs: Vocabulary[]): Vocabulary {
	const handles = new Map<string, string>();
	const meta = new Map<string, HandleMeta>();
	let sigil: string | undefined;

	for (const vocab of vocabs) {
		if (vocab.handles.size === 0) {
			continue;
		}
		if (sigil === undefined) {
			sigil = vocab.sigil;
		} else if (vocab.sigil !== sigil) {
			throw new ArgotConflictError(
				`cannot combine vocabularies with different sigils: "${sigil}" and "${vocab.sigil}"`,
			);
		}
		for (const [name, expansion] of vocab.handles) {
			const existing = handles.get(name);
			if (existing !== undefined && existing !== expansion) {
				throw new ArgotConflictError(
					`handle "${name}" is defined twice with different expansions: "${existing}" and "${expansion}"`,
				);
			}
			handles.set(name, expansion);
		}
		for (const [name, entry] of vocab.meta) {
			if (!meta.has(name)) {
				meta.set(name, entry);
			}
		}
	}

	return { version: SUPPORTED_VERSION, sigil: sigil ?? DEFAULT_SIGIL, handles, meta };
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function makeExpander(vocab: Vocabulary): (text: string) => string {
	const pattern = buildHandlePattern(vocab);
	if (pattern === undefined) {
		return text => text;
	}
	return text =>
		text.replace(pattern, (_match, name: string) => {
			return vocab.handles.get(name) as string;
		});
}

function buildHandlePattern(vocab: Vocabulary): RegExp | undefined {
	if (vocab.handles.size === 0) {
		return undefined;
	}
	const names = Array.from(vocab.handles.keys()).sort((a, b) => b.length - a.length);
	const alternation = names.map(escapeRegExp).join("|");
	return new RegExp(`${escapeRegExp(vocab.sigil)}(${alternation})(?![a-z0-9_])`, "g");
}

export interface DecodeReplacement {
	name: string;
	expansion: string;
	index: number;
}

export interface DecodeMeasurement {
	expanded: string;
	replacements: DecodeReplacement[];
	unknownSigilCount: number;
}

export function measureDecode(vocab: Vocabulary, text: string): DecodeMeasurement {
	const pattern = buildHandlePattern(vocab);
	const replacements: DecodeReplacement[] = [];
	const expanded =
		pattern === undefined
			? text
			: text.replace(pattern, (_match, name: string, index: number) => {
					const expansion = vocab.handles.get(name) as string;
					replacements.push({ name, expansion, index });
					return expansion;
				});
	const totalSigils = vocab.sigil.length === 0 ? 0 : text.split(vocab.sigil).length - 1;
	const unknownSigilCount = Math.max(0, totalSigils - replacements.length);
	return { expanded, replacements, unknownSigilCount };
}

export function makePromptFragment(vocab: Vocabulary): string {
	if (vocab.handles.size === 0) {
		return "";
	}

	const lines: string[] = [];
	lines.push("## Project shorthand (Argot)");
	lines.push("");
	lines.push(
		`This project defines shorthand handles. When you would write one of the expansions below, write the handle instead: the marker \`${vocab.sigil}\` followed by the name. The harness restores the full text before anything runs or is shown, so handles are lossless. Only use a handle for its exact expansion; write everything else normally.`,
	);
	lines.push("");
	for (const [name, expansion] of vocab.handles) {
		lines.push(`- \`${vocab.sigil}${name}\` → \`${expansion}\``);
	}
	lines.push("");
	return lines.join("\n");
}

export function makeDict(vocab: Vocabulary): AgentDict {
	const expand = makeExpander(vocab);
	const fragment = makePromptFragment(vocab);
	return {
		promptFragment: () => fragment,
		expand,
	};
}

export function emptyDict(): AgentDict {
	return {
		promptFragment: () => "",
		expand: text => text,
	};
}
