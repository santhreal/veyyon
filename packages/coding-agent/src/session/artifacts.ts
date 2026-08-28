/** Session-scoped artifact storage for truncated tool outputs. Artifacts are stored in a directory alongside the session file, */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, isEnoent, logger } from "@veyyon/utils";

/** Sanitize a tool name for safe use as the middle segment of the artifact filename (`${id}.${toolType}.log`). Built-in tool names are fixed, but MCP, */
function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.slice(0, 64)
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
}

/** Manages artifact storage for a session. Artifacts are stored with sequential IDs in the session's artifact directory. */
export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#dirCreated = false;
	#initialized = false;

	/**
	 * @param dir Directory that will hold artifact files. Created lazily on first save.
	 */
	constructor(dir: string) {
		this.#dir = dir;
	}

	/** Artifact directory path. Directory may not exist until first artifact is saved. */
	get dir(): string {
		return this.#dir;
	}

	async #ensureDir(): Promise<void> {
		if (!this.#dirCreated) {
			await fs.mkdir(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		if (!this.#initialized) {
			await this.#scanExistingIds();
			this.#initialized = true;
		}
	}

	/** Scan existing artifact files to find the next available ID. This ensures we don't overwrite artifacts when resuming a session. */
	async #scanExistingIds(): Promise<void> {
		const files = await this.listFiles();
		let maxId = -1;
		for (const file of files) {
			// Files are named: {id}.{toolType}.log
			const match = file.match(/^(\d+)\..*\.log$/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = maxId + 1;
	}

	/** Atomically allocate next artifact ID. IDs are sequential within the session. */
	allocateId(): number {
		return this.#nextId++;
	}

	/** Allocate a new artifact path and ID without writing content. @param toolType Tool name for file extension (e.g., "bash", "read") */
	async allocatePath(toolType: string): Promise<{ id: string; path: string }> {
		await this.#ensureDir();
		const id = String(this.allocateId());
		const filename = `${id}.${sanitizeToolType(toolType)}.log`;
		return { id, path: path.join(this.#dir, filename) };
	}

	/** Save content as an artifact and return the artifact ID. @param content Full content to save @param toolType Tool name for file extension (e.g., "bash", "read") @returns Artifact ID (numeric string) */
	async save(content: string, toolType: string): Promise<string> {
		const { id, path } = await this.allocatePath(toolType);
		await Bun.write(path, content);
		return id;
	}

	/** Check if an artifact exists. @param id Artifact ID (numeric string) */
	async exists(id: string): Promise<boolean> {
		const files = await this.listFiles();
		return files.some(f => f.startsWith(`${id}.`));
	}

	/** List all artifact files in the directory. A directory that does not exist is an empty list: no output has been truncated into an artifact */
	async listFiles(): Promise<string[]> {
		try {
			return await fs.readdir(this.#dir);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Artifact directory could not be read; truncated tool outputs are unreachable", {
					dir: this.#dir,
					error: errorMessage(err),
				});
			}
			return [];
		}
	}

	/** Get the full path to an artifact file. Returns null if artifact doesn't exist. */
	async getPath(id: string): Promise<string | null> {
		const files = await this.listFiles();
		const match = files.find(f => f.startsWith(`${id}.`));
		return match ? path.join(this.#dir, match) : null;
	}
}
