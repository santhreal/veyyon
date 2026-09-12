/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s. Sits between the {@link Tokenizer} and the
 * applier.
 */
import { HL_PAYLOAD_REPLACE, HL_RANGE_SEP } from "./format";
import { BARE_BODY_AUTO_PIPED_WARNING, MINUS_ROW_REJECTED, MOVE_TAKES_NO_BODY, REM_TAKES_NO_BODY } from "./messages";
import { PATCH_OPERATIONS } from "./operations";
import { stripOneLeadingHashlinePrefix } from "./prefixes";
import { type BlockTarget, cloneCursor, type ParsedRange, type Token, Tokenizer } from "./tokenizer";
import type { Anchor, Cursor, Edit, FileOp } from "./types";

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(
			`line ${lineNum}: range ${range.start.line}${HL_RANGE_SEP}${range.end.line} ends before it starts.`,
		);
	}
}

function isSkippableCommentLine(line: string): boolean {
	return line.trimStart().startsWith("#");
}

/**
 * Stripped remainder of a bare `N: <value>` row that is a lone literal — a quoted string, a number,
 * or one of the JSON keywords `true`/`false`/`null` — optionally comma-terminated. That is the shape
 * of a numeric-keyed dict/JSON/YAML body rather than read-output paste.
 *
 * Exported because the write tool asks the same question of a whole-file payload. Two copies of this
 * shape disagreed: the copy here rejected `true`/`false`/`null`, so a numeric-keyed JSON body of
 * keywords had its `N:` keys stripped as if it were a read paste, while the write tool accepted the
 * identical body.
 */
export const BARE_LITERAL_VALUE_RE = /^\s*(?:"[^"]*"|'[^']*'|[-+]?\d+(?:\.\d+)?|true|false|null)\s*,?\s*$/;

function detectApplyPatchContamination(text: string, _hasPending: boolean): string | null {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return null;
	if (
		trimmed.startsWith("*** Update File:") ||
		trimmed.startsWith("*** Add File:") ||
		trimmed.startsWith("*** Delete File:") ||
		trimmed.startsWith("*** Move to:")
	) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`apply_patch sentinel ${JSON.stringify(preview)} is not valid in hashline. ` +
			"File sections start with `[path#HASH]` (no `Update File:` / `Add File:` keyword). " +
			`Use \`SWAP N${HL_RANGE_SEP}M:\`, \`DEL N${HL_RANGE_SEP}M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
		);
	}
	if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(trimmed)) {
		return (
			"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. " +
			`Use \`SWAP N${HL_RANGE_SEP}M:\`, \`DEL N${HL_RANGE_SEP}M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
		);
	}
	if (trimmed.startsWith("@@")) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`\`@@\`-bracketed hunk header ${JSON.stringify(preview)} is not valid in hashline. ` +
			`Drop the \`@@ ... @@\` brackets and write a verb header such as \`SWAP N${HL_RANGE_SEP}M:\`.`
		);
	}
	if (/^DEL\s+[1-9]\d*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9]\d*)?\s*:/.test(trimmed)) {
		return `\`DEL N${HL_RANGE_SEP}M\` has no colon and no body. Remove the colon and body rows.`;
	}
	if (/^[1-9]\d*\s*$/.test(trimmed)) {
		return `hunk headers need a verb. Use \`SWAP ${trimmed}${HL_RANGE_SEP}${trimmed}:\` to replace, or \`DEL ${trimmed}\` to delete.`;
	}
	const bareRange = /^([1-9]\d*)\s*[-. …=]+\s*([1-9]\d*)\s*:?$/.exec(trimmed);
	if (bareRange !== null) {
		return (
			`bare range hunk header ${JSON.stringify(trimmed)} is not valid. ` +
			`Hunk headers need a verb: write \`SWAP ${bareRange[1]}${HL_RANGE_SEP}${bareRange[2]}:\` or \`DEL ${bareRange[1]}${HL_RANGE_SEP}${bareRange[2]}\`.`
		);
	}
	return null;
}

interface PendingComment {
	lineNum: number;
	text: string;
}

type PayloadRow = { kind: "literal"; text: string; lineNum: number; bare?: boolean };

interface Pending {
	target: BlockTarget;
	lineNum: number;
	payloads: PayloadRow[];
	/**
	 * Blank rows seen after the body started. Interior blanks are committed to
	 * the payload when the next non-blank row arrives; trailing blanks before
	 * the next header/op are layout separators and are discarded on flush.
	 */
	deferredBlanks: PayloadRow[];
}

export class Executor {
	#edits: Edit[] = [];
	#warnings: string[] = [];
	#editIndex = 0;
	#pending: Pending | undefined;
	#fileOp: FileOp | undefined;
	#terminated = false;
	#skippableComments: PendingComment[] = [];

	#discardPendingSkippableComments(): void {
		this.#skippableComments = [];
	}

	#consumePendingSkippableComments(): void {
		if (this.#skippableComments.length === 0) return;
		for (const comment of this.#skippableComments) this.#handleRaw(comment.text, comment.lineNum);
		this.#skippableComments = [];
	}

	feed(token: Token): void {
		if (this.#terminated) return;
		switch (token.kind) {
			case "envelope-begin":
				this.#consumePendingSkippableComments();
				return;
			case "envelope-end":
				this.#consumePendingSkippableComments();
				this.#terminated = true;
				return;
			case "abort":
				this.#terminated = true;
				return;
			case "header":
				this.#consumePendingSkippableComments();
				this.#flushPending();
				return;
			case "blank":
				this.#consumePendingSkippableComments();
				this.#handleBlank("", token.lineNum);
				return;
			case "payload-literal":
				this.#consumePendingSkippableComments();
				this.#handleLiteralPayload(token.text, token.lineNum);
				return;
			case "raw":
				if (this.#pending === undefined && isSkippableCommentLine(token.text)) {
					this.#skippableComments.push({ text: token.text, lineNum: token.lineNum });
					return;
				}
				this.#consumePendingSkippableComments();
				this.#handleRaw(token.text, token.lineNum);
				return;
			case "op-block":
				this.#discardPendingSkippableComments();
				if (token.target.kind === "rem") {
					this.#flushPending();
					this.#setFileOp({ kind: "rem" }, token.lineNum);
					return;
				}
				if (token.target.kind === "move") {
					this.#flushPending();
					this.#setFileOp({ kind: "move", dest: token.target.dest }, token.lineNum);
					return;
				}
				if (token.target.kind === "replace" || token.target.kind === "delete") {
					validateRangeOrder(token.target.range, token.lineNum);
				}
				this.#flushPending();
				this.#pending = { target: token.target, lineNum: token.lineNum, payloads: [], deferredBlanks: [] };
				return;
		}
	}
	end(): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
		this.#consumePendingSkippableComments();
		this.#flushPending();
		this.#validateFileOp();
		this.#validateNoOverlappingDeletes();
		return {
			edits: this.#edits,
			...(this.#fileOp === undefined ? {} : { fileOp: this.#fileOp }),
			warnings: this.#warnings,
		};
	}

	endStreaming(): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
		this.#consumePendingSkippableComments();
		if (this.#pending && this.#pending.payloads.length > 0) this.#flushPending();
		else if (this.#pending && !PATCH_OPERATIONS[this.#pending.target.kind].takesBody) this.#flushPending();
		else this.#pending = undefined;
		this.#validateFileOp();
		this.#validateNoOverlappingDeletes();
		return {
			edits: this.#edits,
			...(this.#fileOp === undefined ? {} : { fileOp: this.#fileOp }),
			warnings: this.#warnings,
		};
	}

	reset(): void {
		this.#edits = [];
		this.#warnings = [];
		this.#editIndex = 0;
		this.#pending = undefined;
		this.#fileOp = undefined;
		this.#skippableComments = [];
		this.#terminated = false;
	}

	#setFileOp(fileOp: FileOp, lineNum: number): void {
		if (this.#fileOp !== undefined) {
			throw new Error(
				`line ${lineNum}: only one file-level op (\`REM\` or \`MV\`) per section. Merge them under one header.`,
			);
		}
		if (fileOp.kind === "rem" && this.#edits.length > 0) {
			throw new Error(`line ${lineNum}: ${REM_TAKES_NO_BODY}`);
		}
		this.#fileOp = fileOp;
	}

	#validateFileOp(): void {
		if (this.#fileOp?.kind !== "rem") return;
		if (this.#edits.length > 0) {
			throw new Error("`REM` deletes the whole file and cannot be combined with line ops.");
		}
	}

	#validateNoOverlappingDeletes(): void {
		const sourceLinesByAnchor = new Map<number, number[]>();
		for (const edit of this.#edits) {
			if (edit.kind !== "delete") continue;
			let sourceLines = sourceLinesByAnchor.get(edit.anchor.line);
			if (sourceLines === undefined) {
				sourceLines = [];
				sourceLinesByAnchor.set(edit.anchor.line, sourceLines);
			}
			if (!sourceLines.includes(edit.lineNum)) sourceLines.push(edit.lineNum);
		}
		for (const [anchorLine, sourceLines] of sourceLinesByAnchor) {
			if (sourceLines.length < 2) continue;
			const [firstBlock, secondBlock] = sourceLines.slice().sort((a, b) => a - b);
			throw new Error(
				`line ${secondBlock}: anchor line ${anchorLine} is already targeted by another hunk on line ${firstBlock}. ` +
					"Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.",
			);
		}
	}

	#handleLiteralPayload(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) {
			if (this.#fileOp !== undefined) throw new Error(`line ${lineNum}: ${MOVE_TAKES_NO_BODY}`);
			throw new Error(
				`line ${lineNum}: payload line has no preceding hunk header. ` +
					`Got ${JSON.stringify(`${HL_PAYLOAD_REPLACE}${text}`)}.`,
			);
		}
		const spec = PATCH_OPERATIONS[pending.target.kind];
		if (!spec.takesBody && spec.forbiddenBodyError) throw new Error(`line ${lineNum}: ${spec.forbiddenBodyError}`);
		this.#commitDeferredBlanks(pending);
		pending.payloads.push({ kind: "literal", text, lineNum });
	}

	#handleRaw(text: string, lineNum: number): void {
		const contamination = detectApplyPatchContamination(text, this.#pending !== undefined);
		if (contamination !== null) throw new Error(`line ${lineNum}: ${contamination}`);
		if (this.#fileOp !== undefined) throw new Error(`line ${lineNum}: ${MOVE_TAKES_NO_BODY}`);
		if (this.#pending) {
			if (text.trim().length === 0) {
				this.#handleBlank(text, lineNum);
				return;
			}
			const spec = PATCH_OPERATIONS[this.#pending.target.kind];
			if (!spec.takesBody && spec.forbiddenBodyError) throw new Error(`line ${lineNum}: ${spec.forbiddenBodyError}`);
			if (text.trimStart().charCodeAt(0) === 45 /* - */) throw new Error(`line ${lineNum}: ${MINUS_ROW_REJECTED}`);
			if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
			this.#commitDeferredBlanks(this.#pending);
			// Defer read-output line-number stripping to #flushPending: a bare
			// "N:text" row is only a copy-paste artifact from snapshot output
			// when *every* bare row in the hunk carries that prefix. Stripping a
			// row in isolation would corrupt a genuine body that merely starts
			// with "digits:" (YAML ports "42:hello", timestamps "12:30") when it
			// sits next to an unprefixed sibling. Rows with an explicit "+" go
			// through #handleLiteralPayload and are never bare, never stripped.
			this.#pending.payloads.push({ kind: "literal", text, lineNum, bare: true });
			return;
		}
		if (text.trim().length === 0) return;
		throw new Error(
			`line ${lineNum}: payload line has no preceding hunk header. ` +
				`Use \`SWAP N${HL_RANGE_SEP}M:\`, \`DEL N${HL_RANGE_SEP}M\`, or \`INS.PRE|POST|HEAD|TAIL:\` above the body. Got ${JSON.stringify(text)}.`,
		);
	}

	/**
	 * A blank row inside a hunk body is ambiguous: interior blanks are body
	 * content (a bare-pasted body legitimately contains empty lines), while
	 * blanks before the body starts or trailing into the next op are layout.
	 * Defer them; {@link #commitDeferredBlanks} folds them in only when a later
	 * non-blank row proves they were interior.
	 */
	#handleBlank(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) return;
		if (pending.target.kind === "delete" || pending.target.kind === "delete_block") return;
		if (pending.payloads.length === 0) return;
		pending.deferredBlanks.push({ kind: "literal", text, lineNum, bare: true });
	}

	#commitDeferredBlanks(pending: Pending): void {
		if (pending.deferredBlanks.length === 0) return;
		if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
		for (let bi = 0; bi < pending.deferredBlanks.length; bi++) pending.payloads.push(pending.deferredBlanks[bi]!);
		pending.deferredBlanks = [];
	}

	/**
	 * Strip a single read-output line-number prefix (`N:`) from every bare body
	 * row, but only when *all* bare rows carry one. A uniform set of prefixes is
	 * the signature of content pasted straight from `read`/`search` output; a
	 * mixed set means the `N:` is genuine payload content and must stay. Rows
	 * authored with an explicit `+` are not bare and are never touched.
	 */
	#stripBarePrefixesIfUniform(payloads: PayloadRow[]): void {
		let sawBare = false;
		let allLiteralValues = true;
		for (const row of payloads) {
			if (!row.bare || row.text.trim().length === 0) continue;
			sawBare = true;
			const stripped = stripOneLeadingHashlinePrefix(row.text);
			if (stripped === row.text) return;
			allLiteralValues &&= BARE_LITERAL_VALUE_RE.test(stripped);
		}
		if (!sawBare) return;
		// A body where every stripped remainder is a lone quoted/numeric literal
		// (optionally comma-terminated) is the shape of a numeric-keyed dict or
		// YAML mapping (`1: "one",`), not read-output paste; stripping the "N:"
		// keys would mangle every line. Leave such bodies untouched.
		if (allLiteralValues) return;
		for (const row of payloads) {
			if (row.bare && row.text.trim().length > 0) row.text = stripOneLeadingHashlinePrefix(row.text);
		}
	}

	pushInsert(cursor: Cursor, text: string, lineNum: number, mode?: "replacement"): void {
		this.#edits.push({
			kind: "insert",
			cursor: cloneCursor(cursor),
			text,
			lineNum,
			index: this.#editIndex++,
			...(mode === undefined ? {} : { mode }),
		});
	}

	pushDelete(anchor: Anchor, lineNum: number): void {
		this.#edits.push({ kind: "delete", anchor: { ...anchor }, lineNum, index: this.#editIndex++ });
	}

	pushBlock(anchor: Anchor, payloads: readonly string[], lineNum: number, mode?: "insert_after"): void {
		this.#edits.push({
			kind: "block",
			anchor: { ...anchor },
			payloads: [...payloads],
			...(mode === undefined ? {} : { mode }),
			lineNum,
			index: this.#editIndex++,
		});
	}

	#flushPending(): void {
		const pending = this.#pending;
		if (!pending) return;
		const { target, lineNum, payloads } = pending;
		this.#stripBarePrefixesIfUniform(payloads);
		this.#pending = undefined;
		const spec = PATCH_OPERATIONS[target.kind];
		if (spec.takesBody && payloads.length === 0) {
			throw new Error(`line ${lineNum}: ${spec.emptyBodyError ?? "empty payload"}`);
		}
		const texts = payloads.map(payload => payload.text);
		if (target.kind === "replace") {
			const cursor: Cursor = { kind: "before_anchor", anchor: { ...target.range.start } };
			for (const text of texts) this.pushInsert(cursor, text, lineNum, "replacement");
			for (let line = target.range.start.line; line <= target.range.end.line; line++)
				this.pushDelete({ line }, lineNum);
		} else if (target.kind === "delete") {
			for (let line = target.range.start.line; line <= target.range.end.line; line++)
				this.pushDelete({ line }, lineNum);
		} else if (target.kind === "block") {
			this.pushBlock(target.anchor, texts, lineNum);
		} else if (target.kind === "delete_block") {
			this.pushBlock(target.anchor, [], lineNum);
		} else if (target.kind === "insert_after_block") {
			this.pushBlock(target.anchor, texts, lineNum, "insert_after");
		} else if (target.kind === "insert_before") {
			const cursor: Cursor = { kind: "before_anchor", anchor: { ...target.anchor } };
			for (const text of texts) this.pushInsert(cursor, text, lineNum);
		} else if (target.kind === "insert_after") {
			const cursor: Cursor = { kind: "after_anchor", anchor: { ...target.anchor } };
			for (const text of texts) this.pushInsert(cursor, text, lineNum);
		} else if (target.kind === "bof") {
			const cursor: Cursor = { kind: "bof" };
			for (const text of texts) this.pushInsert(cursor, text, lineNum);
		} else if (target.kind === "eof") {
			const cursor: Cursor = { kind: "eof" };
			for (const text of texts) this.pushInsert(cursor, text, lineNum);
		}
	}
}

function drain(executor: Executor, tokenizer: Tokenizer): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
	for (const token of tokenizer.end()) executor.feed(token);
	return executor.end();
}

export function parsePatch(diff: string): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	for (const token of tokenizer.feed(diff)) executor.feed(token);
	return drain(executor, tokenizer);
}

export function parsePatchStreaming(diff: string): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	for (const token of tokenizer.feed(diff)) executor.feed(token);
	for (const token of tokenizer.end()) executor.feed(token);
	return executor.endStreaming();
}
