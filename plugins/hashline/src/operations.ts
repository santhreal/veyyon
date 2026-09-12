import {
	HL_DELETE_BLOCK_KEYWORD,
	HL_DELETE_KEYWORD,
	HL_INSERT_AFTER,
	HL_INSERT_AFTER_BLOCK_KEYWORD,
	HL_INSERT_BEFORE,
	HL_INSERT_HEAD,
	HL_INSERT_KEYWORD,
	HL_INSERT_TAIL,
	HL_MOVE_KEYWORD,
	HL_REM_KEYWORD,
	HL_REPLACE_BLOCK_KEYWORD,
	HL_REPLACE_KEYWORD,
} from "./format";
import {
	DELETE_BLOCK_TAKES_NO_BODY,
	DELETE_TAKES_NO_BODY,
	EMPTY_BLOCK,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	MOVE_TAKES_NO_BODY,
	REM_TAKES_NO_BODY,
} from "./messages";
import type { BlockTarget } from "./tokenizer";

export interface PatchOpSpec {
	readonly kind: BlockTarget["kind"];
	readonly keyword: string;
	readonly takesBody: boolean;
	readonly allowColon: boolean;
	readonly forbiddenBodyError?: string;
	readonly emptyBodyError?: string;
	readonly cursorKind?: "before_anchor" | "after_anchor" | "bof" | "eof";
	readonly isBlock?: boolean;
	readonly isDelete?: boolean;
	readonly isReplace?: boolean;
	readonly isFileOp?: boolean;
}

export const PATCH_OPERATIONS: Record<BlockTarget["kind"], PatchOpSpec> = {
	replace: {
		kind: "replace",
		keyword: HL_REPLACE_KEYWORD,
		takesBody: true,
		allowColon: true,
		emptyBodyError: EMPTY_REPLACE,
		isReplace: true,
	},
	block: {
		kind: "block",
		keyword: HL_REPLACE_BLOCK_KEYWORD,
		takesBody: true,
		allowColon: true,
		emptyBodyError: EMPTY_BLOCK,
		isBlock: true,
	},
	delete: {
		kind: "delete",
		keyword: HL_DELETE_KEYWORD,
		takesBody: false,
		allowColon: false,
		forbiddenBodyError: DELETE_TAKES_NO_BODY,
		isDelete: true,
	},
	delete_block: {
		kind: "delete_block",
		keyword: HL_DELETE_BLOCK_KEYWORD,
		takesBody: false,
		allowColon: false,
		forbiddenBodyError: DELETE_BLOCK_TAKES_NO_BODY,
		isBlock: true,
	},
	insert_before: {
		kind: "insert_before",
		keyword: `${HL_INSERT_KEYWORD}.${HL_INSERT_BEFORE}`,
		takesBody: true,
		allowColon: true,
		emptyBodyError: EMPTY_INSERT,
		cursorKind: "before_anchor",
	},
	insert_after: {
		kind: "insert_after",
		keyword: `${HL_INSERT_KEYWORD}.${HL_INSERT_AFTER}`,
		takesBody: true,
		allowColon: true,
		emptyBodyError: EMPTY_INSERT,
		cursorKind: "after_anchor",
	},
	insert_after_block: {
		kind: "insert_after_block",
		keyword: HL_INSERT_AFTER_BLOCK_KEYWORD,
		takesBody: true,
		allowColon: true,
		emptyBodyError: EMPTY_INSERT,
		isBlock: true,
	},
	bof: {
		kind: "bof",
		keyword: `${HL_INSERT_KEYWORD}.${HL_INSERT_HEAD}`,
		takesBody: true,
		allowColon: true,
		emptyBodyError: EMPTY_INSERT,
		cursorKind: "bof",
	},
	eof: {
		kind: "eof",
		keyword: `${HL_INSERT_KEYWORD}.${HL_INSERT_TAIL}`,
		takesBody: true,
		allowColon: true,
		emptyBodyError: EMPTY_INSERT,
		cursorKind: "eof",
	},
	rem: {
		kind: "rem",
		keyword: HL_REM_KEYWORD,
		takesBody: false,
		allowColon: false,
		forbiddenBodyError: REM_TAKES_NO_BODY,
		isFileOp: true,
	},
	move: {
		kind: "move",
		keyword: HL_MOVE_KEYWORD,
		takesBody: false,
		allowColon: false,
		forbiddenBodyError: MOVE_TAKES_NO_BODY,
		isFileOp: true,
	},
};
