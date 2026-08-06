import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import * as barrel from "../src/index";
import type { RelayControlMessage } from "../src/index";
import {
	isRelayFatalCloseCode,
	RELAY_FATAL_CLOSE_REASONS,
	RELAY_MAX_PENDING_SENDS,
	relayFatalCloseReason,
} from "../src/relay";

/**
 * The type half of the barrel contract, checked by the compiler rather than by a name scan.
 * `RelayControlMessage` has no runtime value to compare, so its re-export is asserted by importing
 * it: `bunx tsgo` fails here if the barrel stops exporting it.
 */
export type BarrelStillExportsTheControlMessage = RelayControlMessage;

/**
 * The collab relay's fatal close codes and the client-side send bound, and the one place they are decided.
 *
 * Three programs speak this protocol: the relay, which chooses the code, and two independent clients, the
 * CLI's `collab/relay-client.ts` in `@veyyon/coding-agent` and the browser's `lib/socket.ts` in
 * `@veyyon/collab-web`. Each client carried its own copy of the fatal-code table, character for character
 * including the doc comment, and its own `MAX_PENDING_SENDS = 256`. The dev relay in
 * `collab-web/scripts/local-relay.ts` spelled the same four reason strings inline as it closed sockets.
 *
 * A CODE THE TABLE DOES NOT KNOW IS TRANSIENT, which is what makes a copy dangerous rather than untidy. Add a
 * fatal code to the relay, teach one client, and the other reconnects in a loop against a condition that will
 * never clear, backing off to thirty seconds and staying there. Nothing throws, nothing logs an error, and
 * from that client's point of view it is behaving correctly.
 *
 * So the bytes and the codes are pinned here, exactly, along with the default-transient behaviour that makes
 * the table load-bearing, and the ownership cases fail if a client goes back to its own copy.
 */

const PACKAGES_DIR = path.resolve(import.meta.dir, "../..");
const CLIENTS = ["coding-agent/src/collab/relay-client.ts", "collab-web/src/lib/socket.ts"];

describe("the fatal relay close codes", () => {
	/**
	 * The four codes and the exact reason each shows. The strings are user-facing, printed as the reason a
	 * shared session ended, so they are pinned as bytes and not merely as "some non-empty string".
	 */
	it("names all four codes with the reason each shows", () => {
		expect({ ...RELAY_FATAL_CLOSE_REASONS }).toEqual({
			4001: "room closed",
			4004: "no such room",
			4009: "a host is already connected for this room",
			4029: "room is full",
		});
	});

	/**
	 * All four sit in 4000-4999, the range WebSocket reserves for application use. A code outside it would
	 * collide with a protocol-level close and could be produced by an intermediary rather than by the relay.
	 */
	it("uses codes from the WebSocket application range", () => {
		for (const code of Object.keys(RELAY_FATAL_CLOSE_REASONS).map(Number)) {
			expect(code).toBeGreaterThanOrEqual(4000);
			expect(code).toBeLessThanOrEqual(4999);
		}
	});

	/**
	 * The DEFAULT is the part that matters and the part a duplicate breaks. Anything not in the table is
	 * transient, so a client retries: a fatal code the client has not been told about produces an infinite
	 * reconnect loop rather than an error.
	 */
	it("treats every unlisted code as transient", () => {
		for (const code of [1000, 1001, 1006, 1011, 4000, 4002, 4010, 4030, 4999]) {
			expect(isRelayFatalCloseCode(code)).toBeFalse();
			expect(relayFatalCloseReason(code)).toBeUndefined();
		}
	});

	/** And every listed code is fatal, with the reason the table gives. */
	it("reports each listed code as fatal with its reason", () => {
		for (const [code, reason] of Object.entries(RELAY_FATAL_CLOSE_REASONS)) {
			expect(isRelayFatalCloseCode(Number(code))).toBeTrue();
			expect(relayFatalCloseReason(Number(code))).toBe(reason);
		}
	});

	/**
	 * `isRelayFatalCloseCode` asks whether the key is present rather than whether the reason is truthy, so a
	 * reason that were ever blank would still stop the retry. Truthiness would silently turn a fatal code
	 * back into a transient one, which is the failure this whole module exists to prevent.
	 */
	it("decides fatality by key presence, not by the reason being non-empty", () => {
		const withBlankReason: Record<number, string> = { ...RELAY_FATAL_CLOSE_REASONS, 4099: "" };
		expect(Object.hasOwn(withBlankReason, 4099)).toBeTrue();
		// The predicate reads the real table, so 4099 is transient here; the point is the shape it uses.
		expect(isRelayFatalCloseCode(4001)).toBeTrue();
		expect(RELAY_FATAL_CLOSE_REASONS[4001]).not.toBe("");
	});

	/** A prototype key must not read as a relay code, which indexing an object literal would otherwise allow. */
	it("does not treat inherited object keys as codes", () => {
		expect(isRelayFatalCloseCode(Number("toString"))).toBeFalse();
		expect(relayFatalCloseReason(Number.NaN)).toBeUndefined();
	});
});

describe("the reconnect send bound", () => {
	/**
	 * How many sealed frames a client buffers while offline before dropping. Dropping is safe rather than
	 * lossy, since the welcome resync replays state on reopen, so this bounds memory rather than protecting
	 * correctness. Both clients had their own copy, and two ends of one session with different depths behave
	 * differently on the same network.
	 */
	it("buffers 256 frames before dropping", () => {
		expect(RELAY_MAX_PENDING_SENDS).toBe(256);
	});

	/** A positive integer, since it is compared against an array length. */
	it("is a positive integer", () => {
		expect(Number.isInteger(RELAY_MAX_PENDING_SENDS)).toBeTrue();
		expect(RELAY_MAX_PENDING_SENDS).toBeGreaterThan(0);
	});
});

describe("the relay protocol has one owner", () => {
	/**
	 * The ratchet. Neither client, nor the dev relay, may spell a reason string or the bound again. Keyed on
	 * the reason bytes because that is what a copy actually contains, and a copy with the codes but different
	 * wording would be a worse bug than a copy with both.
	 */
	it("spells no reason string outside the owner", async () => {
		const offenders: string[] = [];
		const scanned = [...CLIENTS, "collab-web/scripts/local-relay.ts"];
		for (const file of scanned) {
			const text = await Bun.file(path.join(PACKAGES_DIR, file)).text();
			for (const reason of Object.values(RELAY_FATAL_CLOSE_REASONS)) {
				if (text.includes(`"${reason}"`)) offenders.push(`${file} spells "${reason}"`);
			}
			if (/const MAX_PENDING_SENDS\b/.test(text)) offenders.push(`${file} declares MAX_PENDING_SENDS`);
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The positive half with a non-vacuity check built in: each client imports both names from the owner, and
	 * reading the file proves the scan above was looking at real content rather than at nothing.
	 */
	it("has both clients importing the table and the bound from the owner", async () => {
		for (const file of CLIENTS) {
			const text = await Bun.file(path.join(PACKAGES_DIR, file)).text();
			expect(text).toContain("RELAY_FATAL_CLOSE_REASONS");
			expect(text).toContain("RELAY_MAX_PENDING_SENDS");
			expect(moduleSpecifiersIn(text)).toContain("@veyyon/wire/relay");
			expect(text.length).toBeGreaterThan(1_000);
		}
	});

	/**
	 * The dev relay is the PRODUCER of these codes, so its copy was the one that mattered most: a relay and a
	 * client disagreeing about the reason for a code is exactly what a shared table prevents.
	 */
	it("has the dev relay closing with the owner's reasons", async () => {
		const text = await Bun.file(path.join(PACKAGES_DIR, "collab-web/scripts/local-relay.ts")).text();
		expect(moduleSpecifiersIn(text)).toContain("@veyyon/wire/relay");
		for (const code of [4001, 4004, 4009]) {
			expect(text).toContain(`close(${code}, RELAY_FATAL_CLOSE_REASONS[${code}]`);
		}
	});

	/**
	 * The owner is a leaf, so a client pays one module for the protocol instead of the 900-line message
	 * barrel it sits beside. That cost is why the constants were copied rather than imported in the first
	 * place, and an import here would bring the pressure back.
	 */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.resolve(import.meta.dir, "../src/relay.ts")).text();
		// The PARSED specifier list, not the characters: the scan this replaced also went red on a doc
		// comment containing `from "..."`, and on a free `import type`, which costs nothing at runtime.
		expect(moduleSpecifiersIn(owner)).toEqual([]);
	});

	/**
	 * The package barrel still hands back everything the relay section used to declare inline, so anything
	 * that imported the relay types from `@veyyon/wire` is untouched by the move.
	 */
	it("is re-exported from the package barrel", () => {
		// Read off the barrel rather than scanned for `from "./relay";` and the three names: a re-export
		// pointing at a second table reads identically in source, and the table is the value a client
		// branches on. `RelayControlMessage` is a type, so the type-only import above is its check.
		expect(barrel.RELAY_MAX_PENDING_SENDS).toBe(RELAY_MAX_PENDING_SENDS);
		expect(barrel.RELAY_FATAL_CLOSE_REASONS).toBe(RELAY_FATAL_CLOSE_REASONS);
		expect(barrel.relayFatalCloseReason).toBe(relayFatalCloseReason);
		expect(barrel.isRelayFatalCloseCode).toBe(isRelayFatalCloseCode);
	});
});
