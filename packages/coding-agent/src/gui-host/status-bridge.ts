/**
 * The facts the terminal's status line states about a session beyond its
 * transcript, stated to a window: the branch and pull request of the
 * session's checkout, how long the agent has worked and how fast it replies,
 * the login serving the session and that login's subscription quota.
 *
 * Each value comes from the owner the terminal reads: the pace, the serving
 * login and the quota from `StatusPresentationProducer`, the checkout from
 * `utils/git`. A section is written only when it differs from the last one
 * written for that session, so an idle re-statement that moved nothing costs
 * no frame; opening a session states every section once regardless.
 *
 * `Pace` is written at the turn's edges and at most once per
 * `PACE_INTERVAL_MS` while a reply streams. It holds the finished working
 * time and the epoch the running window opened, so the window adds the
 * running window at render and no frame is owed per second.
 */
import type * as net from "node:net";
import { errorMessage, logger } from "@veyyon/utils";
import { scopedTimeoutSignal, withScopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import type { StatusProviderUsage } from "@veyyon/wire/presentation";
import { StatusPresentationProducer } from "../presentation/status-producer";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-types";
import * as git from "../utils/git";
import { writeFrame } from "./frames";
import type { CheckoutView, PullRequestView, QuotaView, SnapshotSection } from "./wire";

/** The shortest gap between two `Pace` frames while a reply streams. */
export const PACE_INTERVAL_MS = 250;

/** How long a quota reading stands before a re-statement fetches again, as in the terminal. */
const QUOTA_REFRESH_MS = 5 * 60_000;

/** The longest one quota fetch may run, as in the terminal. */
const QUOTA_FETCH_TIMEOUT_MS = 2_000;

interface QuotaReading {
	/** `StatusPresentationProducer.getUsageContextKey`: the provider and login the reading is for. */
	key: string;
	fetchedAt: number;
	quota: QuotaView | null;
}

/**
 * The quota windows as the window receives them. The provider reports how far
 * off each reset is, rounded to the minute for the five-hour window and to the
 * hour for the seven-day one; the epoch is that offset from the moment the
 * reading was taken, so the window draws it at the terminal's granularity.
 */
function quotaView(usage: StatusProviderUsage | null, readAt: number): QuotaView | null {
	if (!usage) return null;
	const { fiveHour, sevenDay } = usage;
	return {
		tier: usage.tier ?? null,
		five_hour: fiveHour
			? {
					used_permille: Math.round(fiveHour.percent * 10),
					resets_at_ms: fiveHour.resetMinutes === undefined ? null : readAt + fiveHour.resetMinutes * 60_000,
				}
			: null,
		seven_day: sevenDay
			? {
					used_permille: Math.round(sevenDay.percent * 10),
					resets_at_ms: sevenDay.resetHours === undefined ? null : readAt + sevenDay.resetHours * 3_600_000,
				}
			: null,
	};
}

/** One window's status-line sections, following the live session it is attached to. */
export class DesktopStatusBridge {
	readonly #socket: net.Socket;
	#producer: StatusPresentationProducer | undefined;
	#unsubscribe: (() => void) | undefined;
	#paceTimer: NodeJS.Timeout | undefined;
	#lastPaceAt = 0;
	/** The last section written, keyed by kind and session. */
	readonly #written = new Map<string, string>();
	/** The pull request per checked-out branch, looked up once as the terminal does. */
	#pullRequest: { key: string; value: PullRequestView | null } | undefined;
	/** Orders overlapping checkout reads, so an older one never lands over a newer one. */
	#checkoutRun = 0;
	#quota: QuotaReading | undefined;
	#quotaInFlight: string | undefined;
	#disposed = false;

	constructor(socket: net.Socket) {
		this.#socket = socket;
	}

	/** Follow a live session's turn edges and reply rate until `detach`, stating its pace now. */
	attach(session: AgentSession): void {
		this.detach();
		this.#producer = new StatusPresentationProducer(session);
		this.#unsubscribe = session.subscribe(event => this.#onEvent(event));
		this.#publishPace();
	}

	detach(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#producer = undefined;
		clearTimeout(this.#paceTimer);
		this.#paceTimer = undefined;
	}

	dispose(): void {
		this.detach();
		this.#disposed = true;
	}

	/**
	 * State every section of a session the window just opened. A session with
	 * no live agent has worked no time in this process and has no model to
	 * serve, so only its checkout is stated.
	 */
	publishOpened(session: string, cwd: string): void {
		for (const kind of ["Checkout", "Pace", "ServingAccount", "Quota"]) this.#written.delete(`${kind}:${session}`);
		void this.#publishCheckout(session, cwd);
		if (this.#producer?.session.sessionId !== session) return;
		this.#publishPace();
		this.publishAccount();
	}

	/**
	 * State the login serving the live session and its quota. Called at idle
	 * and wherever the model or the stored credentials change, which is what
	 * moves either.
	 */
	publishAccount(): void {
		const producer = this.#producer;
		if (!producer) return;
		const session = producer.session;
		const provider = session.state?.model?.provider ?? session.model?.provider;
		const serving = producer.getServingAccount(session);
		this.#write(`ServingAccount:${session.sessionId}`, {
			ServingAccount: {
				session: session.sessionId,
				account:
					serving && provider
						? {
								provider,
								label: serving.label,
								logins: serving.storedCount,
								predicted: serving.isPrediction,
							}
						: null,
			},
		});
		void this.#publishQuota(producer);
	}

	#onEvent(event: AgentSessionEvent): void {
		const producer = this.#producer;
		if (!producer) return;
		switch (event.type) {
			case "agent_start":
				producer.markActivityStart();
				this.#publishPace();
				break;
			case "message_update":
				if (event.message.role === "assistant") this.#schedulePace();
				break;
			case "agent_end":
				producer.markActivityEnd();
				this.#publishPace();
				this.publishAccount();
				void this.#publishCheckout(producer.session.sessionId, producer.session.sessionManager.getCwd());
				break;
			default:
				break;
		}
	}

	#schedulePace(): void {
		if (this.#paceTimer) return;
		const wait = Math.max(0, this.#lastPaceAt + PACE_INTERVAL_MS - Date.now());
		this.#paceTimer = setTimeout(() => this.#publishPace(), wait);
	}

	#publishPace(): void {
		clearTimeout(this.#paceTimer);
		this.#paceTimer = undefined;
		const producer = this.#producer;
		if (!producer) return;
		const session = producer.session;
		const { workedMs, workingSince } = producer.getWorkedTime();
		const rate = producer.getTokensPerSecond(session);
		// The interval runs from the last read, not the last frame, so a
		// stream whose rate holds still reads it at most once per interval.
		this.#lastPaceAt = Date.now();
		this.#write(`Pace:${session.sessionId}`, {
			Pace: {
				session: session.sessionId,
				pace: {
					worked_ms: workedMs,
					working_since_ms: workingSince,
					tokens_per_second_tenths: rate === null ? null : Math.round(rate * 10),
				},
			},
		});
	}

	async #publishCheckout(session: string, cwd: string): Promise<void> {
		const run = ++this.#checkoutRun;
		let checkout: CheckoutView | null;
		try {
			checkout = await this.#readCheckout(cwd);
		} catch (error) {
			logger.debug("GUI host: checkout unreadable", { cwd, error: errorMessage(error) });
			return;
		}
		if (run !== this.#checkoutRun) return;
		this.#write(`Checkout:${session}`, { Checkout: { session, checkout } });
	}

	/**
	 * The branch as the terminal labels it, whether the tree is dirty, and the
	 * pull request `gh` reports for the branch. The default branch is never
	 * looked up, and a branch's answer stands until the branch changes.
	 */
	async #readCheckout(cwd: string): Promise<CheckoutView | null> {
		const head = git.head.resolveSync(cwd);
		if (!head) return null;
		const operation = git.head.operation(head);
		const status = await git.status.summary(cwd);
		const lookup = git.head.branchForLookup(head, operation);
		const key = `${head.headPath}\0${lookup}`;
		if (lookup && this.#pullRequest?.key !== key) {
			const defaultBranch = (await git.branch.default(cwd)) ?? "main";
			let value: PullRequestView | null = null;
			if (lookup !== defaultBranch) {
				try {
					const result = await withScopedTimeoutSignal(git.GIT_COMMAND_TIMEOUT_MS, signal =>
						git.github.run(cwd, ["pr", "view", "--json", "number,url"], signal),
					);
					const parsed: unknown = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
					if (
						parsed &&
						typeof parsed === "object" &&
						"number" in parsed &&
						typeof parsed.number === "number" &&
						"url" in parsed &&
						typeof parsed.url === "string"
					) {
						value = { number: parsed.number, url: parsed.url };
					}
				} catch (error) {
					logger.debug("GUI host: pull request lookup failed", { cwd, error: errorMessage(error) });
				}
			}
			this.#pullRequest = { key, value };
		}
		return {
			branch: git.head.label(head, operation),
			dirty: git.status.isDirty(status),
			pull_request: lookup ? (this.#pullRequest?.value ?? null) : null,
		};
	}

	/**
	 * Fetch the quota of the login serving the session, at most once per
	 * `QUOTA_REFRESH_MS` for one login. A fetch that fails leaves the last
	 * reading standing, as the terminal does.
	 */
	async #publishQuota(producer: StatusPresentationProducer): Promise<void> {
		const session = producer.session.sessionId;
		const key = producer.getUsageContextKey();
		const reading = this.#quota;
		if (reading?.key === key && Date.now() - reading.fetchedAt < QUOTA_REFRESH_MS) {
			this.#write(`Quota:${session}`, { Quota: { session, quota: reading.quota } });
			return;
		}
		if (this.#quotaInFlight === key) return;
		this.#quotaInFlight = key;
		const { signal, cancel } = scopedTimeoutSignal(QUOTA_FETCH_TIMEOUT_MS);
		let usage: StatusProviderUsage | null;
		try {
			usage = await producer.fetchUsage(signal);
		} catch (error) {
			logger.debug("GUI host: quota unavailable", { error: errorMessage(error) });
			return;
		} finally {
			cancel();
			if (this.#quotaInFlight === key) this.#quotaInFlight = undefined;
		}
		const readAt = Date.now();
		this.#quota = { key, fetchedAt: readAt, quota: quotaView(usage, readAt) };
		if (this.#producer !== producer || producer.getUsageContextKey() !== key) return;
		this.#write(`Quota:${producer.session.sessionId}`, {
			Quota: { session: producer.session.sessionId, quota: this.#quota.quota },
		});
	}

	#write(key: string, section: SnapshotSection): boolean {
		if (this.#disposed || this.#socket.destroyed) return false;
		const signature = JSON.stringify(section);
		if (this.#written.get(key) === signature) return false;
		this.#written.set(key, signature);
		writeFrame(this.#socket, { Snapshot: section });
		return true;
	}
}
