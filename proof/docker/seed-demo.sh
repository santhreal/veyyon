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

# The parser's own test, so a session that changes the parser has something to run against
# it. Without this file the verification turn is honest and useless: the model looks for a
# parser test, correctly reports that the only suite in the project covers a different
# module, and the recording shows nothing being verified. The two cases here are the
# behaviour BEFORE the change, so the suite passes on the seeded file and keeps passing
# once whitespace-only input is rejected as well.
cat >"${DEMO}/src/parser.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { parse } from "./parser.ts";

test("trims a focus string", () => {
	expect(parse("  build the parser  ")).toBe("build the parser");
});

test("rejects an empty focus string", () => {
	expect(() => parse("")).toThrow("empty focus string");
});
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
		"skipLibCheck": true,
		"types": ["node", "bun"]
	},
	"include": ["src", "service"]
}
JSON

# THE TYPES THE FIXTURE'S OWN CODE NEEDS.
#
# Every one of the nine seeded modules reads its setting straight out of the
# environment -- that is the defect the hero take is about -- and the tests import
# `bun:test`, so without declarations the fixture does not typecheck as seeded. The
# LSP row answered every frame of the last take with `Cannot find name 'process'. Do
# you need to install type definitions for node?`, which is the fixture's diagnostic
# and not the model's: it was there before the session started and it stayed on screen
# through the fan-out, so the hero frame shipped an error the work had not caused.
#
# The container cannot reach a registry, but the repo is bind-mounted at /repo with its
# own node_modules, so the real declarations are already on disk. Copying them in is
# offline and gives the language server genuine types rather than a hand-written stub
# that would drift. bun-types comes along because @types/bun is a shim that depends on
# it, and `types` is listed EXPLICITLY: with `moduleResolution: bundler` the automatic
# sweep of node_modules/@types did not fire, and the naming both packages here is what
# takes `tsc -p` on the seeded tree from eleven errors to zero.
#
# If a source directory is missing the take still records -- the fixture simply carries
# the diagnostic again -- so this copies what is there rather than gating on it.
mkdir -p "${DEMO}/node_modules/@types"
for pkg in @types/node @types/bun bun-types; do
	if [ -d "/repo/node_modules/${pkg}" ]; then
		mkdir -p "$(dirname "${DEMO}/node_modules/${pkg}")"
		cp -R "/repo/node_modules/${pkg}" "${DEMO}/node_modules/${pkg}"
	fi
done

# ... and node_modules stays out of the demo repository, so the seeded commit below is
# the nine modules rather than 6M of declarations, and the model's `git status` is not
# a wall of vendored files.
cat >"${DEMO}/.gitignore" <<'GI'
node_modules/
GI

# THE SERVICE TREE, and why it is not four files.
#
# The hero take used to work on the parser above, and what it recorded was a model reading
# one short file and editing it. That is not what this product is for and it is not what a
# reader wants to see: the work that justifies an agent is work spread across a tree, where
# finding every site is most of the job and no single file tells you whether you are done.
#
# So the hero's subject is a service with ONE defect class repeated across nine modules in
# three directories: every numeric setting is read straight out of the environment with no
# owner and no validation, each in a slightly different spelling, so `Number("")` is 0,
# `parseInt` without a radix is whatever the string starts with, and a typo in a deploy is a
# silent zero rather than a failed boot. Finding all nine takes a search rather than a read;
# fixing them is one owner plus nine call sites; proving it takes the suite. It is the shape
# of a real refactor, small enough that a 30B finishes it in one session.
#
# The spellings differ ON PURPOSE. A single pattern would be one grep and the fan-out would
# be theatre; three spellings mean the agents have to agree on what counts.
mkdir -p "${DEMO}/service/config" "${DEMO}/service/handlers" "${DEMO}/service/store"

seed_numeric_module() {
	local path="$1" name="$2" var="$3" fallback="$4" spelling="$5" doc="$6"
	local read_expr
	case "${spelling}" in
	number) read_expr="Number(process.env.${var} ?? \"${fallback}\")" ;;
	parseint) read_expr="parseInt(process.env.${var} ?? \"${fallback}\")" ;;
	unary) read_expr="+(process.env.${var} ?? \"${fallback}\")" ;;
	*) read_expr="Number(process.env.${var} ?? \"${fallback}\")" ;;
	esac
	cat >"${DEMO}/${path}" <<TS
// ${doc}
export const ${name} = ${read_expr};

export function describe${name^}(): string {
	return \`${var}=\${${name}}\`;
}
TS
}

seed_numeric_module service/config/limits.ts maxBatch MAX_BATCH 100 number "How many records one flush may carry."
seed_numeric_module service/config/timeouts.ts requestTimeoutMs REQUEST_TIMEOUT_MS 30000 parseint "How long one upstream call may take."
seed_numeric_module service/config/retries.ts maxRetries MAX_RETRIES 3 unary "How many times a failed call is retried."
seed_numeric_module service/handlers/ingest.ts ingestConcurrency INGEST_CONCURRENCY 4 number "How many ingest workers run at once."
seed_numeric_module service/handlers/export.ts exportPageSize EXPORT_PAGE_SIZE 500 parseint "How many rows one export page holds."
seed_numeric_module service/handlers/webhook.ts webhookBackoffMs WEBHOOK_BACKOFF_MS 250 unary "How long a webhook waits before retrying."
seed_numeric_module service/store/pool.ts poolSize POOL_SIZE 8 number "How many connections the pool keeps open."
seed_numeric_module service/store/cache.ts cacheTtlSeconds CACHE_TTL_SECONDS 60 parseint "How long a cached row stays fresh."
seed_numeric_module service/store/vacuum.ts vacuumIntervalMs VACUUM_INTERVAL_MS 900000 unary "How often the store compacts itself."

# The suite passes on the seeded tree, and it pins the behaviour for values that ARE valid, so
# the session's own additions are about invalid ones. A suite that started red would record a
# model fixing a broken project rather than hardening a working one.
cat >"${DEMO}/service/settings.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { maxBatch } from "./config/limits.ts";
import { maxRetries } from "./config/retries.ts";
import { requestTimeoutMs } from "./config/timeouts.ts";

test("a numeric setting falls back to its documented default", () => {
	expect([maxBatch, requestTimeoutMs, maxRetries]).toEqual([100, 30000, 3]);
});
TS

cat >"${DEMO}/service/README.md" <<'MD'
# service

Nine numeric settings, three directories, no owner: every module reads its own
environment variable in its own spelling and trusts whatever comes back.
MD

# A git repository, because the scenes ask the model to commit its work. Without this
# the commit turn records `fatal: not a git repository` in red and the session's last
# act is a failed tool call -- which is exactly what the take before this one shot.
# Identity is set locally rather than globally so nothing here depends on the image's
# git config, and the initial commit is the seeded state so the model's commit is a
# diff of the work rather than the whole project arriving at once.
git -C "${DEMO}" init -q -b main
git -C "${DEMO}" config user.name "demo"
git -C "${DEMO}" config user.email "demo@example.invalid"
git -C "${DEMO}" add -A
git -C "${DEMO}" -c commit.gpgsign=false commit -q -m "seed the parser and its tests"
