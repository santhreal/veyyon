/**
 * WHY: a task graded on what the agent states must fail a statement that gives the right value
 * beside the decoy the task planted, or a run that cannot choose passes by listing every candidate.
 * Three tasks passed such hedges: the warranty comparison took an answer naming all three products;
 * the category total took the posted total next to the totals that count pending charges, leave the
 * refund in or leave savings out; the invoice reply took the corrected amount and date next to the
 * ones the correction replaced.
 *
 * Each case grades the state a trial recorded against a hedged answer built from what the trial
 * served or planted, and asserts that the check guarding the decoy is the one that fails. The sweep
 * proves the plain right answer still passes every check. A right answer names the year, which reads
 * as that many dollars, so a decoy that is exactly that amount is not held against it; one case per
 * check pins that. The bank's ledger prints spend as `-$312.40`, so the category total copied with
 * that sign is the right total, and a miscount copied with it is still a miscount.
 *
 * Not caught: a hedge over a value the task did not plant as a decoy, and a decoy written in words
 * rather than digits.
 */
import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import type { KitTask, KitTrial } from "../../../engine/kit/catalog";
import type { Grade } from "../../../engine/kit/checks";
import { FormClient } from "../../../engine/kit/form-client";
import { trialSeed } from "../../../engine/kit/suite";
import { usd } from "../../../suites/browser/apps/bank/data";
import { BANK_TASKS } from "../../../suites/browser/apps/bank/tasks";
import { fullDate } from "../../../suites/browser/apps/mail/data";
import { MAIL_TASKS } from "../../../suites/browser/apps/mail/tasks";
import { SHOP_TASKS } from "../../../suites/browser/apps/shop/tasks";
import { taskNamed } from "./site-trial";

function failedChecks(grade: Grade): string[] {
	return grade.outcomes.filter(outcome => !outcome.passed).map(outcome => outcome.id);
}

/** Start a trial, run `during` against it, stop it, and return what it recorded as the grader reads it. */
async function recorded<T>(
	task: KitTask,
	repeat: number,
	during: (trial: KitTrial<unknown>) => Promise<T>,
): Promise<{ state: unknown; result: T }> {
	await using dir = await TempDir.create("@evals-hedge-");
	const trial = await task.start({
		seed: trialSeed({ task: task.id, repeat }),
		workspace: dir.path(),
		trialDir: dir.path(),
	});
	const outcome = await during(trial).then(
		value => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
	// Stopped whether or not `during` threw, so a failing case leaves no server behind.
	const state: unknown = JSON.parse(JSON.stringify(await trial.finish()));
	if (!outcome.ok) throw outcome.error;
	return { state, result: outcome.value };
}

/** A field of the state's `expected` block, checked to hold the type asked for. */
function expectedField(state: unknown, key: string, type: "number"): number;
function expectedField(state: unknown, key: string, type: "string"): string;
function expectedField(state: unknown, key: string, type: "number" | "string"): number | string {
	const expected = typeof state === "object" && state !== null && "expected" in state ? state.expected : undefined;
	const value: unknown = typeof expected === "object" && expected !== null ? Reflect.get(expected, key) : undefined;
	if (typeof value !== type || (typeof value !== "number" && typeof value !== "string")) {
		throw new Error(`the state holds no ${type} at expected.${key}`);
	}
	return value;
}

/** The state with `patch` laid over its `expected` block, for a decoy value no seed is likely to draw. */
function withExpected(state: unknown, patch: Readonly<Record<string, number>>): unknown {
	if (typeof state !== "object" || state === null || !("expected" in state))
		throw new Error("the state holds no expected block");
	if (typeof state.expected !== "object" || state.expected === null)
		throw new Error("the state holds no expected block");
	return { ...state, expected: { ...state.expected, ...patch } };
}

describe("shop-warranty-answer", () => {
	const task = taskNamed(SHOP_TASKS, "shop-warranty-answer");

	/** The three products the instruction names, with the SKU and the warranty their pages show. */
	async function products(trial: KitTrial<unknown>): Promise<{ sku: string; years: number }[]> {
		const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(trial.instruction)?.[0] ?? "";
		const names = /longest warranty: (.+)\?$/m.exec(trial.instruction)?.[1]?.split("; ") ?? [];
		if (!origin || names.length !== 3)
			throw new Error(`the instruction names no site or not three products: ${trial.instruction}`);
		const client = new FormClient(origin);
		return Promise.all(
			names.map(async name => {
				const results = await client.get(`/search?q=${encodeURIComponent(name)}`);
				const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const sku = new RegExp(`href="/product/(SK-[A-Z0-9]+)"><strong>${escaped}</strong>`).exec(
					results.body,
				)?.[1];
				if (!sku) throw new Error(`no search result is ${name}`);
				const page = await client.get(`/product/${sku}`);
				const years = Number(/Covered by a (\d+)-year limited warranty/.exec(page.body)?.[1]);
				if (!Number.isInteger(years)) throw new Error(`${sku} shows no warranty`);
				return { sku, years };
			}),
		);
	}

	for (const repeat of [0, 1, 2, 3]) {
		it(`fails an answer that names all three products, seed of repeat ${repeat}`, async () => {
			const { state, result } = await recorded(task, repeat, products);
			const answer = result.map(product => `${product.sku}: ${product.years} years`).join("; ");
			expect(failedChecks(task.grade(state, answer))).toEqual(["answer-sku"]);
		});
	}
});

describe("bank-category-spend", () => {
	const task = taskNamed(BANK_TASKS, "bank-category-spend");

	/** The checks that fail on the solved answer with `slipped` cents stated after it. */
	function hedged(state: unknown, answer: string, slipped: number): string[] {
		return failedChecks(task.grade(state, `${answer} Or ${usd(slipped)}.`));
	}

	for (const repeat of [0, 1]) {
		it(`fails the total stated beside one counting pending charges or leaving the refund in, seed of repeat ${repeat}`, async () => {
			const { state, result: answer } = await recorded(task, repeat, trial => trial.solve());
			const total = expectedField(state, "totalCents", "number");
			expect(failedChecks(task.grade(state, answer))).toEqual([]);
			expect(hedged(state, answer, total + expectedField(state, "pendingCents", "number"))).toEqual([
				"answer-total",
			]);
			expect(hedged(state, answer, total + expectedField(state, "refundCents", "number"))).toEqual(["answer-total"]);
		});

		it(`fails the total stated beside the one over checking alone, seed of repeat ${repeat}`, async () => {
			const { state, result: answer } = await recorded(task, repeat, trial => trial.solve());
			expect(hedged(state, answer, expectedField(state, "checkingOnlyCents", "number"))).toEqual(["answer-total"]);
		});
	}

	it("passes the right answer, which names the year, when a miscount is that many whole dollars", async () => {
		const { state, result: answer } = await recorded(task, 0, trial => trial.solve());
		const yearCents = Number(expectedField(state, "month", "string").slice(0, 4)) * 100;
		expect(answer).toContain(String(yearCents / 100));
		const collided = withExpected(state, { pendingCents: yearCents - expectedField(state, "totalCents", "number") });
		expect(failedChecks(task.grade(collided, answer))).toEqual([]);
	});

	it("passes the right total copied with the ledger's minus sign, and fails a miscount copied the same way", async () => {
		const { state, result: answer } = await recorded(task, 0, trial => trial.solve());
		const total = expectedField(state, "totalCents", "number");
		// The activity page prints spend as `-$312.40`.
		const copied = answer.replace(usd(total), usd(-total));
		expect(copied).toContain(`-${usd(total)}`);
		expect(failedChecks(task.grade(state, copied))).toEqual([]);
		const pending = total + expectedField(state, "pendingCents", "number");
		expect(failedChecks(task.grade(state, `${copied} Or ${usd(-pending)}.`))).toEqual(["answer-total"]);
	});
});

describe("mail-reply-with-invoice-total", () => {
	const task = taskNamed(MAIL_TASKS, "mail-reply-with-invoice-total");

	/** The state with `line` written above the one sent message's body, as a run that typed it records. */
	function withLine(state: unknown, line: string): unknown {
		if (typeof state !== "object" || state === null || !("sent" in state) || !Array.isArray(state.sent)) {
			throw new Error("the state holds no sent messages");
		}
		const [mail, ...rest]: unknown[] = state.sent;
		if (typeof mail !== "object" || mail === null || !("body" in mail) || typeof mail.body !== "string") {
			throw new Error("the state holds no sent message");
		}
		return { ...state, sent: [{ ...mail, body: `${line}\n${mail.body}` }, ...rest] };
	}

	for (const repeat of [0, 1]) {
		it(`fails a reply that also states a figure the correction replaced, seed of repeat ${repeat}`, async () => {
			const { state } = await recorded(task, repeat, trial => trial.solve());
			expect(failedChecks(task.grade(state, ""))).toEqual([]);
			const amount = `$${(expectedField(state, "staleAmountCents", "number") / 100).toFixed(2)}`;
			const date = fullDate(expectedField(state, "staleDueDate", "string"));
			expect(failedChecks(task.grade(withLine(state, `The original email said ${amount}.`), ""))).toEqual([
				"corrected-amount",
			]);
			expect(failedChecks(task.grade(withLine(state, `The original email said it was due ${date}.`), ""))).toEqual([
				"corrected-due-date",
			]);
		});
	}

	it("passes the right reply, which names the year, when the replaced amount is that many whole dollars", async () => {
		const { state } = await recorded(task, 0, trial => trial.solve());
		const yearCents = Number(expectedField(state, "dueDate", "string").slice(0, 4)) * 100;
		expect(failedChecks(task.grade(withExpected(state, { staleAmountCents: yearCents }), ""))).toEqual([]);
	});
});
