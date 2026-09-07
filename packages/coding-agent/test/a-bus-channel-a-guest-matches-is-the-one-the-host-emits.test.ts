/**
 * WHY: a vocabulary rename sweeps every `subagent` it can find. Three spellings are not the
 * product's vocabulary and stay: the two EventBus channels a collab guest matches on
 * (`@veyyon/wire` `BusChannel`, mirrored in `clients/web/src/lib/client.ts`), and the codex
 * protocol header (`codex-rs`). A sweep that moves one of them is caught here at the host
 * constant, where the guest test cannot see it: `clients/web/test/client.test.ts` applies the
 * frame it builds itself, so it stays green when the host starts emitting a different channel.
 *
 * `subagent_spawn` is pinned by `gran-2-agent-spawn-index.test.ts` through a reload, the RPC
 * frame types by `rpc-agents.test.ts`, and the `subagents/` directory by
 * `cli/agents-command.test.ts`. Not caught here: a guest that stops listening on a channel.
 */
import { describe, expect, test } from "bun:test";
import { OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";
import { TASK_AGENT_LIFECYCLE_CHANNEL, TASK_AGENT_PROGRESS_CHANNEL } from "@veyyon/coding-agent/task/types";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import type { BusChannel } from "@veyyon/wire";

describe("a bus channel a guest matches is the one the host emits", () => {
	test("the progress and lifecycle channels are the wire spellings", () => {
		// Assignability to the wire union is the compile-time half: a constant that
		// leaves the union fails `check:ts`. The equality is the run-time half.
		const progress: BusChannel = TASK_AGENT_PROGRESS_CHANNEL;
		const lifecycle: BusChannel = TASK_AGENT_LIFECYCLE_CHANNEL;
		expect(progress).toBe("task:subagent:progress");
		expect(lifecycle).toBe("task:subagent:lifecycle");
	});

	test("a listener on the wire spelling receives what the host emits on its constant", () => {
		const bus = new EventBus();
		const received: unknown[] = [];
		bus.on("task:subagent:progress", data => received.push(data));
		bus.on("task:subagent:lifecycle", data => received.push(data));
		bus.emit(TASK_AGENT_PROGRESS_CHANNEL, { id: "SpawnA" });
		bus.emit(TASK_AGENT_LIFECYCLE_CHANNEL, { id: "SpawnA", status: "started" });
		expect(received).toEqual([{ id: "SpawnA" }, { id: "SpawnA", status: "started" }]);
	});

	test("the codex parent-thread header keeps the provider's spelling", () => {
		expect(OPENAI_HEADERS.SUBAGENT).toBe("x-openai-subagent");
	});
});
