/**
 * WHY THIS SUITE EXISTS
 *
 * `/profile` reached nothing from a desktop window: the profiles on disk could
 * not be listed, minted, renamed or removed, and a window had no way to reach
 * the host of a profile other than the one it launched under. The terminal
 * answers all of that through the profile store in `cli/profile-cli.ts`, so
 * the desktop half is four actions over the same store plus a section carrying
 * the endpoint each profile's host binds.
 *
 * The suite drives the real host server over a real socket, inside an isolated
 * config root, so what is asserted is the bytes a window decodes and the
 * directories the store actually wrote.
 *
 * THE CLASS THIS CLOSES: a profile action the host declares and does not
 * answer, and a section that states a profile a window cannot reach. The
 * action sweep is read off `ACTION_TO_CAPABILITY` at run time, so a fifth
 * profile action turns this red until it is driven here; the endpoint of every
 * listed row is checked against the one rule both sides bind by, so a row that
 * names a socket no client could connect to fails rather than shipping a
 * window that hangs on attach.
 *
 * WHAT IT DOES NOT CATCH: what the window DRAWS for any of it, and whether an
 * attach to another profile's endpoint succeeds — the socket is bound by that
 * profile's own host process, which this suite does not start. The surface
 * crate's suites and the recorded take own the drawing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetProfileSnapshotForTests, getActiveProfile, setProfile } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createProfile } from "../../src/cli/profile-cli";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { guiHostSocketPath, unixPathFits } from "../../src/gui-host/socket-path";
import { ACTION_TO_CAPABILITY, type HostActionTag, type ProfilesView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

/** Every action the wire says the profiles capability carries. */
const PROFILE_ACTIONS: HostActionTag[] = (Object.keys(ACTION_TO_CAPABILITY) as HostActionTag[]).filter(
	action => ACTION_TO_CAPABILITY[action] === "Profiles",
);

describe("a window lists the profiles on disk and changes the set", () => {
	let tempDir: string;
	let isolated: IsolatedConfigRoot | undefined;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let nextRequest = 0;

	/** Send one action and hand back the profiles section it published, if any. */
	async function profiles(action: unknown): Promise<{ view: ProfilesView | undefined; failed: boolean }> {
		nextRequest += 1;
		const { frames, outcome } = await client.request(nextRequest, action);
		const views = snapshotSections<ProfilesView>(frames, "Profiles");
		return { view: views[views.length - 1], failed: "RequestFailed" in outcome };
	}

	/** The refusal message of the last request, for an action expected to fail. */
	async function refusalOf(action: unknown): Promise<string> {
		nextRequest += 1;
		const { outcome } = await client.request(nextRequest, action);
		if (!("RequestFailed" in outcome) || outcome.RequestFailed === undefined) {
			throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
		}
		return outcome.RequestFailed.error.message;
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-profiles-test-"));
		isolated = enterIsolatedConfigRoot("gui-host-profiles", { defaultProfile: true });
		const authStorage = await isolatedAuthStorage(tempDir);
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		nextRequest = 0;
	});

	afterEach(async () => {
		client?.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		setProfile(undefined);
		__resetProfileSnapshotForTests();
		isolated?.restore();
		isolated = undefined;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("every profile on disk is listed once, with the one this host runs under marked", async () => {
		await createProfile("work", "blank");
		await createProfile("review", "blank");

		const { view } = await profiles("RefreshProfiles");
		expect(view).toBeDefined();
		const listed = view?.entries ?? [];
		expect(listed.map(entry => entry.name)).toEqual(["default", "review", "work"]);
		const active = view?.active ?? "";
		expect(active).toBe(getActiveProfile() ?? "default");
		expect(listed.filter(entry => entry.is_active).map(entry => entry.name)).toEqual([active]);
	});

	test("each row names an endpoint a client could connect to, under that profile's own root", async () => {
		await createProfile("work", "blank");

		const { view } = await profiles("RefreshProfiles");
		for (const entry of view?.entries ?? []) {
			expect(entry.endpoint_error, `${entry.name} has no endpoint`).toBeNull();
			const socket = entry.endpoint?.replace(/^unix:/, "") ?? "";
			expect(socket).toBe(guiHostSocketPath(path.join(entry.root_dir, "agent")));
			expect(unixPathFits(socket), `${entry.name} names a socket past the platform limit`).toBe(true);
		}
		const work = view?.entries.find(entry => entry.name === "work");
		expect(work?.root_dir).toBe(path.join(isolated?.root ?? "", "profiles", "work"));
	});

	test("a profile the window mints is on disk and in the next listing", async () => {
		const { view, failed } = await profiles({ CreateProfile: { name: "fresh", copy: [] } });
		expect(failed).toBe(false);
		expect(view?.entries.map(entry => entry.name)).toContain("fresh");
		const root = path.join(isolated?.root ?? "", "profiles", "fresh");
		expect((await fs.stat(root)).isDirectory()).toBe(true);
	});

	test("a create copies the items it was given and nothing else", async () => {
		const activeAgent = path.join(isolated?.root ?? "", "profiles", "default", "agent");
		await fs.mkdir(path.join(activeAgent, "skills"), { recursive: true });
		await fs.writeFile(path.join(activeAgent, "AGENTS.md"), "seeded instructions\n");
		await fs.writeFile(path.join(activeAgent, "skills", "one.md"), "a skill\n");

		const { failed } = await profiles({ CreateProfile: { name: "seeded", copy: ["agents"] } });
		expect(failed).toBe(false);

		const seeded = path.join(isolated?.root ?? "", "profiles", "seeded", "agent");
		expect(await fs.readFile(path.join(seeded, "AGENTS.md"), "utf8")).toBe("seeded instructions\n");
		await expect(fs.stat(path.join(seeded, "skills", "one.md"))).rejects.toThrow();
	});

	test("a create with no name, and one naming an item that does not exist, are refused with what to send", async () => {
		expect(await refusalOf({ CreateProfile: { name: "  ", copy: [] } })).toContain("needs a name");
		const unknown = await refusalOf({ CreateProfile: { name: "fresh", copy: ["wallpaper"] } });
		expect(unknown).toContain("wallpaper");
		expect(unknown).toContain("agents");
		await expect(fs.stat(path.join(isolated?.root ?? "", "profiles", "fresh"))).rejects.toThrow();
	});

	test("a rename states the new display name beside the directory name it kept", async () => {
		await createProfile("work", "blank");

		const { view, failed } = await profiles({ RenameProfile: { name: "work", display_name: "Work laptop" } });
		expect(failed).toBe(false);
		const work = view?.entries.find(entry => entry.name === "work");
		expect(work?.display_name).toBe("Work laptop");
		expect(work?.name).toBe("work");
	});

	test("a profile the window removes is gone from disk and from the listing", async () => {
		await createProfile("stale", "blank");

		const { view, failed } = await profiles({ DeleteProfile: { name: "stale" } });
		expect(failed).toBe(false);
		expect(view?.entries.map(entry => entry.name)).not.toContain("stale");
		await expect(fs.stat(path.join(isolated?.root ?? "", "profiles", "stale"))).rejects.toThrow();
	});

	test("the default profile, the active profile, and one that is not there are refused by name", async () => {
		setProfile("held");
		await createProfile("held", "blank");
		try {
			expect(await refusalOf({ DeleteProfile: { name: "default" } })).toContain("default profile");
			expect(await refusalOf({ DeleteProfile: { name: "held" } })).toContain("active profile");
		} finally {
			setProfile(undefined);
		}
		expect(await refusalOf({ DeleteProfile: { name: "never-existed" } })).toContain("never-existed");
	});

	test("every action the wire puts behind the profiles capability is answered by this host", async () => {
		expect(PROFILE_ACTIONS.length).toBeGreaterThan(0);
		const answered: HostActionTag[] = [];
		const sample: Record<string, unknown> = {
			RefreshProfiles: "RefreshProfiles",
			CreateProfile: { CreateProfile: { name: "swept", copy: [] } },
			RenameProfile: { RenameProfile: { name: "swept", display_name: "Swept" } },
			DeleteProfile: { DeleteProfile: { name: "swept" } },
		};
		for (const action of PROFILE_ACTIONS) {
			const argument = sample[action];
			expect(argument, `${action} has no sample, so the sweep proves nothing about it`).toBeDefined();
			const { view, failed } = await profiles(argument);
			expect(failed, `${action} was refused`).toBe(false);
			expect(view, `${action} published no profiles section`).toBeDefined();
			answered.push(action);
		}
		expect(answered).toEqual(PROFILE_ACTIONS);
	});
});
