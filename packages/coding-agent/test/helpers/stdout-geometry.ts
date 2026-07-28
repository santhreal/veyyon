/**
 * Pin the terminal size a component reads from `process.stdout` while a test runs.
 *
 * Full-screen components size themselves against `process.stdout.rows` and
 * `.columns` directly, so their layout depends on whether the suite happens to
 * run under a TTY, and under CI it does not: `rows` is `undefined`, the
 * component falls back to its default, and a height assertion passes or fails
 * for a reason that has nothing to do with the component.
 *
 * ONE owner, because it was nine. Nine test files had each hand-rolled this, and
 * the copies had DIVERGED on the thing that matters most: `stubStdoutGeometry(80)`
 * meant eighty COLUMNS in some of them and eighty ROWS in others, off one
 * positional parameter with no name at the call site. Two of the copies also
 * restored `rows` by leaving it defined when the descriptor was absent, which
 * leaks a fake terminal into every suite that runs after them in the same
 * process. Taking a named object removes the ambiguity by construction: there is
 * no order to get wrong.
 */

/** Handle for a stubbed terminal: adjust it mid-test, then put the real one back. */
export interface StubbedStdoutGeometry {
	/** Resize the fake terminal's height, for resize/re-fit assertions. */
	setRows(rows: number): void;
	/** Resize the fake terminal's width. */
	setColumns(columns: number): void;
	/**
	 * Restore the original descriptors.
	 *
	 * A property that had no descriptor is restored to `undefined` rather than
	 * left at the stubbed value, because "this process has no TTY" is the state
	 * the test found and the state the next suite must see.
	 */
	restore(): void;
}

/**
 * Stub `process.stdout.rows` and `.columns` for the duration of a test.
 *
 * Only the dimensions you name are stubbed, so a suite that cares about height
 * alone leaves the width reporting whatever the real terminal reports.
 */
export function stubStdoutGeometry(size: { rows?: number; columns?: number }): StubbedStdoutGeometry {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = size.rows;
	let columns = size.columns;

	if (size.rows !== undefined) {
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	}
	if (size.columns !== undefined) {
		Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => columns, set: () => {} });
	}

	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined, stubbed: boolean) => {
		if (!stubbed) return;
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};

	return {
		setRows(next: number) {
			if (size.rows === undefined) throw new Error("stubStdoutGeometry: rows was not stubbed, so it cannot be resized");
			rows = next;
		},
		setColumns(next: number) {
			if (size.columns === undefined) {
				throw new Error("stubStdoutGeometry: columns was not stubbed, so it cannot be resized");
			}
			columns = next;
		},
		restore() {
			restoreOne("rows", rowsDesc, size.rows !== undefined);
			restoreOne("columns", colsDesc, size.columns !== undefined);
		},
	};
}
