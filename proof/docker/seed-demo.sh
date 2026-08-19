#!/usr/bin/env bash
# Seed the tiny project a recorded session works on.
#
# The scenes ask the model to read, edit and test real files, so the files have to
# be real: a rate limiter with a boundary worth explaining, a test that pins that
# boundary, and a utils module with a gap an edit can fill. Small on purpose -- a
# 30B model reading four short files answers in seconds, and a recording of a
# model reading a large tree is a recording of a spinner.
#
# Seeded rather than committed as a fixture directory because the recorder's HOME
# is a tmpfs: nothing here survives the container, and a scene that depends on
# state from a previous run is a scene that cannot be re-recorded.
set -euo pipefail

DEMO="${1:-/sandbox/home/demo}"
mkdir -p "${DEMO}/src"

cat >"${DEMO}/src/parser.ts" <<'TS'
export function parse(s: string): string {
	if (!s) throw new Error("empty focus string");
	return s.trim();
}
TS

cat >"${DEMO}/src/rate-limiter.ts" <<'TS'
export class RateLimiter {
	#tokens: number;
	#last: number;

	constructor(
		readonly capacity: number,
		readonly refillPerSecond: number,
	) {
		this.#tokens = capacity;
		this.#last = 0;
	}

	// Returns true when the call is allowed. A caller that arrives exactly on the
	// refill boundary is allowed: the bucket refills before the take, not after.
	take(now: number, cost = 1): boolean {
		const elapsed = Math.max(0, now - this.#last);
		this.#tokens = Math.min(this.capacity, this.#tokens + elapsed * this.refillPerSecond);
		this.#last = now;
		if (this.#tokens < cost) return false;
		this.#tokens -= cost;
		return true;
	}
}
TS

cat >"${DEMO}/src/rate-limiter.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { RateLimiter } from "./rate-limiter.ts";

test("a full bucket allows exactly its capacity", () => {
	const limiter = new RateLimiter(3, 1);
	expect([limiter.take(0), limiter.take(0), limiter.take(0), limiter.take(0)]).toEqual([
		true,
		true,
		true,
		false,
	]);
});

test("the refill boundary belongs to the caller", () => {
	const limiter = new RateLimiter(1, 1);
	expect(limiter.take(0)).toBe(true);
	expect(limiter.take(0.999)).toBe(false);
	expect(limiter.take(1)).toBe(true);
});
TS

# A plain block body rather than a nested ternary. The first take of the edit scene
# asked a 30B to append a function beside a one-line ternary and it produced an
# unterminated file, which recorded a broken test run instead of a passing one.
cat >"${DEMO}/src/utils.ts" <<'TS'
export function clampToWindow(n: number, window: number): number {
	if (n < 0) {
		return 0;
	}
	if (n > window) {
		return window;
	}
	return n;
}
TS

cat >"${DEMO}/README.md" <<'MD'
# demo

A tiny project a recording drives: a token-bucket rate limiter, its tests, and a
parser the session edits.
MD

# The two files that make this a project a language server will answer about.
# veyyon offers a server only when the config's root markers exist in the session's
# directory and the binary resolves on PATH (`loadConfig`,
# packages/coding-agent/src/lsp/config.ts), and typescript-language-server's markers
# are package.json, tsconfig.json and jsconfig.json. Without them the LSP row would
# record the model being told there is no server for this file.
#
# `allowImportingTsExtensions` because the test imports `./rate-limiter.ts` by its
# real name, which is how bun resolves it and what tsc rejects by default.
cat >"${DEMO}/package.json" <<'JSON'
{
	"name": "demo",
	"private": true,
	"type": "module"
}
JSON

cat >"${DEMO}/tsconfig.json" <<'JSON'
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "Preserve",
		"moduleResolution": "bundler",
		"strict": true,
		"noEmit": true,
		"allowImportingTsExtensions": true,
		"skipLibCheck": true
	},
	"include": ["src"]
}
JSON
