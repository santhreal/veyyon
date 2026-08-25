#!/usr/bin/env bash
# Seed the isolated projects used by recorded sessions.
#
# Every scene reads, edits, and verifies real files. Short feature scenes use the
# parser, rate limiter, and service fixtures. The landing-page hero starts inside
# ship-sim/, where a specification and executable tests define a larger greenfield
# build without pre-writing the implementation the model is meant to produce.
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

# ... and node_modules plus the compiled ship binary stay out of the demo repository,
# so git status shows only work the recorded session actually produced.
cat >"${DEMO}/.gitignore" <<'GI'
node_modules/
ship-sim/dist/
GI

# THE SERVICE REFACTOR FIXTURE.
#
# One defect class repeats across nine modules in three directories: every
# numeric setting is read straight out of the environment with no owner and no
# validation, each in a slightly different spelling. Finding every site takes a
# search rather than a read; fixing them takes one owner plus nine call sites;
# proving the change takes the suite. The spellings differ so a single pattern
# cannot stand in for the audit.
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


# THE LONG-RUNNING HERO PROJECT.
#
# The landing-page session starts inside this directory. It is a real greenfield
# build rather than another repair of the small fixtures above: the specification,
# interfaces, and executable acceptance tests exist, while the 3D math, flight
# dynamics, renderer, autopilot, signing module, and integrated CLI are the work the
# agent must create. The tests make three parallel lanes independent and deterministic.
mkdir -p "${DEMO}/ship-sim/src" "${DEMO}/ship-sim/test"

cat >"${DEMO}/ship-sim/package.json" <<'JSON'
{
	"name": "nebula-drift",
	"private": true,
	"type": "module",
	"scripts": {
		"test": "bun test",
		"typecheck": "tsc --noEmit -p tsconfig.json",
		"build": "bun build src/cli.ts --compile --outfile dist/nebula-drift",
		"demo": "./dist/nebula-drift --frames 1 --seed 42 --width 72 --height 24",
		"sign": "bun src/sign.ts dist/nebula-drift dist/nebula-drift.sig"
	}
}
JSON

cat >"${DEMO}/ship-sim/tsconfig.json" <<'JSON'
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
	"include": ["src", "test"]
}
JSON

cp /repo/proof/prompts/demo-hd.md "${DEMO}/ship-sim/TASK.md"

cat >"${DEMO}/ship-sim/SPEC.md" <<'MD'
# Nebula Drift

Build a deterministic terminal 3D ship simulator with no third-party dependencies.

## Product

- Compile `src/cli.ts` into `dist/nebula-drift` with `bun build --compile`.
- Render a perspective-projected wireframe ship, seeded star field, flight vector,
  mission gate, and telemetry HUD in a 72×24 terminal frame.
- Simulate thrust, drag, yaw, pitch, roll, fuel consumption, and a deterministic
  autopilot that approaches a 3D navigation gate.
- Accept `--frames`, `--seed`, `--width`, and `--height`. A one-frame run prints no
  cursor-control bytes. Multi-frame runs animate in place and terminate at the
  requested bound.
- Keep every simulation deterministic for the same arguments.

## Architecture

- `src/math.ts`: immutable vector operations, rotations, and perspective projection.
- `src/physics.ts`: immutable ship stepping with bounded controls and finite state.
- `src/autopilot.ts`: control decisions that reduce distance to a mission gate.
- `src/renderer.ts`: bounded ASCII frame buffer, star field, wireframe hull, gate, and HUD.
- `src/sign.ts`: HMAC-SHA256 release signing. Read the key only from
  `SHIP_RELEASE_KEY`; never print it. Write `<hex>  <binary-name>` to the signature file.
- `src/cli.ts`: argument parsing, simulation loop, rendering, animation, and honest errors.

The seeded tests are the acceptance contract. Do not weaken them.
MD

cat >"${DEMO}/ship-sim/src/contracts.ts" <<'TS'
export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

export interface ShipState {
	position: Vec3;
	velocity: Vec3;
	yaw: number;
	pitch: number;
	roll: number;
	fuel: number;
	elapsed: number;
}

export interface ControlInput {
	throttle: number;
	yaw: number;
	pitch: number;
	roll: number;
}

export interface Projection {
	x: number;
	y: number;
	visible: boolean;
	depth: number;
}

export interface RenderOptions {
	width: number;
	height: number;
	seed: number;
	target: Vec3;
}
TS

cat >"${DEMO}/ship-sim/src/cli.ts" <<'TS'
const args = new Set(process.argv.slice(2));

if (args.has("--help")) {
	process.stdout.write("Nebula Drift terminal ship simulator\n");
} else {
	process.stdout.write("Nebula Drift flight computer online\n");
}
TS

cat >"${DEMO}/ship-sim/test/math.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { projectPoint, rotateY } from "../src/math.ts";

test("rotation and perspective projection preserve the 3D contract", () => {
	const rotated = rotateY({ x: 1, y: 0, z: 0 }, Math.PI / 2);
	expect(rotated.x).toBeCloseTo(0, 8);
	expect(rotated.z).toBeCloseTo(-1, 8);

	expect(projectPoint({ x: 0, y: 0, z: 5 }, 80, 24, 60)).toEqual({
		x: 40,
		y: 12,
		visible: true,
		depth: 5,
	});
	expect(projectPoint({ x: 0, y: 0, z: -1 }, 80, 24, 60).visible).toBe(false);
});
TS

cat >"${DEMO}/ship-sim/test/physics.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { createInitialShip, stepShip } from "../src/physics.ts";

test("thrust advances an immutable finite ship state", () => {
	const initial = createInitialShip();
	const next = stepShip(initial, { throttle: 1, yaw: 0.25, pitch: 0, roll: 0 }, 1);

	expect(initial.position).toEqual({ x: 0, y: 0, z: 0 });
	expect(next).not.toBe(initial);
	expect(next.position.z).toBeGreaterThan(0);
	expect(next.velocity.z).toBeGreaterThan(0);
	expect(next.yaw).toBeGreaterThan(0);
	expect(next.fuel).toBeLessThan(initial.fuel);
	for (const value of [
		next.position.x,
		next.position.y,
		next.position.z,
		next.velocity.x,
		next.velocity.y,
		next.velocity.z,
		next.fuel,
	]) {
		expect(Number.isFinite(value)).toBe(true);
	}
});
TS

cat >"${DEMO}/ship-sim/test/autopilot.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { autopilotControl } from "../src/autopilot.ts";
import { createInitialShip, stepShip } from "../src/physics.ts";

test("autopilot closes distance to a navigation gate with bounded controls", () => {
	const target = { x: 4, y: 2, z: 30 };
	let ship = createInitialShip();
	const startDistance = Math.hypot(
		target.x - ship.position.x,
		target.y - ship.position.y,
		target.z - ship.position.z,
	);

	for (let frame = 0; frame < 120; frame += 1) {
		const control = autopilotControl(ship, target);
		expect(control.throttle).toBeGreaterThanOrEqual(0);
		expect(control.throttle).toBeLessThanOrEqual(1);
		expect(control.yaw).toBeGreaterThanOrEqual(-1);
		expect(control.yaw).toBeLessThanOrEqual(1);
		expect(control.pitch).toBeGreaterThanOrEqual(-1);
		expect(control.pitch).toBeLessThanOrEqual(1);
		expect(control.roll).toBeGreaterThanOrEqual(-1);
		expect(control.roll).toBeLessThanOrEqual(1);
		ship = stepShip(ship, control, 1 / 30);
	}

	const endDistance = Math.hypot(
		target.x - ship.position.x,
		target.y - ship.position.y,
		target.z - ship.position.z,
	);
	expect(endDistance).toBeLessThan(startDistance);
});
TS

cat >"${DEMO}/ship-sim/test/renderer.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { createInitialShip } from "../src/physics.ts";
import { renderFrame } from "../src/renderer.ts";

test("renderer produces a deterministic bounded 3D flight display", () => {
	const ship = createInitialShip();
	const options = {
		width: 72,
		height: 24,
		seed: 42,
		target: { x: 4, y: 2, z: 30 },
	};
	const first = renderFrame(ship, options);
	const second = renderFrame(ship, options);
	const lines = first.split("\n");

	expect(first).toBe(second);
	expect(lines).toHaveLength(24);
	expect(lines.every(line => line.length === 72)).toBe(true);
	expect(first).toContain("NEBULA DRIFT");
	expect(first).toContain("AUTOPILOT");
	expect(first).toContain("FUEL");
	expect(first).toContain("GATE");
	expect(first).toMatch(/[+\\/|<>]/);
});
TS

cat >"${DEMO}/ship-sim/test/sign.test.ts" <<'TS'
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { signBytes } from "../src/sign.ts";

test("release signatures bind the binary bytes without exposing the key", () => {
	const bytes = new Uint8Array([0, 1, 2, 3, 255]);
	const expected = createHmac("sha256", "fixture-key").update(bytes).digest("hex");
	expect(signBytes(bytes, "fixture-key")).toBe(expected);
	expect(signBytes(new Uint8Array([0, 1, 2, 4, 255]), "fixture-key")).not.toBe(expected);
});
TS
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
git -C "${DEMO}" -c commit.gpgsign=false commit -q -m "seed the demo projects"

# A SECOND PROJECT THAT EXISTS ONLY TO BE WIDE. The footline's `location` zone holds the
# working directory and the git branch, and the two together are what squeezes the right
# group at 80 and 100 columns. Every fixture above sits directly in ${DEMO} on `main`,
# which is eleven columns of location and never reaches the width where the shed order
# decides anything -- so a scene about the footline photographed a line under no pressure.
# Kept outside ${DEMO} rather than beneath it, because a repository nested inside another
# is added to the outer one as a gitlink by the `git add -A` above.
WIDE="$(dirname "${DEMO}")/platform-services/ingest-pipeline/normalizer"
mkdir -p "${WIDE}/src"
cat >"${WIDE}/src/normalize.ts" <<'TS'
export function normalize(record: { id: string; value: number }): string {
	return `${record.id}:${record.value.toFixed(2)}`;
}
TS
git -C "${WIDE}" init -q -b feature/statusline-model-retention-long-path
git -C "${WIDE}" config user.name "demo"
git -C "${WIDE}" config user.email "demo@example.invalid"
git -C "${WIDE}" add -A
git -C "${WIDE}" -c commit.gpgsign=false commit -q -m "seed the normalizer"
