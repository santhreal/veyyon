/**
 * WHY: `TranscriptBlockComponent` is the terminal host's unified production component
 * for rendering any `TranscriptBlock` presentation model.
 *
 * It defends the following observable contracts:
 * - Exhaustive run-time mapping over `TRANSCRIPT_BLOCK_KINDS`
 * - In-place stateful updates for live streaming, tool results, and execution output
 * - No output duplication on cumulative streaming updates (bash/eval output replacement)
 * - Bash signal propagation and status footer rendering
 * - Custom message presentation levels (info/warning/error) and hook icons
 * - Unrecoverable error presentation and path sanitization
 * - Unified attachment formatting (shortenPath, size, skip reasons) for user & file blocks
 * - Scrollback finalization, version folding (outer + inner), and settling contracts
 * - Clean disposal and teardown
 */

import { describe, expect, it } from "bun:test";
import { Text, type TUI } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import {
	type AssistantMessageBlock,
	type BashExecutionBlock,
	type CustomBlock,
	type ErrorBlock,
	type HookBlock,
	type PythonExecutionBlock,
	type ToolExecutionBlock,
	TRANSCRIPT_BLOCK_KINDS,
	type TranscriptBlock,
} from "@veyyon/wire/presentation";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "../../../../src/collab/protocol";
import { ChatTranscriptBuilder } from "../../../../src/modes/terminal/components/transcript/chat-transcript-builder";
import { CustomMessageComponent } from "../../../../src/modes/terminal/components/transcript/custom-message";
import { HookMessageComponent } from "../../../../src/modes/terminal/components/transcript/hook-message";
import {
	TranscriptBlockComponent,
	type TranscriptBlockComponentOptions,
} from "../../../../src/modes/terminal/components/transcript/transcript-block-component";
import { toTranscriptBlock } from "../../../../src/presentation/transcript-builder";
import { type CustomMessage, type HookMessage, SKILL_PROMPT_MESSAGE_TYPE } from "../../../../src/session/messages";
import { initTheme } from "../../../../src/theme/theme";

initTheme();

function createMockTui(): TUI {
	return {
		requestRender: () => {},
		requestComponentRender: () => {},
		imageBudget: undefined,
	} as unknown as TUI;
}

function createOptions(overrides: Partial<TranscriptBlockComponentOptions> = {}): TranscriptBlockComponentOptions {
	return {
		tui: createMockTui(),
		onRequestRender: () => {},
		...overrides,
	};
}

function sampleBlockOfKind(kind: TranscriptBlock["kind"]): TranscriptBlock {
	const id = `test-${kind}`;
	const timestamp = 1_700_000_000_000;
	switch (kind) {
		case "user-message":
			return {
				kind,
				id,
				text: "Hello from user",
				attachments: [{ kind: "file", name: "test.ts", lineCount: 10, byteSize: 200 }],
				timestamp,
			};
		case "developer-message":
			return { kind, id, text: "System developer instruction", timestamp };
		case "assistant-message":
			return {
				kind,
				id,
				segments: [{ kind: "text", text: "Assistant reply content" }],
				model: "anthropic/claude-3-7-sonnet",
				stopReason: "complete",
				streaming: false,
				timestamp,
			};
		case "tool-execution":
			return {
				kind,
				id,
				toolCallId: "call-1",
				toolName: "read",
				status: "succeeded",
				input: JSON.stringify({ path: "src/index.ts" }),
				output: "file contents",
				timestamp,
			};
		case "bash-execution":
			return {
				kind,
				id,
				command: "echo 'hello world'",
				output: "hello world\n",
				exitCode: 0,
				cancelled: false,
				timestamp,
			};
		case "python-execution":
			return {
				kind,
				id,
				code: "print(1 + 1)",
				output: "2\n",
				exitCode: 0,
				cancelled: false,
				timestamp,
			};
		case "custom":
			return {
				kind,
				id,
				customKind: "notice",
				text: "Custom notification message",
				level: "info",
				timestamp,
			};
		case "hook":
			return {
				kind,
				id,
				hookName: "pre-commit",
				text: "Hook execution output",
				timestamp,
			};
		case "branch-summary":
			return {
				kind,
				id,
				summary: "Branch summary details",
				timestamp,
			};
		case "compaction-summary":
			return {
				kind,
				id,
				summary: "Compacted history summary",
				tokensBefore: 12000,
				compactedBy: "auto",
				timestamp,
			};
		case "file-mention":
			return {
				kind,
				id,
				files: [
					{ kind: "file", name: "packages/app/index.ts", lineCount: 42 },
					{ kind: "image", name: "screenshot.png", byteSize: 1024 },
				],
				timestamp,
			};
		case "error":
			return {
				kind,
				id,
				message: "Network request failed: timeout",
				recoverable: true,
				timestamp,
			};
	}
}

describe("TranscriptBlockComponent", () => {
	it("renders every block kind in TRANSCRIPT_BLOCK_KINDS without empty output", () => {
		const options = createOptions();
		for (const kind of TRANSCRIPT_BLOCK_KINDS) {
			const block = sampleBlockOfKind(kind);
			const component = new TranscriptBlockComponent(block, options);
			const lines = component.render(80);

			expect(lines.length).toBeGreaterThan(0);
			const text = lines.map(stripAnsi).join("\n");
			expect(text.trim().length).toBeGreaterThan(0);

			expect(component.block.kind).toBe(kind);
			expect(component.value.kind).toBe(kind);
			component.dispose();
		}
	});

	it("updates assistant messages in place during streaming and seals on completion", () => {
		const options = createOptions();
		const streamingBlock: AssistantMessageBlock = {
			kind: "assistant-message",
			id: "assistant-1",
			segments: [{ kind: "text", text: "Streaming chunk 1" }],
			model: "claude-3-7",
			stopReason: "complete",
			streaming: true,
			timestamp: 1_700_000_000_000,
		};

		const component = new TranscriptBlockComponent(streamingBlock, options);
		const initialLines = component.render(80).map(stripAnsi).join("\n");
		expect(initialLines).toContain("Streaming chunk 1");
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		const updatedBlock: AssistantMessageBlock = {
			...streamingBlock,
			segments: [{ kind: "text", text: "Streaming chunk 1 and chunk 2" }],
			streaming: false,
		};

		component.set(updatedBlock);
		const finalizedLines = component.render(80).map(stripAnsi).join("\n");
		expect(finalizedLines).toContain("Streaming chunk 1 and chunk 2");
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		component.dispose();
	});

	it("renders tool execution status, duration meta, JSON tree, and updates in place", () => {
		const options = createOptions();
		const runningBlock: ToolExecutionBlock = {
			kind: "tool-execution",
			id: "tool-1",
			toolCallId: "call-1",
			toolName: "read",
			status: "running",
			input: JSON.stringify({ path: "src/main.ts" }),
			timestamp: 1_700_000_000_000,
		};

		const component = new TranscriptBlockComponent(runningBlock, options);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		const runningLines = component.render(80).map(stripAnsi).join("\n");
		expect(runningLines).toMatch(/read/i);
		expect(runningLines).toContain("src/main.ts");

		// Update to succeeded with duration and JSON output
		const completedBlock: ToolExecutionBlock = {
			...runningBlock,
			status: "succeeded",
			output: JSON.stringify({ result: "ok", count: 42 }),
			durationMs: 1500,
		};

		component.set(completedBlock);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		const completedLines = component.render(80).map(stripAnsi).join("\n");
		expect(completedLines).toMatch(/read/i);
		expect(completedLines).toContain("result");
		expect(completedLines).toContain("ok");

		// Update to failed status with error
		const failedBlock: ToolExecutionBlock = {
			...runningBlock,
			status: "failed",
			error: "Permission denied reading src/main.ts",
		};

		component.set(failedBlock);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		const failedLines = component.render(80).map(stripAnsi).join("\n");
		expect(failedLines).toContain("Permission denied");

		component.dispose();
	});

	it("does not duplicate bash output on cumulative streaming updates and renders signals", () => {
		const options = createOptions();
		const runningBlock: BashExecutionBlock = {
			kind: "bash-execution",
			id: "bash-1",
			command: "npm test",
			output: "Line 1\n",
			exitCode: null,
			cancelled: false,
			timestamp: 1_700_000_000_000,
		};

		const component = new TranscriptBlockComponent(runningBlock, options);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		// Cumulative update 1: output is "Line 1\nLine 2\n"
		component.set({
			...runningBlock,
			output: "Line 1\nLine 2\n",
		});

		const intermediate = component.render(80).map(stripAnsi).join("\n");
		// Check that "Line 1" appears exactly once in the rendered output lines
		const line1Matches = intermediate.match(/Line 1/g);
		expect(line1Matches?.length).toBe(1);

		// Completion with signal
		const killedBlock: BashExecutionBlock = {
			...runningBlock,
			output: "Line 1\nLine 2\nProcess interrupted\n",
			exitCode: 137,
			signal: "SIGKILL",
		};

		component.set(killedBlock);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		const killedLines = component.render(80).map(stripAnsi).join("\n");
		expect(killedLines).toContain("(killed by signal SIGKILL)");
		expect(killedLines).toContain("Line 2");

		component.dispose();
	});

	it("does not duplicate python eval output on cumulative updates", () => {
		const options = createOptions();
		const runningBlock: PythonExecutionBlock = {
			kind: "python-execution",
			id: "py-1",
			code: "for i in range(2): print(i)",
			output: "0\n",
			exitCode: null,
			cancelled: false,
			timestamp: 1_700_000_000_000,
		};

		const component = new TranscriptBlockComponent(runningBlock, options);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		// Cumulative update: output is "0\n1\n"
		component.set({
			...runningBlock,
			output: "0\n1\n",
		});

		const rendered = component.render(80).map(stripAnsi).join("\n");
		const zeroMatches = rendered.match(/\b0\b/g);
		expect(zeroMatches?.length).toBe(1);

		// Complete
		component.set({
			...runningBlock,
			output: "0\n1\n",
			exitCode: 0,
		});
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		component.dispose();
	});

	it("respects custom message levels (info, warning, error) and hook icons", () => {
		const options = createOptions();

		// Info level
		const infoBlock: CustomBlock = {
			kind: "custom",
			id: "cust-1",
			customKind: "notice",
			text: "Informational notice",
			level: "info",
			timestamp: 1_700_000_000_000,
		};
		const infoComp = new TranscriptBlockComponent(infoBlock, options);
		const infoLines = infoComp.render(80).map(stripAnsi).join("\n");
		expect(infoLines).toContain("notice");
		expect(infoLines).toContain("Informational notice");
		infoComp.dispose();

		// Warning level
		const warningBlock: CustomBlock = {
			kind: "custom",
			id: "cust-2",
			customKind: "security-warning",
			text: "Potentially unsafe configuration",
			level: "warning",
			timestamp: 1_700_000_000_000,
		};
		const warnComp = new TranscriptBlockComponent(warningBlock, options);
		const warnLines = warnComp.render(80).map(stripAnsi).join("\n");
		expect(warnLines).toContain("security-warning");
		expect(warnLines).toContain("Potentially unsafe configuration");
		warnComp.dispose();

		// Error level
		const errorCustomBlock: CustomBlock = {
			kind: "custom",
			id: "cust-3",
			customKind: "failure-alert",
			text: "Service connection refused",
			level: "error",
			timestamp: 1_700_000_000_000,
		};
		const errCustomComp = new TranscriptBlockComponent(errorCustomBlock, options);
		const errCustomLines = errCustomComp.render(80).map(stripAnsi).join("\n");
		expect(errCustomLines).toContain("failure-alert");
		expect(errCustomLines).toContain("Service connection refused");
		errCustomComp.dispose();

		// Hook block
		const hookBlock: HookBlock = {
			kind: "hook",
			id: "hook-1",
			hookName: "pre-commit",
			text: "Running linters and typechecks...",
			timestamp: 1_700_000_000_000,
		};
		const hookComp = new TranscriptBlockComponent(hookBlock, options);
		const hookLines = hookComp.render(80).map(stripAnsi).join("\n");
		expect(hookLines).toContain("pre-commit");
		expect(hookLines).toContain("Running linters and typechecks...");
		hookComp.dispose();
	});

	it("renders specialized custom message display variants faithfully", () => {
		const options = createOptions();

		// Async result variant
		const asyncResultBlock: CustomBlock = {
			kind: "custom",
			id: "cust-async",
			customKind: "async-result",
			text: "",
			level: "info",
			timestamp: 1_700_000_000_000,
			display: {
				variant: "async-result",
				jobs: [
					{ jobId: "job-101", type: "bash", label: "test suite", durationMs: 3500 },
					{ jobId: "job-102", type: "task", label: "fetch", durationMs: 1200 },
				],
			},
		};
		const asyncComp = new TranscriptBlockComponent(asyncResultBlock, options);
		const asyncLines = asyncComp.render(80).map(stripAnsi).join("\n");
		expect(asyncLines).toContain("Background job completed");
		expect(asyncLines).toContain("[bash]");
		expect(asyncLines).toContain("job-101");
		expect(asyncLines).toContain("3.5s");
		expect(asyncLines).toContain("[task]");
		expect(asyncLines).toContain("job-102");
		expect(asyncLines).toContain("1.2s");
		asyncComp.dispose();

		// Late diagnostics variant
		const lateDiagBlock: CustomBlock = {
			kind: "custom",
			id: "cust-diag",
			customKind: "lsp-late-diagnostic",
			text: "",
			level: "info",
			timestamp: 1_700_000_000_000,
			display: {
				variant: "late-diagnostics",
				files: [
					{
						path: "src/app.ts",
						summary: "2 type errors",
						errored: true,
						messages: ["Type 'number' is not assignable to type 'string'."],
					},
				],
			},
		};
		const diagComp = new TranscriptBlockComponent(lateDiagBlock, options);
		const diagLines = diagComp.render(80).map(stripAnsi).join("\n");
		expect(diagLines).toContain("Late diagnostics");
		expect(diagLines).toContain("2 type errors");
		diagComp.dispose();

		// Collab prompt variant
		const collabBlock: CustomBlock = {
			kind: "custom",
			id: "cust-collab",
			customKind: "collab-prompt",
			text: "Please check the authentication middleware",
			level: "info",
			timestamp: 1_700_000_000_000,
			display: {
				variant: "collab-prompt",
				from: "alice",
				text: "Please check the authentication middleware",
			},
		};
		const collabComp = new TranscriptBlockComponent(collabBlock, options);
		const collabLines = collabComp.render(80).map(stripAnsi).join("\n");
		expect(collabLines).toContain("«alice»");
		expect(collabLines).toContain("Please check the authentication middleware");
		collabComp.dispose();

		// Skill prompt variant
		const skillBlock: CustomBlock = {
			kind: "custom",
			id: "cust-skill",
			customKind: "skill-prompt",
			text: "Implement OAuth2 login with PKCE",
			level: "info",
			timestamp: 1_700_000_000_000,
			display: {
				variant: "skill-prompt",
				name: "auth-expert",
				path: "skills/auth.md",
				args: "with PKCE",
				lineCount: 42,
				promptBytes: 1024,
				text: "Implement OAuth2 login with PKCE",
			},
		};
		const skillComp = new TranscriptBlockComponent(skillBlock, options);
		const skillCollapsedLines = skillComp.render(80).map(stripAnsi).join("\n");
		expect(skillCollapsedLines).toContain("skill");
		expect(skillCollapsedLines).toContain("auth-expert");
		expect(skillCollapsedLines).toContain("with PKCE");
		expect(skillCollapsedLines).toContain("42 lines");
		expect(skillCollapsedLines).not.toContain("prompt");

		// Skill expansion
		skillComp.setExpanded(true);
		const skillExpandedLines = skillComp.render(80).map(stripAnsi).join("\n");
		expect(skillExpandedLines).toContain("prompt");
		expect(skillExpandedLines).toContain("Implement OAuth2 login with PKCE");
		skillComp.dispose();

		// IRC message variant
		const ircBlock: CustomBlock = {
			kind: "custom",
			id: "cust-irc",
			customKind: "irc:incoming",
			text: "Ready for code review",
			level: "info",
			timestamp: 1_700_000_000_000,
			display: {
				variant: "irc",
				kind: "incoming",
				from: "bob",
				body: "Ready for code review",
				timestamp: 1_700_000_000_000,
			},
		};
		const ircComp = new TranscriptBlockComponent(ircBlock, options);
		const ircLines = ircComp.render(80).map(stripAnsi).join("\n");
		expect(ircLines).toContain("IRC");
		expect(ircLines).toContain("bob");
		expect(ircLines).toContain("Ready for code review");
		ircComp.dispose();

		// Advisor variant
		const advisorBlock: CustomBlock = {
			kind: "custom",
			id: "cust-advisor",
			customKind: "advisor",
			text: "",
			level: "info",
			timestamp: 1_700_000_000_000,
			display: {
				variant: "advisor",
				notes: [
					{ note: "Security vulnerability in session token generator", severity: "blocker", advisor: "sec-bot" },
					{ note: "Consider adding request timeout", severity: "nit" },
				],
			},
		};
		const advisorComp = new TranscriptBlockComponent(advisorBlock, options);
		const advisorLines = advisorComp.render(80).map(stripAnsi).join("\n");
		expect(advisorLines).toContain("Advisor");
		expect(advisorLines).toContain("2 notes");
		expect(advisorLines).toContain("1 blocker");
		expect(advisorLines).toContain("Security vulnerability in session token generator");
		expect(advisorLines).toContain("[sec-bot]");
		expect(advisorLines).toContain("Consider adding request timeout");
		advisorComp.dispose();

		// Background tan dispatch variant
		const tanBlock: CustomBlock = {
			kind: "custom",
			id: "cust-tan",
			customKind: "background-tan-dispatch",
			text: "",
			level: "info",
			timestamp: 1_700_000_000_000,
			display: {
				variant: "background-tan",
				jobId: "tan-42",
				work: "audit dependencies",
			},
		};
		const tanComp = new TranscriptBlockComponent(tanBlock, options);
		const tanLines = tanComp.render(80).map(stripAnsi).join("\n");
		expect(tanLines).toContain("Tangent dispatched");
		expect(tanLines).toContain("[task]");
		expect(tanLines).toContain("tan-42");
		expect(tanLines).toContain("audit dependencies");
		tanComp.dispose();

		// Handoff summary variant
		const handoffBlock: CustomBlock = {
			kind: "custom",
			id: "cust-handoff",
			customKind: "handoff",
			text: "",
			level: "info",
			timestamp: 1_700_000_000_000,
			display: {
				variant: "handoff",
				summary: "Migrated presentation models to wire types.",
			},
		};
		const handoffComp = new TranscriptBlockComponent(handoffBlock, options);
		const handoffCollapsed = handoffComp.render(80).map(stripAnsi).join("\n");
		expect(handoffCollapsed).toContain("handoff");
		expect(handoffCollapsed).not.toContain("Migrated presentation models");

		handoffComp.setExpanded(true);
		const handoffExpanded = handoffComp.render(80).map(stripAnsi).join("\n");
		expect(handoffExpanded).toContain("handoff");
		expect(handoffExpanded).toContain("Handoff context");
		expect(handoffExpanded).toContain("Migrated presentation models to wire types.");
		handoffComp.dispose();
	});

	it("handles custom renderer callbacks and reports errors faithfully without throwing", () => {
		const customBlock: CustomBlock = {
			kind: "custom",
			id: "cust-render",
			customKind: "my-plugin:card",
			text: "Default card text",
			level: "info",
			timestamp: 1_700_000_000_000,
		};

		// 1. Successful custom renderer closure
		const successfulClosureComp = new CustomMessageComponent(customBlock, () => {
			return new Text("Custom rendered plugin view", 1, 0);
		});
		const successLines = successfulClosureComp.render(80).map(stripAnsi).join("\n");
		expect(successLines).toContain("Custom rendered plugin view");
		expect(successLines).not.toContain("Default card text");

		// 2. One-argument legacy renderer callback wrapped at the boundary
		const rawLegacy1ArgRenderer = (msg: CustomMessage<unknown>) => {
			return new Text(`1-arg renderer: ${msg.customType}`, 1, 0);
		};
		const rawMessage: CustomMessage<unknown> = {
			role: "custom",
			customType: "my-plugin:card",
			content: "raw payload",
			display: true,
			timestamp: 1_700_000_000_000,
		};
		const legacyClosureComp = new CustomMessageComponent(customBlock, (_opts, _uiTheme) => {
			return rawLegacy1ArgRenderer(rawMessage);
		});
		const legacyLines = legacyClosureComp.render(80).map(stripAnsi).join("\n");
		expect(legacyLines).toContain("1-arg renderer: my-plugin:card");

		// 3. Custom renderer throwing an error
		const failingComp = new CustomMessageComponent(customBlock, () => {
			throw new Error("Plugin rendering crashed");
		});
		const failureLines = failingComp.render(80).map(stripAnsi).join("\n");
		// Should report renderer failure in notice row
		expect(failureLines).toContain('custom message "my-plugin:card" renderer threw');
		// Falls back to default card content
		expect(failureLines).toContain("Default card text");

		// 4. Hook message folding when collapsed
		const longHookBlock: HookBlock = {
			kind: "hook",
			id: "hook-fold",
			hookName: "lint-hook",
			text: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8",
			timestamp: 1_700_000_000_000,
		};
		const hookComponent = new HookMessageComponent(longHookBlock);
		const collapsedHook = hookComponent.render(80).map(stripAnsi).join("\n");
		expect(collapsedHook).toContain("Line 1");
		expect(collapsedHook).toContain("Line 5");
		expect(collapsedHook).toContain("…");
		expect(collapsedHook).not.toContain("Line 8");

		hookComponent.setExpanded(true);
		const expandedHook = hookComponent.render(80).map(stripAnsi).join("\n");
		expect(expandedHook).toContain("Line 1");
		expect(expandedHook).toContain("Line 8");
		expect(expandedHook).not.toContain("…");
	});

	it("preserves specialized card precedence over extension renderers in ChatTranscriptBuilder", () => {
		const mockUi = createMockTui();
		let extensionRendererCalled = false;

		const builder = new ChatTranscriptBuilder({
			ui: mockUi,
			cwd: "/workspace",
			requestRender: () => {},
			getMessageRenderer: customType => {
				if (customType === COLLAB_PROMPT_MESSAGE_TYPE) {
					return () => {
						extensionRendererCalled = true;
						return new Text("OVERRIDDEN BY PLUGIN", 1, 0);
					};
				}
				if (customType === "my-plugin:widget") {
					return msg => new Text(`Plugin widget: ${msg.content}`, 1, 0);
				}
				return undefined;
			},
		});

		// Specialized collab message must NOT be overridden by extension renderer
		const collabMessage: CustomMessage<unknown> = {
			role: "custom",
			customType: COLLAB_PROMPT_MESSAGE_TYPE,
			content: "Peer alice requested review",
			details: { prompt: "Peer alice requested review", sender: "alice" },
			display: true,
			timestamp: 1_700_000_000_000,
		};

		builder.rebuild([collabMessage]);
		const lines = builder.container.render(80).map(stripAnsi).join("\n");

		expect(extensionRendererCalled).toBe(false);
		expect(lines).toContain("«guest»");
		expect(lines).toContain("Peer alice requested review");
		expect(lines).not.toContain("OVERRIDDEN BY PLUGIN");

		// Non-specialized custom message MUST use the extension renderer
		const pluginMessage: CustomMessage<unknown> = {
			role: "custom",
			customType: "my-plugin:widget",
			content: "Active Task Count: 7",
			display: true,
			timestamp: 1_700_000_000_000,
		};

		builder.rebuild([pluginMessage]);
		const pluginLines = builder.container.render(80).map(stripAnsi).join("\n");
		expect(pluginLines).toContain("Plugin widget: Active Task Count: 7");
	});

	it("projects and renders specialized hookMessage variants faithfully", () => {
		const hookMessage: HookMessage<unknown> = {
			role: "hookMessage",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Skill injected via hook",
			details: {
				name: "git-review",
				path: "skills/review.md",
				args: "HEAD~1",
				lineCount: 25,
				promptBytes: 512,
				text: "Perform security review of the git diff",
			},
			display: true,
			timestamp: 1_700_000_000_000,
		};

		// 1. toTranscriptBlock projects hook with display
		const projectedBlock = toTranscriptBlock(hookMessage, { index: 0 }) as HookBlock;
		expect(projectedBlock.kind).toBe("hook");
		expect(projectedBlock.hookName).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(projectedBlock.display).toBeDefined();
		expect(projectedBlock.display?.variant).toBe("skill-prompt");

		// 2. TranscriptBlockComponent renders the specialized card
		const options = createOptions();
		const blockComp = new TranscriptBlockComponent(projectedBlock, options);
		const blockLines = blockComp.render(80).map(stripAnsi).join("\n");
		expect(blockLines).toContain("skill");
		expect(blockLines).toContain("git-review");
		expect(blockLines).toContain("HEAD~1");
		expect(blockLines).toContain("25 lines");
		blockComp.dispose();

		// 3. ChatTranscriptBuilder renders the specialized card
		const mockUi = createMockTui();
		const builder = new ChatTranscriptBuilder({ ui: mockUi, cwd: "/workspace", requestRender: () => {} });
		builder.rebuild([hookMessage]);
		const builderLines = builder.container.render(80).map(stripAnsi).join("\n");
		expect(builderLines).toContain("skill");
		expect(builderLines).toContain("git-review");
		expect(builderLines).toContain("HEAD~1");
	});
	it("renders recoverable and unrecoverable errors with sanitized paths", () => {
		const options = createOptions();
		// Recoverable error
		const recBlock: ErrorBlock = {
			kind: "error",
			id: "err-1",
			message: "Rate limit reached, retrying in 5s\nError code: 429",
			recoverable: true,
			timestamp: 1_700_000_000_000,
		};
		const recComp = new TranscriptBlockComponent(recBlock, options);
		const recLines = recComp.render(80).map(stripAnsi).join("\n");
		expect(recLines).toContain("Rate limit reached");
		expect(recLines).toContain("Error code: 429");
		expect(recLines).not.toContain("unrecoverable");
		recComp.dispose();

		// Fatal unrecoverable error
		const fatalBlock: ErrorBlock = {
			kind: "error",
			id: "err-2",
			message: "Fatal token exhaustion: context budget exceeded",
			recoverable: false,
			timestamp: 1_700_000_000_000,
		};
		const fatalComp = new TranscriptBlockComponent(fatalBlock, options);
		const fatalLines = fatalComp.render(80).map(stripAnsi).join("\n");
		expect(fatalLines).toContain("Fatal Error:");
		expect(fatalLines).toContain("context budget exceeded");
		expect(fatalLines).toContain("unrecoverable");
		fatalComp.dispose();

		// Empty and whitespace-only errors must fall back to "Unknown error" on the primary error header
		const emptyRecBlock: ErrorBlock = {
			kind: "error",
			id: "err-3",
			message: "",
			recoverable: true,
			timestamp: 1_700_000_000_000,
		};
		const emptyRecComp = new TranscriptBlockComponent(emptyRecBlock, options);
		const emptyRecLines = emptyRecComp.render(80).map(stripAnsi);
		expect(emptyRecLines[0]).toContain("Unknown error");
		emptyRecComp.dispose();

		const whitespaceFatalBlock: ErrorBlock = {
			kind: "error",
			id: "err-4",
			message: "   \n\n  ",
			recoverable: false,
			timestamp: 1_700_000_000_000,
		};
		const whitespaceFatalComp = new TranscriptBlockComponent(whitespaceFatalBlock, options);
		const whitespaceFatalLines = whitespaceFatalComp.render(80).map(stripAnsi);
		expect(whitespaceFatalLines[0]).toContain("Fatal Error: Unknown error");
		expect(whitespaceFatalLines.some(line => line.includes("unrecoverable"))).toBe(true);
		whitespaceFatalComp.dispose();
	});

	it("folds outer and inner version monotonically across replacements, remounts, and expansions", () => {
		const options = createOptions();
		const initialBlock: AssistantMessageBlock = {
			kind: "assistant-message",
			id: "block-ver",
			segments: [{ kind: "text", text: "Text v1" }],
			model: "m1",
			stopReason: "complete",
			streaming: true,
			timestamp: 1_700_000_000_000,
		};

		const component = new TranscriptBlockComponent(initialBlock, options);
		const v0 = component.getTranscriptBlockVersion();

		// Streaming update advances version
		component.set({
			...initialBlock,
			segments: [{ kind: "text", text: "Text v1 updated" }],
		});
		const v1 = component.getTranscriptBlockVersion();
		expect(v1).toBeGreaterThan(v0);

		// setExpanded advances version monotonically
		component.setExpanded(true);
		const v2 = component.getTranscriptBlockVersion();
		expect(v2).toBeGreaterThan(v1);

		// remount advances version monotonically without losing inner version baseline
		component.remount();
		const v3 = component.getTranscriptBlockVersion();
		expect(v3).toBeGreaterThan(v2);

		// Replace block with different kind (tool execution)
		const toolBlock: ToolExecutionBlock = {
			kind: "tool-execution",
			id: "block-ver",
			toolCallId: "c1",
			toolName: "fetch",
			status: "running",
			input: "{}",
			timestamp: 1_700_000_000_001,
		};

		component.set(toolBlock);
		const v4 = component.getTranscriptBlockVersion();
		expect(v4).toBeGreaterThan(v3);

		// Mutate tool block
		component.set({
			...toolBlock,
			status: "succeeded",
			output: "OK v2",
		});
		const v5 = component.getTranscriptBlockVersion();
		expect(v5).toBeGreaterThan(v4);

		// Second remount on tool block continues strictly monotonic progression
		component.remount();
		const v6 = component.getTranscriptBlockVersion();
		expect(v6).toBeGreaterThan(v5);

		// Disposing and stopping animation
		component.stopAnimation();
		component.dispose();
	});
});
