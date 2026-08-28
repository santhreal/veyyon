export type DeterministicUuid = `${string}-${string}-${string}-${string}-${string}`;

export function deterministicUuid(seed: string): DeterministicUuid {
	const hex = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
