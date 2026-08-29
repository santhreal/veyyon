import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { BlobPutOptions, BlobPutResult } from "./blob-store-helpers";
import {
	BLOB_PREFIX,
	blobExtensionForImageMimeType,
	ensureDisplayPath,
	ensureDisplayPathSync,
	normalizeBlobExtension,
	TEXT_BLOB_PREFIX,
} from "./blob-store-helpers";

export type { BlobPutOptions, BlobPutResult };
export { blobExtensionForImageMimeType };

export class BlobStore {
	#writeFailureLogged = false;

	constructor(readonly dir: string) {}

	async put(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};

		await Bun.write(blobPath, data);
		await ensureDisplayPath(blobPath, displayPath, data);
		return result;
	}

	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(blobPath, data);
		ensureDisplayPathSync(blobPath, displayPath, data);
		return result;
	}

	tryPutSync(data: Buffer, options?: BlobPutOptions): BlobPutResult | undefined {
		try {
			return this.putSync(data, options);
		} catch (err) {
			if (!this.#writeFailureLogged) {
				this.#writeFailureLogged = true;
				logger.warn("blob store write failed; keeping the payload inline in the session file", {
					dir: this.dir,
					bytes: data.byteLength,
					error: errorMessage(err),
				});
			}
			return undefined;
		}
	}

	async get(hash: string): Promise<Buffer | null> {
		const blobPath = path.join(this.dir, hash);
		try {
			const file = Bun.file(blobPath);
			const ab = await file.arrayBuffer();
			return Buffer.from(ab);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	getSync(hash: string): Buffer | null {
		const blobPath = path.join(this.dir, hash);
		try {
			return fs.readFileSync(blobPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async has(hash: string): Promise<boolean> {
		try {
			await fsp.access(path.join(this.dir, hash));
			return true;
		} catch {
			return false;
		}
	}
}

export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	return data.slice(BLOB_PREFIX.length);
}

export function isImageDataUrl(data: string): boolean {
	return data.startsWith("data:image/") && data.includes(";base64,");
}

export function isTextBlobRef(data: string): boolean {
	return data.startsWith(TEXT_BLOB_PREFIX);
}

export function parseTextBlobRef(data: string): string | null {
	if (!data.startsWith(TEXT_BLOB_PREFIX)) return null;
	return data.slice(TEXT_BLOB_PREFIX.length);
}

export function externalizeTextSync(blobStore: BlobStore, text: string): string {
	if (isTextBlobRef(text)) return text;
	const stored = blobStore.tryPutSync(Buffer.from(text, "utf8"));
	if (!stored) return text;
	return `${TEXT_BLOB_PREFIX}${stored.hash}`;
}

export async function resolveTextBlobRef(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseTextBlobRef(data);
	if (!hash) return data;
	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted text reference", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

export function resolveTextBlobRefSync(blobStore: BlobStore, data: string): string {
	const hash = parseTextBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted text reference", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

export async function externalizeImageDataUrl(blobStore: BlobStore, dataUrl: string): Promise<string> {
	if (isBlobRef(dataUrl)) return dataUrl;
	const { ref } = await blobStore.put(Buffer.from(dataUrl, "utf8"));
	return ref;
}

export function externalizeImageDataUrlSync(blobStore: BlobStore, dataUrl: string): string {
	if (isBlobRef(dataUrl)) return dataUrl;
	return blobStore.tryPutSync(Buffer.from(dataUrl, "utf8"))?.ref ?? dataUrl;
}

export async function externalizeImageData(
	blobStore: BlobStore,
	base64Data: string,
	mimeType?: string,
): Promise<string> {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = await blobStore.put(buffer, {
		extension: blobExtensionForImageMimeType(mimeType),
	});
	return ref;
}

export function externalizeImageDataSync(blobStore: BlobStore, base64Data: string, mimeType?: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	const stored = blobStore.tryPutSync(Buffer.from(base64Data, "base64"), {
		extension: blobExtensionForImageMimeType(mimeType),
	});
	return stored?.ref ?? base64Data;
}

export async function resolveImageDataUrl(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

export async function resolveImageData(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data; // Return the ref as-is; downstream will see invalid base64 but won't crash
	}
	return buffer.toString("base64");
}

export function resolveImageDataSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}
