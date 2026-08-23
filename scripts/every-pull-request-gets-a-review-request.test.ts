/**
 * Every pull request gets its AI review requested for it.
 *
 * WHY THIS SUITE EXISTS. The review used to be requested by hand, by commenting
 * `/devin review` on the pull request. A review that has to be remembered is optional in
 * practice, and a contributor working from a fork cannot request one at all.
 * `.github/workflows/devin-review.yml` posts the request itself. Three properties make that
 * safe to run unattended, and each one is a way the workflow can be broken by an ordinary
 * edit: the trigger has to be `pull_request_target` (a `pull_request` run gets a read-only
 * token on a fork and cannot comment), that trigger must never check out the pull request's
 * code (a writable token plus contributor-authored code is the classic escalation), and the
 * request has to be idempotent (a draft fires two events seconds apart, and each duplicate
 * spends another review).
 *
 * WHAT IT CLOSES. Not only this workflow. The checkout rule is swept across every workflow
 * read from disk, so a NEW `pull_request_target` workflow that checks out the head is red
 * here rather than in an incident. The trigger, permission and idempotency assertions are
 * exact equality, so a fourth trigger type or a widened token turns this red until someone
 * records the decision.
 *
 * WHAT IT DOES NOT CATCH. Whether GitHub delivers the event, whether the reviewer answers,
 * and whether the findings are any good — none of that is observable from the repository. It
 * also does not read prose: a document claiming a maintainer must request the review by hand
 * contradicts this workflow and stays green here.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const WORKFLOWS = path.join(import.meta.dir, "..", ".github", "workflows");
const REVIEW_WORKFLOW = "devin-review.yml";

interface WorkflowStep {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
}

interface WorkflowDoc {
	on?: Record<string, { types?: unknown } | null>;
	permissions?: Record<string, string>;
	concurrency?: { group?: string; "cancel-in-progress"?: unknown };
	jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function workflowFiles(): string[] {
	return fs
		.readdirSync(WORKFLOWS)
		.filter(file => file.endsWith(".yml") || file.endsWith(".yaml"))
		.sort();
}

function parse(file: string): WorkflowDoc {
	return Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8")) as WorkflowDoc;
}

function steps(doc: WorkflowDoc): WorkflowStep[] {
	return Object.values(doc.jobs ?? {}).flatMap(job => job.steps ?? []);
}

describe("every pull request gets a review request", () => {
	it("keeps the workflow that posts the request", () => {
		expect(workflowFiles()).toContain(REVIEW_WORKFLOW);
	});

	it("triggers on the three events that make a pull request readable, and nothing else", () => {
		const doc = parse(REVIEW_WORKFLOW);
		const triggers = Object.keys(doc.on ?? {});

		// `pull_request` is not an alternative here: on a fork it hands the run a read-only
		// token, so the request cannot be posted at all.
		expect(triggers).toEqual(["pull_request_target"]);
		expect(doc.on?.pull_request_target?.types).toEqual(["opened", "reopened", "ready_for_review"]);
	});

	it("asks for exactly the token scope it uses", () => {
		expect(parse(REVIEW_WORKFLOW).permissions).toEqual({ contents: "read", "pull-requests": "write" });
	});

	it("serializes per pull request without cancelling the run that writes the marker", () => {
		const concurrency = parse(REVIEW_WORKFLOW).concurrency;

		expect(concurrency?.group).toContain("github.event.pull_request.number");
		// A cancelled first run drops the request, and the second run then skips because the
		// marker it looks for was never written.
		expect(concurrency?.["cancel-in-progress"]).toBe(false);
	});

	it("requests once per pull request, keyed by a marker it also writes", () => {
		const script = steps(parse(REVIEW_WORKFLOW))
			.map(step => step.run ?? "")
			.join("\n");
		const markers = [...script.matchAll(/marker='([^']+)'/g)].map(match => match[1]);

		// One definition, so the lookup and the comment cannot drift apart.
		expect(markers).toEqual(["<!-- devin-review-requested -->"]);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: `${marker}` is a shell expansion inside the workflow's own run step, quoted here as the fixture.
		expect(script).toContain("${marker}");
		expect(script).toContain("/devin review");
		// A draft is requested at `ready_for_review` instead, not twice.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: `${DRAFT}` is a shell variable in the workflow's run step, not a missed template literal.
		expect(script).toContain("${DRAFT}");
	});

	it("never checks out pull request code in a pull_request_target workflow", () => {
		const offenders: string[] = [];
		for (const file of workflowFiles()) {
			const doc = parse(file);
			if (!Object.hasOwn(doc.on ?? {}, "pull_request_target")) continue;
			for (const step of steps(doc)) {
				const usesCheckout = (step.uses ?? "").startsWith("actions/checkout");
				const clones = /\bgh\s+pr\s+checkout\b|\bgit\s+(?:fetch|checkout)\b/.test(step.run ?? "");
				if (usesCheckout || clones) offenders.push(`${file}: ${step.name ?? step.uses ?? "run step"}`);
			}
		}

		expect(
			offenders,
			"a pull_request_target run holds a writable token. Checking out the pull request's code " +
				"puts that token within reach of a contributor's commits, so these workflows read the " +
				"event payload and call the API instead.",
		).toEqual([]);
	});
});
