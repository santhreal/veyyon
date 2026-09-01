import * as path from "node:path";

export type BinaryPin =
	| { readonly kind: "build" }
	| { readonly kind: "pinned"; readonly path: string }
	| { readonly kind: "invalid"; readonly reason: string };

export function resolveBinaryPin(flag: string | undefined, cwd: string = process.cwd()): BinaryPin {
	if (flag === undefined) return { kind: "build" };
	const trimmed = flag.trim();
	if (trimmed === "") {
		return {
			kind: "invalid",
			reason: "--binary was given an empty path. Point it at a run's assets/vey, or omit it.",
		};
	}
	return { kind: "pinned", path: path.resolve(cwd, trimmed) };
}
