/**
 * The agent hub must show the model of every subagent, including one whose live
 * session is not attached (parked, or before the session reference lands). The
 * model recorded on the registry ref at registration is the fallback that fills
 * that gap — before it existed, such a row showed no model at all.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@veyyon/coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@veyyon/coding-agent/modes/session-observer-registry";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 24, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function makeHub(agents: AgentRegistry): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
	});
}

describe("Agent hub model badge", () => {
	let geometry: { restore(): void } | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		geometry?.restore();
		geometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("shows a subagent's model from the registry ref when no session is attached", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// No live session (parked/detached), but the model was recorded at launch.
		agents.register({
			id: "Scout",
			displayName: "Scout",
			kind: "sub",
			session: null,
			model: "anthropic/claude-opus-4-8",
		});

		const hub = makeHub(agents);
		try {
			const rendered = hub
				.render(120)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			// The `provider/` prefix is dropped in the badge; the id remains.
			expect(rendered).toContain("Scout");
			expect(rendered).toContain("claude-opus-4-8");
		} finally {
			hub.dispose();
		}
	});

	it("shows no model badge when the ref carries no model and no session", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		agents.register({ id: "Bare", displayName: "Bare", kind: "sub", session: null });

		const hub = makeHub(agents);
		try {
			const rendered = hub
				.render(120)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("Bare");
			expect(rendered).not.toContain("claude-opus-4-8");
		} finally {
			hub.dispose();
		}
	});
});
