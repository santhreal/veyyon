/**
 * WHY: a Unix socket address is a fixed-size struct. `sun_path` holds 108 bytes on Linux and
 * 104 on macOS, counting the whole absolute path plus its terminating NUL, and `bind` fails
 * with ENAMETOOLONG past that. The session scope puts its socket inside a directory whose name
 * it composes, so the name is the only part of the address the product controls, and the first
 * spelling of it appended a sanitized session id of up to 48 characters to the project key. A
 * realistic profile root plus an ordinary UUID session id produced a 143-byte address, and the
 * `-advisor` derivation produced 151. Every session-scoped launch would have failed to start a
 * broker on macOS, and on Linux only because Bun binds through `/proc/self/fd`, which is not a
 * contract and does not exist on darwin.
 *
 * The class this closes: an identity segment whose width follows caller-supplied data, in a
 * path that a kernel structure bounds. The assertions below are on the DERIVED width rather
 * than on one recorded string, so re-adding a readable segment of any length turns them red.
 *
 * What it does not catch: a config root long enough to blow the budget on its own. Nothing in
 * the launch layout can fix that, and the project scope next door has carried the same
 * exposure since it shipped. The last two cases state what the layout does decide: the 8 bytes
 * the session prefix spends over the project socket, and the config root the address still
 * affords once the rest of the layout is paid for.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { daemonBrokerEndpoint, daemonRuntimeDir, daemonSessionRuntimeDir } from "@veyyon/coding-agent/launch/paths";

/** `sun_path` on darwin, the tightest of the supported platforms. Linux allows 108. */
const SUN_PATH_BYTES = 104;

/** A profile root of the shape a default install produces. */
const CONFIG_ROOT = "/Users/an-account/.veyyon/profiles/default";

const PROJECT = "/Users/an-account/src/some/deeply/nested/project";

/** Session ids the product actually hands the scope, plus two that stress the sanitizer. */
const SESSION_IDS = [
	"a1b2c3d4",
	"01998f2e-7c31-7a4b-9d55-6f0e2b8c1a37",
	"01998f2e-7c31-7a4b-9d55-6f0e2b8c1a37-advisor",
	"../../escape/../../attempt",
	"unicode-\u00e9\u00e8\u00ea-and-a-very-long-tail-".repeat(8),
];

function sessionEndpoint(sessionId: string, configRoot = CONFIG_ROOT, projectDir = PROJECT): string {
	return daemonBrokerEndpoint(projectDir, daemonSessionRuntimeDir(projectDir, sessionId, configRoot));
}

describe("a session broker socket fits the kernel's address limit", () => {
	it("addresses every session id inside sun_path, terminating NUL included", () => {
		const oversized = SESSION_IDS.map(id => [id, sessionEndpoint(id)] as const)
			.filter(([, endpoint]) => endpoint.length + 1 > SUN_PATH_BYTES)
			.map(([id, endpoint]) => `${endpoint.length + 1}B for ${id.slice(0, 24)}`);

		expect(oversized).toEqual([]);
	});

	/**
	 * The directory name must not widen with the id at all. An address that fits today because
	 * the ids in the list above happen to be short is the same defect one longer id away, so
	 * the assertion is that the width does not depend on the input.
	 */
	it("keeps the runtime directory a fixed width whatever the session id", () => {
		const widths = new Set(
			SESSION_IDS.map(id => path.basename(daemonSessionRuntimeDir(PROJECT, id, CONFIG_ROOT)).length),
		);

		expect([...widths]).toEqual(["session-".length + 16]);
	});

	/**
	 * How much of the budget the scope spends over the project layout that already ships. Only
	 * the `session-` prefix separates them, and the prefix is what stops a hex-shaped session id
	 * from resolving onto a project's own directory.
	 */
	it("costs exactly the scope prefix over the project socket", () => {
		const project = daemonBrokerEndpoint(PROJECT, daemonRuntimeDir(PROJECT, CONFIG_ROOT));

		expect(sessionEndpoint(SESSION_IDS[1] as string).length - project.length).toBe("session-".length);
	});

	/**
	 * Everything the layout adds after the config root: `/run/daemons/`, the 24-character scope
	 * directory, `/broker.sock` and the NUL. What is left is how deep a profile root an operator
	 * can carry, and it is the number to quote when one does not fit.
	 */
	it("affords 54 characters of config root", () => {
		const fixed = sessionEndpoint(SESSION_IDS[1] as string).length - CONFIG_ROOT.length;

		expect(SUN_PATH_BYTES - 1 - fixed).toBe(54);
	});

	it("separates two sessions in one project and one session id across two projects", () => {
		const other = "/Users/an-account/src/another/project";
		const first = daemonSessionRuntimeDir(PROJECT, "shared-id", CONFIG_ROOT);

		expect(first).not.toBe(daemonSessionRuntimeDir(PROJECT, "other-id", CONFIG_ROOT));
		expect(first).not.toBe(daemonSessionRuntimeDir(other, "shared-id", CONFIG_ROOT));
		expect(first).not.toBe(daemonRuntimeDir(PROJECT, CONFIG_ROOT));
	});
});
