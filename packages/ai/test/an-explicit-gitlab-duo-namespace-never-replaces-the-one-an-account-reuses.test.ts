/**
 * An explicit GitLab Duo namespace never replaces the discovered one an account reuses.
 *
 * WHY THIS SUITE EXISTS. A turn without namespace config discovers one and caches it per account
 * and workspace, so later turns skip discovery. A turn with an explicit namespace bypasses that
 * cache. If the explicit turn also wrote the cache, every later unconfigured turn on the account
 * would run inside the namespace one side-request named, never rediscovering its own.
 *
 * THE CLASS IT CLOSES. Each order of discovered and explicit turns on one account: a discovered
 * namespace is reused, an explicit one does not seed the cache, and an explicit one does not
 * overwrite a cached one.
 *
 * WHAT IT DOES NOT CATCH. Invalidation of a cached namespace whose dependent calls fail, and the
 * workspace half of the cache key; both are driven by the provider suite.
 */
import { describe, expect, it } from "bun:test";
import {
	type GitLabDuoWorkflowWebSocketFactory,
	type GitLabDuoWorkflowWebSocketLike,
	streamGitLabDuoWorkflow,
} from "@veyyon/ai/providers/gitlab-duo-workflow";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const model: Model<"gitlab-duo-agent"> = buildModel({
	id: "claude_sonnet_4_6_vertex",
	name: "claude_sonnet_4_6_vertex",
	api: "gitlab-duo-agent",
	provider: "gitlab-duo-agent",
	baseUrl: "https://gitlab.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: null,
});

const context: Context = { messages: [{ role: "user", content: "Read the README.", timestamp: 1 }] };

/** One account's server: counts namespace discoveries and records the root namespace each turn ran in. */
class AccountServer {
	discoveries = 0;
	/** `root_namespace_id` of each turn's direct_access exchange, in order. */
	readonly roots: unknown[] = [];

	readonly fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		const method = (init?.method ?? "GET").toUpperCase();
		if (url.includes("/api/v4/groups") && url.includes("top_level_only")) {
			this.discoveries++;
			return Response.json([{ id: 500 + this.discoveries, full_path: `discovered-${this.discoveries}` }]);
		}
		if (url.includes("/api/graphql")) {
			return Response.json({
				data: {
					aiChatAvailableModels: {
						defaultModel: { name: "Claude", ref: "claude_sonnet_4_6_vertex" },
						selectableModels: [],
						pinnedModel: null,
					},
				},
			});
		}
		if (url.includes("/api/v4/ai/duo_workflows/direct_access")) {
			const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
			this.roots.push(
				typeof body === "object" && body !== null ? Reflect.get(body, "root_namespace_id") : undefined,
			);
			return Response.json({ gitlab_rails: { token: "rails-token" } });
		}
		if (url.includes("/api/v4/ai/duo_workflows/workflows") && method === "POST") {
			return Response.json({ id: "workflow-1" });
		}
		return Response.json({}, { status: 404 });
	};

	readonly webSocketFactory: GitLabDuoWorkflowWebSocketFactory = () => {
		const socket: GitLabDuoWorkflowWebSocketLike = {
			onopen: null,
			onmessage: null,
			onerror: null,
			onclose: null,
			send() {},
			close() {},
		};
		queueMicrotask(() => {
			socket.onopen?.(new Event("open"));
			socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ status: "INPUT_REQUIRED" }) }));
		});
		return socket;
	};

	constructor(readonly apiKey: string) {}

	/** Runs one turn, in `rootNamespaceId` when given and in the account's own namespace otherwise. */
	async turn(rootNamespaceId?: string): Promise<void> {
		const result = await streamGitLabDuoWorkflow(model, context, {
			apiKey: this.apiKey,
			rootNamespaceId,
			fetch: this.fetch,
			webSocketFactory: this.webSocketFactory,
		}).result();
		expect(result.stopReason).toBe("stop");
	}
}

describe("an explicit GitLab Duo namespace never replaces the one an account reuses", () => {
	it("reuses the namespace an unconfigured turn discovered", async () => {
		const account = new AccountServer("key-namespace-reuse");
		await account.turn();
		await account.turn();
		expect(account.discoveries).toBe(1);
		expect(account.roots).toEqual(["gid://gitlab/Group/501", "gid://gitlab/Group/501"]);
	});

	it("discovers on the first unconfigured turn after an explicit one", async () => {
		const account = new AccountServer("key-namespace-explicit-first");
		await account.turn("gid://gitlab/Group/9");
		await account.turn();
		expect(account.discoveries).toBe(1);
		expect(account.roots).toEqual(["gid://gitlab/Group/9", "gid://gitlab/Group/501"]);
	});

	it("keeps the cached namespace across an explicit turn", async () => {
		const account = new AccountServer("key-namespace-explicit-between");
		await account.turn();
		await account.turn("gid://gitlab/Group/9");
		await account.turn();
		expect(account.discoveries).toBe(1);
		expect(account.roots).toEqual(["gid://gitlab/Group/501", "gid://gitlab/Group/9", "gid://gitlab/Group/501"]);
	});
});
