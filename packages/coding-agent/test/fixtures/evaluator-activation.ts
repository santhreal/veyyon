import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@veyyon/utils";
import { Settings } from "../../src/config/settings";
import type { EvalLanguage } from "../../src/eval/types";
import type { ToolSession } from "../../src/tools";
import { EVAL_LANGUAGE_ORDER, type EvalLanguageToken, EvalTool } from "../../src/tools/shell/eval";
import { evalBackendLoaders } from "../../src/tools/shell/manifest";

const backends: Record<EvalLanguageToken, { runtime: EvalLanguage; directory: string }> = {
	py: { runtime: "python", directory: "py" },
	js: { runtime: "js", directory: "js" },
	rb: { runtime: "ruby", directory: "rb" },
	jl: { runtime: "julia", directory: "jl" },
};
assert.deepEqual(Object.keys(backends).sort(), [...EVAL_LANGUAGE_ORDER].sort());
assert.deepEqual(
	Object.values(backends)
		.map(backend => backend.runtime)
		.sort(),
	Object.keys(evalBackendLoaders).sort(),
);
const language = EVAL_LANGUAGE_ORDER.find(token => token === process.argv[2]);
assert(language, "An activation case is required for each language token");
const loaded = () =>
	EVAL_LANGUAGE_ORDER.filter(token =>
		Object.keys(require.cache).some(file =>
			path.normalize(file).endsWith(path.join("eval", backends[token].directory, "executor.ts")),
		),
	);
const disabledSettings = Object.fromEntries(EVAL_LANGUAGE_ORDER.map(token => [`eval.${token}`, false]));
const cwd = os.tmpdir();
const session: ToolSession = {
	cwd,
	hasUI: false,
	settings: Settings.isolated(disabledSettings),
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	getSessionId: () => "activation-session",
};
try {
	const disabled = await EvalTool.create(session);
	assert.deepEqual(loaded(), [], "tool construction loaded evaluator implementations");
	await assert.rejects(disabled.execute("disabled", { language, code: "0" }), /backend is disabled/);
	assert.deepEqual(loaded(), [], "disabled execution loaded evaluator implementations");
	const enabled = await EvalTool.create({
		...session,
		settings: Settings.isolated({
			...disabledSettings,
			[`eval.${language}`]: true,
			...(language === "js"
				? {}
				: {
						[`${backends[language].runtime}.interpreter`]: path.join(cwd, "missing-interpreter"),
					}),
		}),
	});
	// Metadata is available without importing the execution backend.
	void enabled.description;
	void enabled.parameters;
	void enabled.examples;
	assert.deepEqual(loaded(), [], "enabled tool metadata loaded evaluator implementations");
	const started = performance.now();
	if (language === "js") {
		const result = await enabled.execute("enabled", { language, code: "display({ answer: 42 });" });
		assert.deepEqual(result.details?.jsonOutputs, [{ answer: 42 }]);
	} else {
		await assert.rejects(enabled.execute("enabled", { language, code: "0" }), /backend is unavailable/);
	}
	assert.deepEqual(loaded(), [language], "execution loaded a backend other than the requested one");
	process.stdout.write(
		`${JSON.stringify({ language, loaded: loaded(), firstActionMs: performance.now() - started })}\n`,
	);
} finally {
	await postmortem.cleanup();
}
