import { makeBench } from "@veyyon/utils/bench-harness";
import { MUTATION_TOOL_NAMES, VerificationEvidenceLedger } from "../src/session/verification-evidence-ledger";

const MUTATIONS_PER_TURN = 32;
const ITERATIONS = 1_000;
const WARMUP = 100;

function mutationDetails(toolName: (typeof MUTATION_TOOL_NAMES)[number], index: number): Record<string, unknown> {
	const fileName = `file-${index}.ts`;
	switch (toolName) {
		case "edit":
			return { path: `/repo/src/${fileName}` };
		case "write":
			return { resolvedPath: `/repo/src/${fileName}` };
		case "ast_edit":
			return {
				applied: true,
				totalReplacements: 1,
				files: [`src/${fileName}`],
				cwd: "/repo",
			};
		default: {
			const unsupported: never = toolName;
			throw new Error(`Missing benchmark fixture for ${unsupported}`);
		}
	}
}

function settleMutationTurn(enabled: boolean): string | undefined {
	const ledger = new VerificationEvidenceLedger();
	for (let index = 0; index < MUTATIONS_PER_TURN; index++) {
		const toolName = MUTATION_TOOL_NAMES[index % MUTATION_TOOL_NAMES.length]!;
		ledger.recordToolEnd({
			toolCallId: `mutation-${index}`,
			toolName,
			result: { content: [], details: mutationDetails(toolName, index) },
		});
	}
	return enabled ? ledger.takeCodeReviewReminder() : undefined;
}

if (settleMutationTurn(false) !== undefined) throw new Error("disabled arm produced a reminder");
if (!settleMutationTurn(true)?.includes("… 8 more code files")) {
	throw new Error("enabled arm did not produce the bounded review reminder");
}

const bench = makeBench(ITERATIONS, { warmup: WARMUP });
const disabledMs = bench("disabled [baseline-compatible mutation ledger]", () => {
	settleMutationTurn(false);
});
const enabledMs = bench("enabled  [bounded review selection + render]", () => {
	settleMutationTurn(true);
});
const addedMicros = ((enabledMs - disabledMs) * 1_000) / ITERATIONS;

process.stdout.write(
	`\nPost-edit code review: ${MUTATIONS_PER_TURN} mutations/turn, ${ITERATIONS} iterations; ` +
		`${addedMicros.toFixed(2)}µs added per enabled settle.\n`,
);
