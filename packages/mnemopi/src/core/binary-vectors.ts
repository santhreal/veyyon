import type { Database } from "bun:sqlite";

import { clampLow } from "@veyyon/utils";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";
import type {
	BinaryVectorSearchResult,
	BinaryVectorStats,
	BinaryVectorStoreOptions,
	StatsRow,
	VectorRow,
} from "./binary-vectors-helpers";

export {
	BITS_PER_BYTE,
	cosineSimilarity,
	getVecType,
	quantizeInt8,
} from "./binary-vectors-helpers";
export {
	bytesPerVector,
	configuredEmbeddingDim,
	hammingDistance,
	informationTheoreticScore,
	maximallyInformativeBinarization,
};

import {
	assertSqlIdentifier,
	bytesFromBlob,
	bytesPerVector,
	configuredEmbeddingDim,
	hammingDistance,
	hammingDistanceForDimension,
	informationTheoreticScore,
	isReadonlyMap,
	magnitude,
	maximallyInformativeBinarization,
	toFiniteNumber,
} from "./binary-vectors-helpers";

export class BinaryVectorStore {
	readonly conn: Database;
	readonly dbPath: DatabasePath;
	readonly tableName: string;
	private readonly ownsConnection: boolean;

	constructor(options: BinaryVectorStoreOptions = {}) {
		this.dbPath = options.dbPath ?? ":memory:";
		this.tableName = assertSqlIdentifier(options.tableName ?? "binary_vectors");
		this.conn = options.conn ?? openDatabase(this.dbPath, { create: true, readwrite: true });
		this.ownsConnection = options.conn === undefined;
		this.initTable();
	}

	private initTable(): void {
		this.conn.exec(`
			CREATE TABLE IF NOT EXISTS ${this.tableName} (
				memory_id TEXT PRIMARY KEY,
				binary_vector BLOB NOT NULL,
				original_dim INTEGER DEFAULT ${configuredEmbeddingDim()},
				magnitude REAL DEFAULT 1.0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
	}

	static maximallyInformativeBinarization(embedding: readonly number[]): Uint8Array {
		return maximallyInformativeBinarization(embedding);
	}
	static hammingDistance(binaryA: Uint8Array | ArrayBuffer, binaryB: Uint8Array | ArrayBuffer): number {
		return hammingDistance(binaryA, binaryB);
	}
	static informationTheoreticScore(distance: number, dim: number = configuredEmbeddingDim()): number {
		return informationTheoreticScore(distance, dim);
	}
	/** Write one vector at its own width. */
	storeVector(memoryId: string, embedding: readonly number[]): void {
		if (embedding.length === 0) {
			throw new Error(
				`refusing to store an empty embedding for ${memoryId}: the configured model produces ` +
					`${configuredEmbeddingDim()} dimensions, and a zero-width row scores against every query ` +
					"without holding a vector",
			);
		}
		const binary = maximallyInformativeBinarization(embedding);
		this.conn
			.query(
				`INSERT OR REPLACE INTO ${this.tableName}
				 (memory_id, binary_vector, original_dim, magnitude)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(memoryId, binary, embedding.length, magnitude(embedding));
	}
	search(queryEmbedding: readonly number[], topK = 10): BinaryVectorSearchResult[] {
		const queryDim = queryEmbedding.length;
		const queryBinary = maximallyInformativeBinarization(queryEmbedding);
		const rows = this.conn
			.query(`SELECT memory_id, binary_vector, original_dim, magnitude FROM ${this.tableName}`)
			.all() as VectorRow[];
		const results: BinaryVectorSearchResult[] = [];
		for (const row of rows) {
			const storedDim = clampLow(Math.trunc(toFiniteNumber(row.original_dim)), 0, queryDim);
			const comparedDim = Math.min(queryDim, storedDim);
			const distance = hammingDistanceForDimension(queryBinary, bytesFromBlob(row.binary_vector), comparedDim);
			results.push({
				memory_id: row.memory_id,
				distance,
				score: informationTheoreticScore(distance, comparedDim),
			});
		}
		results.sort((a, b) => b.score - a.score || a.memory_id.localeCompare(b.memory_id));
		return results.slice(0, Math.max(0, Math.trunc(topK)));
	}

	deleteVector(memoryId: string): void {
		this.conn.query(`DELETE FROM ${this.tableName} WHERE memory_id = ?`).run(memoryId);
	}
	getStats(): BinaryVectorStats {
		const row = this.conn
			.query(
				`SELECT COUNT(*) AS count,
					AVG(LENGTH(binary_vector)) AS avg_bytes,
					MAX(LENGTH(binary_vector)) AS max_bytes,
					MIN(LENGTH(binary_vector)) AS min_bytes
				 FROM ${this.tableName}`,
			)
			.get() as StatsRow;
		const count = row.count;
		const measuredBytesPerVector = row.avg_bytes ?? 0;
		return {
			total_vectors: count,
			avg_bytes_per_vector: measuredBytesPerVector,
			max_bytes: row.max_bytes ?? 0,
			min_bytes: row.min_bytes ?? 0,
			compression_ratio: bytesPerVector() / (configuredEmbeddingDim() * 4),
			theoretical_size_mb: (count * bytesPerVector()) / (1024 * 1024),
		};
	}
	close(): void {
		if (this.ownsConnection) {
			closeQuietly(this.conn);
		}
	}
}

export class FastBinarySearch {
	private readonly memoryIds: string[];
	private readonly vectors: Uint8Array[];

	constructor(
		binaryVectors: ReadonlyMap<string, Uint8Array | ArrayBuffer> | Record<string, Uint8Array | ArrayBuffer>,
	) {
		this.memoryIds = [];
		this.vectors = [];
		if (isReadonlyMap(binaryVectors)) {
			for (const [memoryId, vector] of binaryVectors) {
				this.memoryIds.push(memoryId);
				this.vectors.push(vector instanceof Uint8Array ? vector : new Uint8Array(vector));
			}
		} else {
			for (const memoryId in binaryVectors) {
				const vector = binaryVectors[memoryId];
				if (vector !== undefined) {
					this.memoryIds.push(memoryId);
					this.vectors.push(vector instanceof Uint8Array ? vector : new Uint8Array(vector));
				}
			}
		}
	}

	search(queryBinary: Uint8Array | ArrayBuffer, topK = 10): BinaryVectorSearchResult[] {
		const query = queryBinary instanceof Uint8Array ? queryBinary : new Uint8Array(queryBinary);
		const results: BinaryVectorSearchResult[] = [];
		for (let i = 0; i < this.vectors.length; i += 1) {
			const distance = hammingDistance(query, this.vectors[i] ?? new Uint8Array());
			results.push({
				memory_id: this.memoryIds[i] ?? "",
				distance,
				score: informationTheoreticScore(distance),
			});
		}
		results.sort((a, b) => a.distance - b.distance || a.memory_id.localeCompare(b.memory_id));
		return results.slice(0, Math.max(0, Math.trunc(topK)));
	}
}
