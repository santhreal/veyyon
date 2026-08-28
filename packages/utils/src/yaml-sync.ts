import * as YAML from "yaml";
import { isRecord } from "./type-guards";

type YamlPathStep = string | number;

export interface YamlSyncOptions {
	renamedKeys?: Readonly<Record<string, string>>;
}

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
		present.delete(from);
		present.add(renamed);
	}
}

function parseEditableDocument(text: string): YAML.Document.Parsed | YAML.Document {
	if (text.trim() === "") return new YAML.Document({});
	const doc = YAML.parseDocument(text);
	if (doc.errors.length > 0) {
		const first = doc.errors[0];
		throw new Error(`refusing to write over a config file that does not parse: ${first?.message ?? "parse error"}`);
	}
	if (doc.contents !== null && !YAML.isMap(doc.contents)) {
		throw new Error("refusing to write over a config file whose root is not a YAML mapping");
	}
	return doc;
}

function syncMap(
	doc: YAML.Document.Parsed | YAML.Document,
	basePath: readonly YamlPathStep[],
	target: Record<string, unknown>,
	current: Record<string, unknown>,
): void {
	for (const [key, value] of Object.entries(target)) {
		const path = basePath.concat([key]);
		const existing = current[key];
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
		if (key in current && JSON.stringify(existing) === JSON.stringify(value)) continue;
		doc.setIn(path, value);
	}
	for (const key of Object.keys(current)) {
		if (key in target) continue;
		deleteKeepingComment(doc, basePath, key);
	}
}

function syncSequence(
	doc: YAML.Document.Parsed | YAML.Document,
	basePath: readonly YamlPathStep[],
	target: readonly unknown[],
	current: readonly unknown[],
): void {
	for (const [index, value] of target.entries()) {
		const existing = current[index];
		const path = basePath.concat([index]);
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

function deleteKeepingComment(
	doc: YAML.Document.Parsed | YAML.Document,
	basePath: readonly YamlPathStep[],
	key: string,
): void {
	const parent = basePath.length === 0 ? doc.contents : doc.getIn(basePath, true);
	if (!YAML.isMap(parent)) {
		doc.deleteIn(basePath.concat([key]));
		return;
	}
	const index = parent.items.findIndex(item => YAML.isScalar(item.key) && item.key.value === key);
	const doomed = index === -1 ? undefined : parent.items[index];
	const orphaned = doomed?.key && typeof doomed.key === "object" ? getCommentBefore(doomed.key) : undefined;
	doc.deleteIn(basePath.concat([key]));
	if (orphaned === undefined || orphaned === null) return;
	const next = parent.items[index];
	if (next?.key && typeof next.key === "object") {
		const existing = getCommentBefore(next.key);
		setCommentBefore(next.key, existing ? `${orphaned}\n${existing}` : orphaned);
		if (index === 0) clearSpaceBefore(next.key);
		return;
	}
	doc.comment = doc.comment ? `${doc.comment}\n${orphaned}` : orphaned;
}

function getCommentBefore(node: object): string | null | undefined {
	return (node as { commentBefore?: string | null }).commentBefore;
}

function setCommentBefore(node: object, comment: string): void {
	(node as { commentBefore?: string | null }).commentBefore = comment;
}

function clearSpaceBefore(node: object): void {
	(node as { spaceBefore?: boolean }).spaceBefore = false;
}
