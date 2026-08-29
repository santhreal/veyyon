import * as path from "node:path";
import * as zlib from "node:zlib";
import { formatBytes } from "@veyyon/utils/format";
import { ToolError } from "../tools/tool-errors";
import type {
	ArchiveDirectoryEntry,
	ArchiveFormat,
	ArchiveIndexEntry,
	ArchiveMemberContent,
	ArchiveNode,
	ArchiveSource,
	ExtractedArchiveFile,
	Unzipped,
} from "./zip-helpers";
import {
	archiveFormatFromPath,
	ENCODER,
	ensureParentDirectories,
	fileByteSource,
	formatArchiveEntryLines,
	MAX_ARCHIVE_MEMBER_BYTES,
	MAX_TAR_ARCHIVE_BYTES,
	memoryByteSource,
	normalizeArchiveLookupPath,
	readTarEntries,
	readZipEntries,
	readZipFileBytes,
	unzip,
	upsertArchiveEntry,
	ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE,
	ZIP_DEFLATE_COMPRESSION,
	ZIP_EOCD_MIN_LENGTH,
	ZIP_EOCD_SIGNATURE,
	ZIP_LOCAL_FILE_HEADER_SIGNATURE,
	ZIP_STORED_COMPRESSION,
	ZIP_UINT16_MAX,
	ZIP_UINT32_MAX,
	ZIP_UTF8_FLAG,
} from "./zip-helpers";

export type {
	ArchiveFormat,
	ArchiveMemberContent,
	ExtractedArchiveFile,
} from "./zip-helpers";
export {
	archiveFormatFromPath,
	formatArchiveEntryLines,
	parseArchivePathCandidates,
	resolveArchiveMemberPath,
	sniffArchiveFormat,
	unzip,
	unzipText,
} from "./zip-helpers";

export class ArchiveReader {
	readonly format: ArchiveFormat;
	#entries = new Map<string, ArchiveIndexEntry>();

	constructor(format: ArchiveFormat, entries: ArchiveIndexEntry[]) {
		this.format = format;
		for (const entry of entries) {
			upsertArchiveEntry(this.#entries, entry);
		}
		ensureParentDirectories(this.#entries);
	}

	getNode(subPath?: string): ArchiveNode | undefined {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) return undefined;
		if (normalizedPath === "") {
			return { path: "", isDirectory: true, size: 0 };
		}

		const entry = this.#entries.get(normalizedPath);
		if (!entry) return undefined;
		return {
			path: entry.path,
			isDirectory: entry.isDirectory,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		};
	}

	listDirectory(subPath?: string): ArchiveDirectoryEntry[] {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) {
			throw new ToolError("Archive path cannot contain '..'");
		}

		if (normalizedPath) {
			const entry = this.#entries.get(normalizedPath);
			if (!entry) {
				throw new ToolError(`Archive path '${normalizedPath}' not found`);
			}
			if (!entry.isDirectory) {
				throw new ToolError(`Archive path '${normalizedPath}' is not a directory`);
			}
		}

		const prefix = normalizedPath ? `${normalizedPath}/` : "";
		const children = new Map<string, ArchiveDirectoryEntry>();

		for (const entry of this.#entries.values()) {
			if (normalizedPath) {
				if (!entry.path.startsWith(prefix) || entry.path === normalizedPath) continue;
			}

			const relativePath = normalizedPath ? entry.path.slice(prefix.length) : entry.path;
			const nextSegment = relativePath.split("/")[0];
			if (!nextSegment) continue;

			const childPath = normalizedPath ? `${normalizedPath}/${nextSegment}` : nextSegment;
			if (children.has(childPath)) continue;

			const childEntry = this.#entries.get(childPath);
			const isDirectory = childEntry?.isDirectory ?? relativePath.includes("/");
			children.set(childPath, {
				name: nextSegment,
				path: childPath,
				isDirectory,
				size: isDirectory ? 0 : (childEntry?.size ?? entry.size),
				mtimeMs: childEntry?.mtimeMs ?? entry.mtimeMs,
			});
		}

		return Array.from(children.values()).sort((left, right) =>
			left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
		);
	}

	async readFile(subPath: string): Promise<ExtractedArchiveFile> {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (!normalizedPath) {
			throw new ToolError("Archive file path is required");
		}

		const entry = this.#entries.get(normalizedPath);
		if (!entry) {
			throw new ToolError(`Archive file '${normalizedPath}' not found`);
		}
		if (entry.isDirectory) {
			throw new ToolError(`Archive path '${normalizedPath}' is a directory`);
		}
		if (!entry.storage) {
			throw new ToolError(`Archive file '${normalizedPath}' has no readable storage`);
		}
		if (entry.size > MAX_ARCHIVE_MEMBER_BYTES) {
			throw new ToolError(
				`Archive member '${normalizedPath}' is too large to extract in memory (${formatBytes(entry.size)} > ${formatBytes(MAX_ARCHIVE_MEMBER_BYTES)} limit)`,
			);
		}

		const bytes =
			entry.storage.type === "tar"
				? await entry.storage.file.bytes()
				: await readZipFileBytes(entry.storage, entry.size);

		return {
			path: entry.path,
			isDirectory: false,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			bytes,
		};
	}
}

export async function openArchive(source: ArchiveSource): Promise<ArchiveReader> {
	if (typeof source === "string") {
		const format = archiveFormatFromPath(source);
		if (!format) {
			throw new ToolError(`Unsupported archive format: ${source}`);
		}
		if (format === "zip") {
			return new ArchiveReader(format, await readZipEntries(fileByteSource(source)));
		}

		const file = Bun.file(source);
		const archiveSize = file.size;
		if (archiveSize > MAX_TAR_ARCHIVE_BYTES) {
			throw new ToolError(
				`Archive is too large to read in memory (${formatBytes(archiveSize)} > ${formatBytes(MAX_TAR_ARCHIVE_BYTES)} limit)`,
			);
		}
		return new ArchiveReader(format, await readTarEntries(await file.bytes()));
	}

	const { bytes, format } = source;
	if (format === "zip") {
		return new ArchiveReader(format, await readZipEntries(memoryByteSource(bytes)));
	}
	if (bytes.byteLength > MAX_TAR_ARCHIVE_BYTES) {
		throw new ToolError(
			`Archive is too large to read in memory (${formatBytes(bytes.byteLength)} > ${formatBytes(MAX_TAR_ARCHIVE_BYTES)} limit)`,
		);
	}
	return new ArchiveReader(format, await readTarEntries(bytes));
}

export async function listArchiveRoot(
	bytes: Uint8Array,
	format: ArchiveFormat,
	opts: { limit?: number } = {},
): Promise<string> {
	const archive = await openArchive({ bytes, format });
	const entries = archive.listDirectory("");
	const limitedEntries = opts.limit !== undefined && opts.limit > 0 ? entries.slice(0, opts.limit) : entries;
	const lines = formatArchiveEntryLines(limitedEntries);
	return lines.length > 0 ? lines.join("\n") : "(empty archive directory)";
}

async function resolveArchiveBytes(source: ArchiveSource): Promise<{ bytes: Uint8Array; format: ArchiveFormat }> {
	if (typeof source !== "string") return source;
	const format = archiveFormatFromPath(source);
	if (!format) {
		throw new ToolError(`Unsupported archive format: ${source}`);
	}
	return { bytes: await Bun.file(source).bytes(), format };
}

async function memberToBytes(content: ArchiveMemberContent): Promise<Uint8Array> {
	if (typeof content === "string") return ENCODER.encode(content);
	if (content instanceof Uint8Array) return content;
	return new Uint8Array(await content.arrayBuffer());
}

export async function readArchiveEntries(source: ArchiveSource): Promise<Map<string, ArchiveMemberContent>> {
	const { bytes, format } = await resolveArchiveBytes(source);
	const entries = new Map<string, ArchiveMemberContent>();
	if (format === "zip") {
		const unzipped = unzip(bytes);
		for (const name in unzipped) {
			entries.set(name, unzipped[name]!);
		}
		return entries;
	}
	const files = await new Bun.Archive(bytes).files();
	for (const [name, file] of files) {
		entries.set(name.replace(/\\/g, "/"), file);
	}
	return entries;
}

export async function writeArchive(
	destPath: string,
	format: ArchiveFormat,
	entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<void> {
	if (format === "zip") {
		const record: Record<string, Uint8Array> = {};
		for (const [name, content] of entries) {
			record[name.replace(/\\/g, "/")] = await memberToBytes(content);
		}
		await Bun.write(destPath, zip(record));
		return;
	}

	const record: Record<string, ArchiveMemberContent> = {};
	for (const [name, content] of entries) {
		record[name.replace(/\\/g, "/")] = content;
	}
	await Bun.Archive.write(destPath, record, format === "tar.gz" ? { compress: "gzip" } : undefined);
}

export async function extractArchive(source: ArchiveSource, destDir: string): Promise<number> {
	const extractRoot = path.resolve(destDir);
	const entries = await readArchiveEntries(source);
	let count = 0;
	for (const [name, content] of entries) {
		if (name.endsWith("/")) continue;
		const outputPath = path.resolve(extractRoot, name);
		if (!outputPath.startsWith(extractRoot + path.sep)) {
			throw new ToolError(`Archive entry escapes extraction dir: ${name}`);
		}
		await Bun.write(outputPath, content);
		count++;
	}
	return count;
}

function writeUInt16LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeUInt32LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >>> 8) & 0xff;
	buf[offset + 2] = (value >>> 16) & 0xff;
	buf[offset + 3] = (value >>> 24) & 0xff;
}

export function zip(entries: Unzipped): Uint8Array {
	const localParts: Uint8Array[] = [];
	const centralParts: Uint8Array[] = [];
	let offset = 0;
	let count = 0;

	for (const name in entries) {
		const data = entries[name]!;
		const nameBytes = ENCODER.encode(name);
		const crc = zlib.crc32(data) >>> 0;
		const uncompressedSize = data.byteLength;
		const deflated = zlib.deflateRawSync(data);
		const stored = deflated.byteLength >= uncompressedSize;
		const method = stored ? ZIP_STORED_COMPRESSION : ZIP_DEFLATE_COMPRESSION;
		const payload = stored ? data : deflated;

		if (
			count + 1 >= ZIP_UINT16_MAX ||
			nameBytes.byteLength > ZIP_UINT16_MAX ||
			uncompressedSize >= ZIP_UINT32_MAX ||
			offset + 30 + nameBytes.byteLength + payload.byteLength >= ZIP_UINT32_MAX
		) {
			throw new ToolError("ZIP archive is too large to write (ZIP64 is not supported)");
		}

		const header = new Uint8Array(30 + nameBytes.byteLength);
		writeUInt32LE(header, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
		writeUInt16LE(header, 4, 20);
		writeUInt16LE(header, 6, ZIP_UTF8_FLAG);
		writeUInt16LE(header, 8, method);
		writeUInt16LE(header, 12, 0x21);
		writeUInt32LE(header, 14, crc);
		writeUInt32LE(header, 18, payload.byteLength);
		writeUInt32LE(header, 22, uncompressedSize);
		writeUInt16LE(header, 26, nameBytes.byteLength);
		header.set(nameBytes, 30);
		localParts.push(header, payload);

		const record = new Uint8Array(46 + nameBytes.byteLength);
		writeUInt32LE(record, 0, ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE);
		writeUInt16LE(record, 4, 20);
		writeUInt16LE(record, 6, 20);
		writeUInt16LE(record, 8, ZIP_UTF8_FLAG);
		writeUInt16LE(record, 10, method);
		writeUInt16LE(record, 14, 0x21);
		writeUInt32LE(record, 16, crc);
		writeUInt32LE(record, 20, payload.byteLength);
		writeUInt32LE(record, 24, uncompressedSize);
		writeUInt16LE(record, 28, nameBytes.byteLength);
		writeUInt32LE(record, 42, offset);
		record.set(nameBytes, 46);
		centralParts.push(record);

		offset += header.byteLength + payload.byteLength;
		count++;
	}

	const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
	if (centralSize >= ZIP_UINT32_MAX || offset + centralSize + ZIP_EOCD_MIN_LENGTH >= ZIP_UINT32_MAX) {
		throw new ToolError("ZIP archive is too large to write (ZIP64 is not supported)");
	}
	const eocd = new Uint8Array(ZIP_EOCD_MIN_LENGTH);
	writeUInt32LE(eocd, 0, ZIP_EOCD_SIGNATURE);
	writeUInt16LE(eocd, 8, count);
	writeUInt16LE(eocd, 10, count);
	writeUInt32LE(eocd, 12, centralSize);
	writeUInt32LE(eocd, 16, offset);

	const out = new Uint8Array(offset + centralSize + ZIP_EOCD_MIN_LENGTH);
	let pos = 0;
	for (const part of localParts) {
		out.set(part, pos);
		pos += part.byteLength;
	}
	for (const part of centralParts) {
		out.set(part, pos);
		pos += part.byteLength;
	}
	out.set(eocd, pos);
	return out;
}
