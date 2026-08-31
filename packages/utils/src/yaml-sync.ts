import * as YAML from "yaml";
import { isRecord } from "./type-guards";

/** A step in a path into the document: a mapping key, or an index into a sequence. */
type YamlPathStep = string | number;

export interface YamlSyncOptions {
	/**
	 * Top-level keys the caller has renamed, as `oldName -> newName`.
	 *
	 * Without this, a rename reaches the writer as "one key gone, one key added", so the old
	 * key is deleted (stranding the comment above it) and the new one appended to the end of
	 * the file. A migration that renames EVERY key — which is exactly what the keybindings
	 * name migration does — therefore rewrote the whole file bottom-up and pushed every
	 * comment to the end. Told about the rename, the writer relabels the key where it sits,
	 * keeping its position, its comment, and its value's formatting.
	 *
	 * Only the root mapping is renamed, because that is the only level any caller migrates.
	 * The rename map belongs to the caller that owns the migration; this option is how it
	 * gets here rather than being duplicated.
	 */
	renamedKeys?: Readonly<Record<string, string>>;
}

/**
 * Write settings back into a YAML file without rewriting the parts nobody changed.
 *
 * `config.yml` is a file the USER edits. Saving a setting used to re-serialize the whole
 * settings object with `YAML.stringify`, which produces a semantically identical file and
 * throws away everything that is not a value: the comments they wrote, the blank lines they
 * grouped keys with, the quoting style they chose, and the order they arranged things in.
 * Changing one setting from the UI deleted a comment at the top of the file, and nothing in
 * the codebase noticed because every test compared VALUES.
 *
 * So the file is edited as a document instead. Only the paths whose value actually differs
 * are touched, keys the target no longer has are deleted, and every untouched node keeps
 * the bytes it had. The target object stays the authority on content — this is not a
 * merge — so migrations and resets land exactly as before.
 *
 * Ordering: a key that already exists keeps its position, and a NEW key is appended, which
 * is what a person editing the file by hand would do.
 */
export function syncYamlTextToSettings(
	text: string,
	target: Record<string, unknown>,
	options: YamlSyncOptions = {},
): string {
	const doc = parseEditableDocument(text);
	if (options.renamedKeys) renameRootKeys(doc, options.renamedKeys);
	syncMap(doc, [], target, (doc.toJS() ?? {}) as Record<string, unknown>);
	return doc.toString();
}

/**
 * Relabel root keys in place, before anything compares the document to the target.
 *
 * A rename is skipped when the new name is already present: the file has both spellings, and
 * the target decides which survives, so the ordinary delete path is the right answer there.
 */
function renameRootKeys(doc: YAML.Document.Parsed | YAML.Document, renames: Readonly<Record<string, string>>): void {
	const root = doc.contents;
	if (!YAML.isMap(root)) return;
	const present = new Set(root.items.flatMap(item => (YAML.isScalar(item.key) ? [String(item.key.value)] : [])));
	for (const item of root.items) {
		if (!YAML.isScalar(item.key)) continue;
		const from = String(item.key.value);
		const renamed = renames[from];
		if (renamed === undefined || present.has(renamed)) continue;
		item.key.value = renamed;
		// Kept current so two old spellings of one setting cannot both become it.
		present.delete(from);
		present.add(renamed);
	}
}

/**
 * The document to edit, or a throw.
 *
 * A file that does not parse must NOT be quietly replaced with a fresh serialization: that
 * is the one case where the user's file is unreadable to us and also the one case where
 * overwriting it destroys something we cannot reconstruct. The caller already quarantines
 * an unparseable config before it gets here; a file that became malformed between that
 * check and this write (another process, a partial write on a full disk) is a real error,
 * and the caller's retry path is the honest answer (Law 10: fail closed, never a silent
 * fallback that clobbers).
 */
function parseEditableDocument(text: string): YAML.Document.Parsed | YAML.Document {
	if (text.trim() === "") return new YAML.Document({});
	const doc = YAML.parseDocument(text);
	if (doc.errors.length > 0) {
		const first = doc.errors[0];
		throw new Error(`refusing to write over a config file that does not parse: ${first?.message ?? "parse error"}`);
	}
	// A file whose root is not a mapping (a bare scalar, a sequence) cannot carry settings.
	// Same reasoning as above: report it rather than overwrite it.
	if (doc.contents !== null && !YAML.isMap(doc.contents)) {
		throw new Error("refusing to write over a config file whose root is not a YAML mapping");
	}
	// A comments-only file parses to null contents; `setIn` creates the root mapping on
	// first write, so there is nothing to do here and the comment is kept.
	return doc;
}

/**
 * Apply one mapping level of `target` onto the document, recursing into nested mappings.
 *
 * `current` is the document's own value at this path, read once as JS so equality is a
 * plain comparison rather than a walk over YAML nodes.
 */
function syncMap(
	doc: YAML.Document.Parsed | YAML.Document,
	basePath: readonly YamlPathStep[],
	target: Record<string, unknown>,
	current: Record<string, unknown>,
): void {
	for (const [key, value] of Object.entries(target)) {
		const path = [...basePath, key];
		const existing = current[key];
		// `undefined` is how a reset arrives: the key is gone, not set to null.
		if (value === undefined) {
			if (key in current) doc.deleteIn(path);
			continue;
		}
		if (isRecord(value) && isRecord(existing)) {
			syncMap(doc, path, value, existing);
			continue;
		}
		if (Array.isArray(value) && Array.isArray(existing) && value.length === existing.length) {
			syncSequence(doc, path, value, existing);
			continue;
		}
		// Equal values are left alone so their formatting survives. JSON is enough here:
		// settings are YAML scalars, arrays and mappings, all of which round-trip through
		// it, and the alternative (a deep walk) would answer the same question.
		if (key in current && JSON.stringify(existing) === JSON.stringify(value)) continue;
		doc.setIn(path, value);
	}
	for (const key of Object.keys(current)) {
		if (key in target) continue;
		deleteKeepingComment(doc, basePath, key);
	}
}

/**
 * Apply a sequence of the same length item by item, so an edit to one entry leaves the rest
 * of the sequence alone.
 *
 * Replacing the whole sequence is what happened before, and it took every comment inside it
 * with it: `WATCHDOG.yml` is a list of advisors with a comment above each one saying what it
 * is for, so changing one advisor's model deleted the notes on all of them. Entries are
 * matched by POSITION, which is the only correspondence a list actually carries — a sequence
 * whose length changed is replaced wholesale, because any pairing there would be a guess.
 */
function syncSequence(
	doc: YAML.Document.Parsed | YAML.Document,
	basePath: readonly YamlPathStep[],
	target: readonly unknown[],
	current: readonly unknown[],
): void {
	for (const [index, value] of target.entries()) {
		const existing = current[index];
		const path = [...basePath, index];
		if (isRecord(value) && isRecord(existing)) {
			syncMap(doc, path, value, existing);
			continue;
		}
		if (Array.isArray(value) && Array.isArray(existing) && value.length === existing.length) {
			syncSequence(doc, path, value, existing);
			continue;
		}
		if (JSON.stringify(existing) === JSON.stringify(value)) continue;
		doc.setIn(path, value);
	}
}

/**
 * Delete a key without taking the user's comment with it.
 *
 * A comment sits on the NODE it precedes, so deleting the first key of a file deletes the
 * header comment above it: resetting one setting silently ate the top of the config. The
 * comment is carried to the next remaining key instead, or to the end of the document when
 * nothing follows. A comment in a slightly different place is recoverable; a deleted one is
 * not, so this errs toward keeping the text.
 */
function deleteKeepingComment(
	doc: YAML.Document.Parsed | YAML.Document,
	basePath: readonly YamlPathStep[],
	key: string,
): void {
	const parent = basePath.length === 0 ? doc.contents : doc.getIn(basePath, true);
	if (!YAML.isMap(parent)) {
		doc.deleteIn([...basePath, key]);
		return;
	}
	const index = parent.items.findIndex(item => YAML.isScalar(item.key) && item.key.value === key);
	const doomed = index === -1 ? undefined : parent.items[index];
	const orphaned = doomed?.key && typeof doomed.key === "object" ? getCommentBefore(doomed.key) : undefined;
	doc.deleteIn([...basePath, key]);
	if (orphaned === undefined || orphaned === null) return;
	const next = parent.items[index];
	if (next?.key && typeof next.key === "object") {
		const existing = getCommentBefore(next.key);
		setCommentBefore(next.key, existing ? `${orphaned}\n${existing}` : orphaned);
		// A blank line before the surviving key separated it from the key that just went
		// away. Now that it is first, that separator renders as a blank line at the very
		// top of the file, which is not something the user wrote.
		if (index === 0) clearSpaceBefore(next.key);
		return;
	}
	// Nothing follows it: the comment becomes the document's trailing comment rather
	// than being dropped.
	doc.comment = doc.comment ? `${doc.comment}\n${orphaned}` : orphaned;
}

/** `commentBefore` lives on any YAML node; these two keep the casts in one place. */
function getCommentBefore(node: object): string | null | undefined {
	return (node as { commentBefore?: string | null }).commentBefore;
}

function setCommentBefore(node: object, comment: string): void {
	(node as { commentBefore?: string | null }).commentBefore = comment;
}

/** `spaceBefore` is the library's flag for "the user left a blank line above this". */
function clearSpaceBefore(node: object): void {
	(node as { spaceBefore?: boolean }).spaceBefore = false;
}
