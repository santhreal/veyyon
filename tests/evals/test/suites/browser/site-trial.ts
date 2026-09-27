/**
 * One trial of a browser-suite task, and requests to its sites that show what they answer rather
 * than following it: the status, the `location` a redirect names, and the session cookie. Tests that
 * check where a redirect points or what a malformed request answers use `send`, where `FormClient`
 * would follow the redirect off the site. `signInToBank` signs in as the bank's pages do: the
 * password, then the newest code the phone receives.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { TempDir } from "@veyyon/utils";
import type { KitTask, KitTrial } from "../../../engine/kit/catalog";
import { trialSeed } from "../../../engine/kit/suite";

export function taskNamed(tasks: readonly KitTask[], id: string): KitTask {
	const task = tasks.find(entry => entry.id === id);
	if (!task) throw new Error(`no task ${id}`);
	return task;
}

/** Start the task's trial of repeat 0, run `body` against it, and stop it whether or not `body` threw. */
export async function withTrial(task: KitTask, body: (trial: KitTrial<unknown>) => Promise<void>): Promise<void> {
	await using dir = await TempDir.create("@evals-site-trial-");
	const trial = await task.start({
		seed: trialSeed({ task: task.id, repeat: 0 }),
		workspace: dir.path(),
		trialDir: dir.path(),
	});
	try {
		await body(trial);
	} finally {
		await trial.finish();
	}
}

export interface RawResponse {
	readonly status: number;
	/** The `location` header, empty when there is none. */
	readonly location: string;
	/** The session's `cookie` header: the one sent, updated by what the response set. */
	readonly cookie: string;
	readonly body: string;
}

export interface RawRequest {
	readonly method?: string;
	/** Sent urlencoded, as a form posts; a string is sent as written, for a body no browser would encode. */
	readonly form?: Readonly<Record<string, string>> | string;
	/** Sent as JSON; ignored when `form` is given. */
	readonly json?: unknown;
	readonly cookie?: string;
}

export async function send(origin: string, target: string, request: RawRequest = {}): Promise<RawResponse> {
	const headers: Record<string, string> = {};
	if (request.cookie) headers.cookie = request.cookie;
	let body: string | undefined;
	if (request.form !== undefined) {
		headers["content-type"] = "application/x-www-form-urlencoded";
		body = typeof request.form === "string" ? request.form : new URLSearchParams(request.form).toString();
	} else if (request.json !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(request.json);
	}
	const response = await fetch(`${origin}${target}`, {
		method: request.method ?? (body === undefined ? "GET" : "POST"),
		headers,
		body,
		redirect: "manual",
	});
	const jar = new Map<string, string>();
	const pairs = [
		...(request.cookie ?? "").split(";"),
		...response.headers.getSetCookie().map(line => line.split(";")[0] ?? ""),
	];
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
	return {
		status: response.status,
		location: response.headers.get("location") ?? "",
		cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
		body: await response.text(),
	};
}

/** The trial's site origin, and the account's email or username and password when the instruction gives them. */
export function access(trial: KitTrial<unknown>): { origin: string; user: string; password: string } {
	const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(trial.instruction)?.[0];
	if (!origin) throw new Error(`the instruction names no site: ${trial.instruction}`);
	const account = /(?:email|username) (\S+) and password (\S+)\.$/m.exec(trial.instruction);
	return { origin, user: account?.[1] ?? "", password: account?.[2] ?? "" };
}

/** The newest sign-in code the phone holds, and its message id. */
async function newestCode(phone: string): Promise<{ id: number; code: string }> {
	const thread = await send(phone, "/api/conversations/northwind-bank");
	let newest = { id: 0, code: "" };
	for (const [, id, code] of thread.body.matchAll(
		/"id":(\d+),"body":"Northwind Bank: (\d{6}) is your sign-in code/g,
	)) {
		if (Number(id) > newest.id) newest = { id: Number(id), code: code ?? "" };
	}
	return newest;
}

/** Sign in to a bank trial with `next` as the page to land on; the answer is the verification's response. */
export async function signInToBank(trial: KitTrial<unknown>, next: string): Promise<RawResponse> {
	const { origin, user, password } = access(trial);
	const phone = /Messages app is at (http:\/\/127\.0\.0\.1:\d+)/.exec(trial.instruction)?.[1];
	if (!phone) throw new Error(`the instruction names no phone: ${trial.instruction}`);
	const seen = (await newestCode(phone)).id;
	const signin = await send(origin, "/signin", { form: { username: user, password, next } });
	if (signin.location !== "/signin/verify")
		throw new Error(`the password was refused: ${signin.status} ${signin.location}`);
	const deadline = Date.now() + 15_000;
	for (;;) {
		const fresh = await newestCode(phone);
		if (fresh.id > seen) return send(origin, "/signin/verify", { form: { code: fresh.code }, cookie: signin.cookie });
		if (Date.now() > deadline) throw new Error("no sign-in code reached the phone");
		await sleep(200);
	}
}
