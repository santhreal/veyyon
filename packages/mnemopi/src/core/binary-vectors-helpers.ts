import type { Database } from "bun:sqlite";
import { clampLow } from "@veyyon/utils";
import { embeddingDim, type VecType } from "../config";
import type { DatabasePath } from "../db";

export { cosineSimilarity } from "./vector-math";

export const BITS_PER_BYTE = 8;

/** Configured embedding dimension. */
export function configuredEmbeddingDim(): number {
	return embeddingDim();
}

/** Bytes one packed vector of the configured width occupies, at one bit per dimension. */
export function bytesPerVector(dim: number = configuredEmbeddingDim()): number {
	return Math.ceil(dim / BITS_PER_BYTE);
}

export const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < POPCOUNT_TABLE.length; i += 1) {
	let value = i;
	let count = 0;
	while (value !== 0) {
		value &= value - 1;
		count += 1;
	}
	POPCOUNT_TABLE[i] = count;
}

export interface BinaryVectorSearchResult {
	memory_id: string;
	distance: number;
	score: number;
}

export interface BinaryVectorStats {
	total_vectors: number;
	avg_bytes_per_vector: number;
	max_bytes: number;
	min_bytes: number;
	compression_ratio: number;
	theoretical_size_mb: number;
}

export interface BinaryVectorStoreOptions {
	dbPath?: DatabasePath;
	tableName?: string;
	conn?: Database;
}

export interface VectorRow {
	memory_id: string;
	binary_vector: Uint8Array | ArrayBuffer | Buffer;
	original_dim: number | null;
	magnitude: number | null;
}

export interface StatsRow {
	count: number;
	avg_bytes: number | null;
	max_bytes: number | null;
	min_bytes: number | null;
}

export function assertSqlIdentifier(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`Invalid SQL identifier: ${name}`);
	}
	return name;
}

export function toFiniteNumber(value: number | string | boolean | null | undefined): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

export function magnitude(embedding: readonly number[]): number {
	let sum = 0;
	for (let i = 0; i < embedding.length; i += 1) {
		const value = toFiniteNumber(embedding[i]);
		sum += value * value;
	}
	return Math.sqrt(sum);
}

export function bytesFromBlob(blob: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
	if (blob instanceof Uint8Array) {
		return blob;
	}
	return new Uint8Array(blob);
}

export function isReadonlyMap(
	value: ReadonlyMap<string, Uint8Array | ArrayBuffer> | Record<string, Uint8Array | ArrayBuffer>,
): value is ReadonlyMap<string, Uint8Array | ArrayBuffer> {
	const candidate = value as Partial<ReadonlyMap<string, Uint8Array | ArrayBuffer>> & {
		[Symbol.iterator]?: unknown;
	};
	return (
		typeof candidate.get === "function" &&
		typeof candidate.has === "function" &&
		typeof candidate.forEach === "function" &&
		typeof candidate.size === "number" &&
		typeof candidate[Symbol.iterator] === "function"
	);
}

export function getVecType(env: NodeJS.ProcessEnv = process.env): VecType {
	const value = (env.MNEMOPI_VEC_TYPE ?? "int8").trim().toLowerCase();
	if (value === "float32" || value === "int8" || value === "bit") {
		return value;
	}
	return "float32";
}

export const VEC_TYPE: VecType = getVecType();

export function quantizeInt8(embedding: readonly number[]): Int8Array {
	const out = new Int8Array(embedding.length);
	for (let i = 0; i < embedding.length; i += 1) {
		const value = clampLow(toFiniteNumber(embedding[i]), -1, 1);
		out[i] = value >= 0 ? Math.round(value * 127) : -Math.round(-value * 127);
	}
	return out;
}

/** Pack an embedding to one bit per dimension. */
export function maximallyInformativeBinarization(embedding: readonly number[]): Uint8Array {
	const dim = embedding.length;
	const nBytes = Math.ceil(dim / BITS_PER_BYTE);
	const out = new Uint8Array(nBytes);
	for (let i = 0; i < dim; i += 1) {
		if (toFiniteNumber(embedding[i]) > 0) {
			const byteIndex = i >> 3;
			out[byteIndex] = (out[byteIndex] ?? 0) | (1 << (7 - (i & 7)));
		}
	}
	return out;
}

export function hammingDistance(binaryA: Uint8Array | ArrayBuffer, binaryB: Uint8Array | ArrayBuffer): number {
	const a = binaryA instanceof Uint8Array ? binaryA : new Uint8Array(binaryA);
	const b = binaryB instanceof Uint8Array ? binaryB : new Uint8Array(binaryB);
	const shared = Math.min(a.length, b.length);
	let distance = 0;
	for (let i = 0; i < shared; i += 1) {
		distance += POPCOUNT_TABLE[(a[i] ?? 0) ^ (b[i] ?? 0)] ?? 0;
	}
	for (let i = shared; i < a.length; i += 1) {
		distance += POPCOUNT_TABLE[a[i] ?? 0] ?? 0;
	}
	for (let i = shared; i < b.length; i += 1) {
		distance += POPCOUNT_TABLE[b[i] ?? 0] ?? 0;
	}
	return distance;
}

export function hammingDistanceForDimension(
	binaryA: Uint8Array | ArrayBuffer,
	binaryB: Uint8Array | ArrayBuffer,
	dim: number,
): number {
	const a = binaryA instanceof Uint8Array ? binaryA : new Uint8Array(binaryA);
	const b = binaryB instanceof Uint8Array ? binaryB : new Uint8Array(binaryB);
	const effectiveDim = Math.max(0, Math.trunc(dim));
	const wholeBytes = effectiveDim >> 3;
	let distance = 0;
	for (let i = 0; i < wholeBytes; i += 1) {
		distance += POPCOUNT_TABLE[(a[i] ?? 0) ^ (b[i] ?? 0)] ?? 0;
	}
	const remainingBits = effectiveDim & 7;
	if (remainingBits > 0) {
		const mask = (0xff << (BITS_PER_BYTE - remainingBits)) & 0xff;
		distance += POPCOUNT_TABLE[((a[wholeBytes] ?? 0) ^ (b[wholeBytes] ?? 0)) & mask] ?? 0;
	}
	return distance;
}

export function informationTheoreticScore(distance: number, dim: number = configuredEmbeddingDim()): number {
	if (dim <= 0) {
		return 0;
	}
	return 1.0 - distance / dim;
}
