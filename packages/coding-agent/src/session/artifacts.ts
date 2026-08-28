import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, isEnoent, logger } from "@veyyon/utils";

function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.slice(0, 64)
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
}

export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#dirCreated = false;
	#initialized = false;

	constructor(dir: string) {
		this.#dir = dir;
	}

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

	async #scanExistingIds(): Promise<void> {
		const files = await this.listFiles();
		let maxId = -1;
		for (const file of files) {
			const match = file.match(/^(\d+)\..*\.log$/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = maxId + 1;
	}

	allocateId(): number {
		return this.#nextId++;
	}

	async allocatePath(toolType: string): Promise<{ id: string; path: string }> {
		await this.#ensureDir();
		const id = String(this.allocateId());
		const filename = `${id}.${sanitizeToolType(toolType)}.log`;
		return { id, path: path.join(this.#dir, filename) };
	}

	async save(content: string, toolType: string): Promise<string> {
		const { id, path } = await this.allocatePath(toolType);
		await Bun.write(path, content);
		return id;
	}

	async exists(id: string): Promise<boolean> {
		const files = await this.listFiles();
		return files.some(f => f.startsWith(`${id}.`));
	}

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

	async getPath(id: string): Promise<string | null> {
		const files = await this.listFiles();
		const match = files.find(f => f.startsWith(`${id}.`));
		return match ? path.join(this.#dir, match) : null;
	}
}
