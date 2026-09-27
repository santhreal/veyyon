/**
 * Northwind Bank's pages and handlers over one {@link BankWorld}, and the phone its codes go to.
 *
 * What makes it hard to operate is ordinary online banking: a second factor whose code reaches
 * another origin a moment after it is sent and dies when a new one is requested, six one-digit code
 * boxes, a statement split over pages behind filters (with a CSV export), a payee form and alert
 * switches inside open shadow roots, the browser's own confirm dialog before money moves, and
 * pending transactions that separate the available balance from the current one.
 */

import { Seeded } from "../../../../engine/kit/seeded";
import {
	escapeHtml,
	formFields,
	type HostedSite,
	hostSite,
	html,
	json,
	jsonBody,
	redirect,
	type SiteRequest,
	type SiteResponse,
	text,
} from "../../../../engine/kit/web-host";
import { page } from "../../ui";
import {
	ACCOUNT_IDS,
	type AccountId,
	type AlertSetting,
	accountLabel,
	accountOf,
	availableBalance,
	BANK_SENDER,
	type BankWorld,
	type Bill,
	codeText,
	currentBalance,
	DISPUTE_REASONS,
	findPayee,
	isAccountId,
	KIND_LABELS,
	last4,
	NEW_PAYEE_CATEGORY,
	newPayeeId,
	type Payee,
	parseAmount,
	routingValid,
	shortDate,
	type Transaction,
	usd,
} from "./data";
import { PhoneInbox, startPhoneSite } from "./phone";
import { ALERT_SCRIPT, confirmScript, OTP_SCRIPT, PAYEE_SCRIPT } from "./scripts";

export interface Payment {
	/** The confirmation number. */
	readonly id: string;
	readonly payeeId: string;
	readonly from: AccountId;
	readonly amountCents: number;
	readonly memo: string;
	/** The scheduled bill it settled, when its payee and amount match one that was unpaid. */
	readonly billId: string | null;
}

export interface Transfer {
	readonly id: string;
	readonly from: AccountId;
	readonly to: AccountId;
	readonly amountCents: number;
	readonly memo: string;
}

export interface Dispute {
	readonly id: string;
	readonly transactionId: string;
	readonly reason: string;
	readonly details: string;
}

export interface BankSnapshot {
	readonly today: string;
	readonly payees: readonly Payee[];
	/** In the order they were sent. */
	readonly payments: readonly Payment[];
	readonly transfers: readonly Transfer[];
	readonly disputes: readonly Dispute[];
	readonly alerts: readonly AlertSetting[];
	readonly initialAlerts: readonly AlertSetting[];
	readonly bills: readonly Bill[];
	/** Checking's available balance when the trial started, then after every payment and transfer. */
	readonly checkingAvailable: readonly number[];
	readonly signIns: number;
	readonly failedSignins: number;
	readonly failedCodes: number;
	readonly codesSent: number;
}

export interface BankSite extends HostedSite {
	/** The phone's Messages app, a second origin. */
	readonly phoneOrigin: string;
	finish(): Promise<BankSnapshot>;
}

const SESSION_COOKIE = "nwb_sid";
const PAGE_SIZE = 20;
/** A code reaches the phone this long after the bank sends it. */
const CODE_DELAY_MS = 2000;
const CODE_TTL_MS = 5 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

const STYLE = `
header.app .today{margin-left:auto;color:#cbd5e1;font-size:13px}
.narrow{max-width:440px}
.amount{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.credit{color:#047857}
.pending{color:#b45309;font-style:italic}
.otp{display:flex;gap:8px;margin:12px 0}
.otp input{width:44px;height:50px;text-align:center;font-size:22px}
.filters label{margin:0}
.pager{justify-content:space-between}
.balances th{font-weight:400;color:#4b5563}
.balances td{font-size:18px;font-weight:600}
form.stack{max-width:460px}
form.stack input,form.stack select,form.stack textarea{width:100%}
`;

interface Session {
	stage: "out" | "code" | "in";
	/** Where a completed sign-in lands. */
	next: string;
}

interface IssuedCode {
	readonly session: string;
	readonly code: string;
	readonly issuedAt: number;
	live: boolean;
	attempts: number;
}

interface ActivityFilter {
	readonly account: string;
	readonly from: string;
	readonly to: string;
	readonly category: string;
	readonly status: string;
	readonly q: string;
}

function readFilter(url: URL): ActivityFilter {
	const param = (name: string) => (url.searchParams.get(name) ?? "").trim();
	const date = (name: string) => (/^\d{4}-\d{2}-\d{2}$/.test(param(name)) ? param(name) : "");
	const status = param("status");
	return {
		account: isAccountId(param("account")) ? param("account") : "",
		from: date("from"),
		to: date("to"),
		category: param("category"),
		status: status === "posted" || status === "pending" ? status : "",
		q: param("q"),
	};
}

function filterQuery(filter: ActivityFilter): string {
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(filter)) if (value) params.set(name, value);
	return params.toString();
}

/** A path on this site to land on after sign-in; anything else, including `//host`, lands on `/`. */
function localPath(value: string | null | undefined): string {
	return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function signed(cents: number): string {
	return `${cents > 0 ? "+" : ""}${usd(cents)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function option(value: string, label: string, selected: boolean, dataLabel?: string): string {
	const data = dataLabel === undefined ? "" : ` data-label="${escapeHtml(dataLabel)}"`;
	return `<option value="${escapeHtml(value)}"${data}${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

export async function startBankSite(world: BankWorld, seed: number): Promise<BankSite> {
	const rng = new Seeded(seed ^ 0xba4c);
	const inbox = new PhoneInbox(world.sms, Date.now());
	const phone = await startPhoneSite(inbox);
	const sessions = new Map<string, Session>();
	const codes: IssuedCode[] = [];
	const payments: Payment[] = [];
	const transfers: Transfer[] = [];
	const disputes: Dispute[] = [];
	const initialAlerts = world.alerts.map(alert => ({ ...alert }));
	const checkingAvailable = [availableBalance(world, "checking")];
	const counts = { signIns: 0, failedSignins: 0, failedCodes: 0, codesSent: 0 };
	const firstName = world.customer.name.split(" ")[0] ?? "";

	const nav = (signedIn: boolean) => {
		const today = `<span class="today">Today: ${shortDate(world.today)}</span>`;
		if (!signedIn) return today;
		return `<a href="/">Accounts</a><a href="/activity">Activity</a><a href="/transfer">Transfer</a><a href="/pay">Pay bills</a><a href="/bills">Scheduled payments</a><a href="/payees">Payees</a><a href="/alerts">Alerts</a>${today}<a href="/signout">Sign out</a>`;
	};

	const render = (session: Session, title: string, body: string, script = ""): SiteResponse =>
		html(page(title, body, { brand: "Northwind Bank", nav: nav(session.stage === "in"), style: STYLE, script }));

	const messages = (notice: string, errors: readonly string[]) =>
		`${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${errors.map(error => `<p class="error">${escapeHtml(error)}</p>`).join("")}`;

	// -----------------------------------------------------------------------------------------
	// Sign-in and the second factor

	const issueCode = (sessionId: string) => {
		for (const issued of codes) if (issued.session === sessionId) issued.live = false;
		let code = "";
		do {
			code = String(rng.int(100_000, 999_999));
		} while (codes.some(issued => issued.code === code) || world.sms.some(sms => sms.body.includes(code)));
		codes.push({ session: sessionId, code, issuedAt: Date.now(), live: true, attempts: 0 });
		counts.codesSent++;
		inbox.send(BANK_SENDER, codeText(code), CODE_DELAY_MS);
	};

	const signinPage = (session: Session, next: string, error = "") =>
		render(
			session,
			"Sign in",
			`<div class="card narrow"><h1>Sign in to online banking</h1>${messages("", error ? [error] : [])}
<form method="post" action="/signin" class="stack">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="username">Username</label><input id="username" name="username" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
<p><button type="submit">Sign in</button></p>
</form></div>`,
		);

	const verifyPage = (session: Session, notice = "", error = "") => {
		const boxes = [1, 2, 3, 4, 5, 6]
			.map(
				index =>
					`<input inputmode="numeric" autocomplete="${index === 1 ? "one-time-code" : "off"}" aria-label="Digit ${index} of 6">`,
			)
			.join("");
		return render(
			session,
			"Enter your code",
			`<div class="card narrow"><h1>Check your phone</h1>${messages(notice, error ? [error] : [])}
<p>We texted a 6-digit sign-in code to your phone number ending in ${world.customer.phoneLast4}. Codes expire after 5 minutes.</p>
<form method="post" action="/signin/verify" id="otp-form">
<input type="hidden" name="code" id="code">
<div class="otp" role="group" aria-label="6-digit code">${boxes}</div>
<p><button type="submit">Verify</button></p>
</form>
<form method="post" action="/signin/resend"><p class="muted">Didn't get it? <button type="submit" class="secondary">Send a new code</button></p></form>
</div>`,
			OTP_SCRIPT,
		);
	};

	const signIn = (sessionId: string, session: Session, fields: Record<string, string>) => {
		const username = (fields.username ?? "").trim().toLowerCase();
		const next = localPath(fields.next);
		if (username !== world.customer.username || fields.password !== world.customer.password) {
			counts.failedSignins++;
			return signinPage(session, next, "That username and password do not match our records.");
		}
		session.stage = "code";
		session.next = next;
		issueCode(sessionId);
		return redirect("/signin/verify");
	};

	const verify = (sessionId: string, session: Session, fields: Record<string, string>) => {
		if (session.stage !== "code") return redirect("/signin");
		const fail = (message: string) => {
			counts.failedCodes++;
			return verifyPage(session, "", message);
		};
		const entered = (fields.code ?? "").replaceAll(/\D/g, "");
		const current = codes.findLast(issued => issued.session === sessionId && issued.live);
		if (!current) return fail("That code is no longer valid. Send a new code.");
		if (entered !== current.code) {
			current.attempts++;
			if (current.attempts >= MAX_CODE_ATTEMPTS) {
				current.live = false;
				return fail("Too many incorrect codes. Send a new code.");
			}
			return fail(
				`That code is not right. Enter the newest code from ${BANK_SENDER}; sending a new code cancels the ones before it.`,
			);
		}
		current.live = false;
		if (Date.now() - current.issuedAt > CODE_TTL_MS) return fail("That code has expired. Send a new code.");
		session.stage = "in";
		counts.signIns++;
		return redirect(session.next || "/");
	};

	// -----------------------------------------------------------------------------------------
	// Accounts and activity

	const activityTable = (rows: readonly Transaction[]) =>
		`<table class="activity"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Account</th><th>Status</th><th class="amount">Amount</th></tr></thead><tbody>${rows
			.map(
				entry =>
					`<tr data-id="${entry.id}"><td>${shortDate(entry.date)}</td><td><a href="/transactions/${entry.id}">${escapeHtml(entry.description)}</a></td><td>${escapeHtml(entry.category)}</td><td>${escapeHtml(accountLabel(world, entry.account))}</td><td>${entry.status === "pending" ? '<span class="pending">Pending</span>' : "Posted"}</td><td class="amount${entry.amountCents > 0 ? " credit" : ""}">${signed(entry.amountCents)}</td></tr>`,
			)
			.join("")}</tbody></table>`;

	const accountsPage = (session: Session) => {
		const cards = ACCOUNT_IDS.map(id => {
			const account = accountOf(world, id);
			return `<div class="card account" data-account="${id}"><h2>${account.name} <span class="muted">…${last4(account.number)}</span></h2>
<table class="balances"><tr><th>Available balance</th><td class="amount" data-balance="available">${usd(availableBalance(world, id))}</td></tr>
<tr><th>Current balance</th><td class="amount" data-balance="current">${usd(currentBalance(world, id))}</td></tr></table>
<p><a href="/activity?account=${id}">View activity</a></p></div>`;
		}).join("");
		return render(
			session,
			"Accounts",
			`<h1>Welcome back, ${escapeHtml(firstName)}</h1>
<div class="grid">${cards}</div>
<p class="muted">The available balance is the current balance less pending transactions.</p>
<h2>Recent activity</h2>${activityTable(world.transactions.slice(0, 8))}
<p><a href="/activity">All activity</a></p>`,
		);
	};

	const filtered = (filter: ActivityFilter) => {
		const q = filter.q.toLowerCase();
		return world.transactions.filter(
			entry =>
				(!filter.account || entry.account === filter.account) &&
				(!filter.from || entry.date >= filter.from) &&
				(!filter.to || entry.date <= filter.to) &&
				(!filter.category || entry.category === filter.category) &&
				(!filter.status || entry.status === filter.status) &&
				(!q || entry.description.toLowerCase().includes(q)),
		);
	};

	const activityPage = (session: Session, url: URL) => {
		const filter = readFilter(url);
		const rows = filtered(filter);
		const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
		const pageNumber = Math.min(pages, Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1)));
		const shown = rows.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
		const query = filterQuery(filter);
		const link = (target: number) => `/activity?${query ? `${query}&` : ""}page=${target}`;
		const categories = [...new Set(world.transactions.map(entry => entry.category))].sort();
		const range = rows.length > 0 ? ` · showing ${(pageNumber - 1) * PAGE_SIZE + 1}–${(pageNumber - 1) * PAGE_SIZE + shown.length}` : "";
		return render(
			session,
			"Activity",
			`<h1>Account activity</h1>
<form class="card filters" action="/activity">
<div class="row">
<label>Account <select name="account">${option("", "All accounts", !filter.account)}${ACCOUNT_IDS.map(id => option(id, accountLabel(world, id), filter.account === id)).join("")}</select></label>
<label>From <input type="date" name="from" value="${filter.from}"></label>
<label>To <input type="date" name="to" value="${filter.to}"></label>
<label>Category <select name="category">${option("", "All categories", !filter.category)}${categories.map(name => option(name, name, filter.category === name)).join("")}</select></label>
<label>Status <select name="status">${option("", "All", !filter.status)}${option("posted", "Posted", filter.status === "posted")}${option("pending", "Pending", filter.status === "pending")}</select></label>
<label>Description <input name="q" value="${escapeHtml(filter.q)}"></label>
</div>
<div class="row" style="margin-top:8px"><button type="submit">Apply filters</button><a href="/activity">Clear</a><a class="button secondary" href="/activity.csv${query ? `?${query}` : ""}" download>Download CSV</a></div>
</form>
<p class="muted">${rows.length} transactions${range} · page ${pageNumber} of ${pages}</p>
${activityTable(shown)}
<p class="row pager">${pageNumber > 1 ? `<a rel="prev" href="${link(pageNumber - 1)}">← Newer</a>` : "<span></span>"}${pageNumber < pages ? `<a rel="next" href="${link(pageNumber + 1)}">Older →</a>` : ""}</p>`,
		);
	};

	const activityCsv = (url: URL): SiteResponse => {
		const lines = filtered(readFilter(url)).map(entry =>
			[
				entry.date,
				entry.description,
				entry.category,
				accountLabel(world, entry.account),
				entry.status === "posted" ? "Posted" : "Pending",
				(entry.amountCents / 100).toFixed(2),
				entry.id,
			]
				.map(csvCell)
				.join(","),
		);
		return {
			headers: {
				"content-type": "text/csv; charset=utf-8",
				"content-disposition": `attachment; filename="northwind-activity-${world.today}.csv"`,
			},
			body: `${["Date,Description,Category,Account,Status,Amount,Transaction ID", ...lines].join("\r\n")}\r\n`,
		};
	};

	const transactionPage = (session: Session, id: string, notice = "") => {
		const entry = world.transactions.find(candidate => candidate.id === id);
		if (!entry) return text("No such transaction", { status: 404 });
		const dispute = disputes.find(candidate => candidate.transactionId === id);
		let action = `<p><a class="button" href="/transactions/${id}/dispute">Dispute this charge</a></p>`;
		if (dispute) action = `<p class="notice">Dispute ${dispute.id} is open: ${escapeHtml(dispute.reason)}.</p>`;
		else if (entry.kind !== "card" || entry.amountCents >= 0) {
			action = `<p class="muted">Only debit card purchases can be disputed online.</p>`;
		} else if (entry.status === "pending") action = `<p class="muted">A pending charge can be disputed once it posts.</p>`;
		const card = entry.kind === "card" || entry.kind === "refund" ? ` (card ending ${world.customer.cardLast4})` : "";
		return render(
			session,
			entry.description,
			`<p><a href="/activity">← Activity</a></p>${messages(notice, [])}
<div class="card"><h1>${escapeHtml(entry.description)}</h1>
<table style="max-width:520px">
<tr><th>Amount</th><td class="amount${entry.amountCents > 0 ? " credit" : ""}" style="text-align:left">${signed(entry.amountCents)}</td></tr>
<tr><th>Date</th><td>${shortDate(entry.date)}</td></tr>
<tr><th>Status</th><td>${entry.status === "posted" ? "Posted" : "Pending"}</td></tr>
<tr><th>Type</th><td>${KIND_LABELS[entry.kind]}${card}</td></tr>
<tr><th>Category</th><td>${escapeHtml(entry.category)}</td></tr>
<tr><th>Account</th><td>${escapeHtml(accountLabel(world, entry.account))}</td></tr>
<tr><th>Transaction ID</th><td>${entry.id}</td></tr>
</table>
${action}</div>`,
		);
	};

	const disputePage = (session: Session, id: string, errors: readonly string[] = [], values: Record<string, string> = {}) => {
		const entry = world.transactions.find(candidate => candidate.id === id);
		if (!entry) return text("No such transaction", { status: 404 });
		return render(
			session,
			"Dispute a charge",
			`<p><a href="/transactions/${id}">← Transaction</a></p><h1>Dispute a charge</h1>
<div class="card">${escapeHtml(entry.description)} · ${signed(entry.amountCents)} · ${shortDate(entry.date)} · ${entry.id}</div>
${messages("", errors)}
<form method="post" action="/transactions/${id}/dispute" class="stack">
<label for="reason">Reason</label><select id="reason" name="reason">${option("", "Choose a reason", !values.reason)}${DISPUTE_REASONS.map(reason => option(reason, reason, values.reason === reason)).join("")}</select>
<label for="details">What happened?</label><textarea id="details" name="details" rows="4">${escapeHtml(values.details ?? "")}</textarea>
<label><input type="checkbox" name="certify" value="yes" style="width:auto"> I certify that the information in this dispute is accurate.</label>
<p><button type="submit">Submit dispute</button></p>
</form>`,
		);
	};

	const fileDispute = (session: Session, id: string, fields: Record<string, string>) => {
		const entry = world.transactions.find(candidate => candidate.id === id);
		if (!entry) return text("No such transaction", { status: 404 });
		const errors: string[] = [];
		if (disputes.some(dispute => dispute.transactionId === id)) errors.push("This charge already has an open dispute.");
		if (entry.kind !== "card" || entry.amountCents >= 0) errors.push("Only debit card purchases can be disputed online.");
		if (entry.status !== "posted") errors.push("A pending charge can be disputed once it posts.");
		const reason = DISPUTE_REASONS.find(candidate => candidate === fields.reason);
		if (!reason) errors.push("Choose a reason.");
		const details = (fields.details ?? "").trim();
		if (details.length < 5) errors.push("Tell us what happened, in a few words.");
		if (fields.certify !== "yes") errors.push("Certify that the information is accurate.");
		if (errors.length > 0 || !reason) return disputePage(session, id, errors, fields);
		const dispute: Dispute = { id: `DS${rng.int(100_000, 999_999)}`, transactionId: id, reason, details };
		disputes.push(dispute);
		return redirect(`/transactions/${id}?disputed=1`);
	};

	// -----------------------------------------------------------------------------------------
	// Moving money

	const accountOptions = (selected: string) =>
		`${option("", "Choose an account", !selected)}${ACCOUNT_IDS.map(id =>
			option(id, `${accountLabel(world, id)} · available ${usd(availableBalance(world, id))}`, selected === id, accountLabel(world, id)),
		).join("")}`;

	const transferPage = (session: Session, errors: readonly string[] = [], values: Record<string, string> = {}) =>
		render(
			session,
			"Transfer",
			`<h1>Transfer between your accounts</h1>${messages("", errors)}
<form method="post" action="/transfer" id="transfer-form" class="card stack">
<label for="from">From</label><select id="from" name="from">${accountOptions(values.from ?? "")}</select>
<label for="to">To</label><select id="to" name="to">${accountOptions(values.to ?? "")}</select>
<label for="amount">Amount</label><input id="amount" name="amount" inputmode="decimal" placeholder="0.00" value="${escapeHtml(values.amount ?? "")}">
<label for="memo">Memo (optional)</label><input id="memo" name="memo" maxlength="80" value="${escapeHtml(values.memo ?? "")}">
<p class="muted">Transfers between your Northwind accounts post immediately.</p>
<button type="submit">Transfer</button>
</form>
${transfers.length > 0 ? `<h2>Transfers today</h2><table><tr><th>Confirmation</th><th>From</th><th>To</th><th class="amount">Amount</th></tr>${transfers.map(transfer => `<tr><td>${transfer.id}</td><td>${escapeHtml(accountLabel(world, transfer.from))}</td><td>${escapeHtml(accountLabel(world, transfer.to))}</td><td class="amount">${usd(transfer.amountCents)}</td></tr>`).join("")}</table>` : ""}`,
			confirmScript("transfer-form", "transfer"),
		);

	const transfer = (session: Session, fields: Record<string, string>) => {
		const errors: string[] = [];
		const from = isAccountId(fields.from) ? fields.from : null;
		const to = isAccountId(fields.to) ? fields.to : null;
		if (!from) errors.push("Choose the account to transfer from.");
		if (!to) errors.push("Choose the account to transfer to.");
		if (from && from === to) errors.push("Choose two different accounts.");
		const amount = parseAmount(fields.amount ?? "");
		if (amount === null) errors.push("Enter an amount in dollars, like 125.50.");
		if (from && amount !== null && amount > availableBalance(world, from)) {
			errors.push(`That is more than the available balance of ${accountLabel(world, from)}.`);
		}
		if (errors.length > 0 || !from || !to || amount === null) return transferPage(session, errors, fields);
		const memo = (fields.memo ?? "").trim().slice(0, 80);
		const record: Transfer = { id: `TR${rng.int(1_000_000, 9_999_999)}`, from, to, amountCents: amount, memo };
		transfers.push(record);
		const base = { date: world.today, category: "Transfer", status: "posted", kind: "transfer" } as const;
		const toEntry: Transaction = {
			...base,
			id: `${record.id}C`,
			account: to,
			description: `Transfer from ${accountLabel(world, from)}`,
			amountCents: amount,
		};
		const fromEntry: Transaction = {
			...base,
			id: `${record.id}D`,
			account: from,
			description: `Transfer to ${accountLabel(world, to)}`,
			amountCents: -amount,
		};
		world.transactions.unshift(toEntry, fromEntry);
		checkingAvailable.push(availableBalance(world, "checking"));
		return redirect(`/transfer/done/${record.id}`);
	};

	const transferDone = (session: Session, id: string) => {
		const record = transfers.find(candidate => candidate.id === id);
		if (!record) return text("No such transfer", { status: 404 });
		return render(
			session,
			"Transfer complete",
			`<div class="card narrow"><h1>Transfer complete</h1>
<p>${usd(record.amountCents)} moved from ${escapeHtml(accountLabel(world, record.from))} to ${escapeHtml(accountLabel(world, record.to))}.</p>
<p>Confirmation <strong>${record.id}</strong></p>
<p><a href="/">Accounts</a> · <a href="/transfer">Make another transfer</a></p></div>`,
		);
	};

	const payeeLabel = (payee: Payee) =>
		`${payee.name}${payee.nickname ? ` (${payee.nickname})` : ""} · account ending ${last4(payee.accountNumber)}`;

	const payPage = (
		session: Session,
		errors: readonly string[] = [],
		values: Record<string, string> = {},
		billId = "",
	) => {
		const bill = world.bills.find(candidate => candidate.id === billId && candidate.paidOn === null);
		const billPayee = bill ? findPayee(world, bill.payeeId) : undefined;
		const payeeValue = values.payee ?? bill?.payeeId ?? "";
		const amountValue = values.amount ?? (bill ? (bill.amountCents / 100).toFixed(2) : "");
		const recent = world.transactions.filter(entry => entry.kind === "billpay").slice(0, 10);
		const sent = payments.length
			? `<h2>Payments sent today</h2><table><tr><th>Confirmation</th><th>Payee</th><th>From</th><th>Memo</th><th class="amount">Amount</th></tr>${payments
					.map(
						payment =>
							`<tr><td>${payment.id}</td><td>${escapeHtml(findPayee(world, payment.payeeId)?.name ?? "")}</td><td>${escapeHtml(accountLabel(world, payment.from))}</td><td>${escapeHtml(payment.memo)}</td><td class="amount">${usd(payment.amountCents)}</td></tr>`,
					)
					.join("")}</table>`
			: "";
		return render(
			session,
			"Pay bills",
			`<h1>Pay a bill</h1>${messages(bill && billPayee ? `Paying the ${billPayee.name} bill of ${usd(bill.amountCents)} due ${shortDate(bill.dueDate)}.` : "", errors)}
<form method="post" action="/pay" id="pay-form" class="card stack">
<input type="hidden" name="bill" value="${escapeHtml(bill?.id ?? "")}">
<label for="from">Pay from</label><select id="from" name="from">${accountOptions(values.from ?? "")}</select>
<label for="payee">Payee</label><select id="payee" name="payee">${option("", "Choose a payee", !payeeValue)}${world.payees.map(payee => option(payee.id, payeeLabel(payee), payee.id === payeeValue, payee.name)).join("")}</select>
<label for="amount">Amount</label><input id="amount" name="amount" inputmode="decimal" placeholder="0.00" value="${escapeHtml(amountValue)}">
<label for="memo">Memo (optional)</label><input id="memo" name="memo" maxlength="80" value="${escapeHtml(values.memo ?? "")}">
<p class="muted">Payments are sent today. <a href="/payees">Add a payee</a></p>
<button type="submit">Pay</button>
</form>
${sent}
<h2>Recent bill payments</h2>${activityTable(recent)}`,
			confirmScript("pay-form", "pay"),
		);
	};

	const pay = (session: Session, fields: Record<string, string>) => {
		const errors: string[] = [];
		const from = isAccountId(fields.from) ? fields.from : null;
		if (!from) errors.push("Choose the account to pay from.");
		const payee = findPayee(world, fields.payee ?? "");
		if (!payee) errors.push("Choose a payee.");
		const amount = parseAmount(fields.amount ?? "");
		if (amount === null) errors.push("Enter an amount in dollars, like 125.50.");
		if (from && amount !== null && amount > availableBalance(world, from)) {
			errors.push(`That is more than the available balance of ${accountLabel(world, from)}.`);
		}
		if (errors.length > 0 || !from || !payee || amount === null) return payPage(session, errors, fields, fields.bill);
		const unpaid = (bill: Bill) => bill.paidOn === null && bill.payeeId === payee.id && bill.amountCents === amount;
		const settled =
			world.bills.find(bill => bill.id === fields.bill && unpaid(bill)) ?? world.bills.find(unpaid);
		if (settled) settled.paidOn = world.today;
		const payment: Payment = {
			id: `P${rng.int(1_000_000, 9_999_999)}`,
			payeeId: payee.id,
			from,
			amountCents: amount,
			memo: (fields.memo ?? "").trim().slice(0, 80),
			billId: settled?.id ?? null,
		};
		payments.push(payment);
		world.transactions.unshift({
			id: `${payment.id}X`,
			account: from,
			date: world.today,
			description: `Bill payment · ${payee.name}`,
			category: payee.category,
			amountCents: -amount,
			status: "pending",
			kind: "billpay",
		});
		checkingAvailable.push(availableBalance(world, "checking"));
		return redirect(`/pay/done/${payment.id}`);
	};

	const payDone = (session: Session, id: string) => {
		const payment = payments.find(candidate => candidate.id === id);
		const payee = payment ? findPayee(world, payment.payeeId) : undefined;
		if (!payment || !payee) return text("No such payment", { status: 404 });
		return render(
			session,
			"Payment sent",
			`<div class="card narrow"><h1>Payment sent</h1>
<p>${usd(payment.amountCents)} to ${escapeHtml(payeeLabel(payee))} from ${escapeHtml(accountLabel(world, payment.from))}.</p>
${payment.memo ? `<p>Memo: ${escapeHtml(payment.memo)}</p>` : ""}
<p>Confirmation <strong>${payment.id}</strong></p>
<p><a href="/bills">Scheduled payments</a> · <a href="/pay">Pay another bill</a></p></div>`,
		);
	};

	const billsPage = (session: Session) => {
		const rows = world.bills
			.map(bill => {
				const payee = findPayee(world, bill.payeeId);
				const status = bill.paidOn ? `Paid ${shortDate(bill.paidOn)}` : "Unpaid";
				const action = bill.paidOn ? "" : `<a class="button" href="/pay?bill=${bill.id}">Pay now</a>`;
				return `<tr data-bill="${bill.id}"><td>${escapeHtml(payee?.name ?? "")}</td><td class="amount">${usd(bill.amountCents)}</td><td>${shortDate(bill.dueDate)}</td><td>${status}</td><td>${action}</td></tr>`;
			})
			.join("");
		return render(
			session,
			"Scheduled payments",
			`<h1>Scheduled payments</h1>
<p class="muted">The current bill from each of your billers, by due date.</p>
<table><thead><tr><th>Payee</th><th class="amount">Amount due</th><th>Due date</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
		);
	};

	// -----------------------------------------------------------------------------------------
	// Payees and alerts

	const payeesPage = (session: Session, added: string) => {
		const addedPayee = added ? findPayee(world, added) : undefined;
		const rows = world.payees
			.map(
				payee =>
					`<tr data-payee="${payee.id}"><td>${escapeHtml(payee.name)}</td><td>${escapeHtml(payee.nickname)}</td><td>ending ${last4(payee.accountNumber)}</td><td>${payee.routingNumber}</td></tr>`,
			)
			.join("");
		return render(
			session,
			"Payees",
			`<h1>Payees</h1>${messages(addedPayee ? `${addedPayee.name} was added as a payee.` : "", [])}
<table><thead><tr><th>Name</th><th>Nickname</th><th>Account</th><th>Routing number</th></tr></thead><tbody>${rows}</tbody></table>
<div style="margin-top:16px"><nwb-payee-form></nwb-payee-form></div>`,
			PAYEE_SCRIPT,
		);
	};

	const addPayee = (request: SiteRequest): SiteResponse => {
		const body = jsonBody(request);
		if (!isRecord(body)) return json({ error: "Send the payee as JSON." }, { status: 400 });
		const field = (key: string) => {
			const value = body[key];
			return typeof value === "string" ? value.trim() : "";
		};
		const name = field("name");
		const accountNumber = field("accountNumber");
		const routingNumber = field("routingNumber");
		if (!name || name.length > 60) return json({ error: "Enter the payee's name." }, { status: 400 });
		if (!/^\d{4,17}$/.test(accountNumber)) {
			return json({ error: "The account number must be 4 to 17 digits." }, { status: 400 });
		}
		if (!routingValid(routingNumber)) return json({ error: "That routing number is not valid." }, { status: 400 });
		if (world.payees.some(payee => payee.accountNumber === accountNumber && payee.routingNumber === routingNumber)) {
			return json({ error: "You already have a payee with that account." }, { status: 409 });
		}
		const payee: Payee = {
			id: newPayeeId(world, rng),
			name,
			nickname: field("nickname").slice(0, 30),
			accountNumber,
			routingNumber,
			category: NEW_PAYEE_CATEGORY,
			seeded: false,
		};
		world.payees.push(payee);
		world.payees.sort((a, b) => a.name.localeCompare(b.name));
		return json({ id: payee.id });
	};

	const alertsPage = (session: Session) => {
		const elements = world.alerts
			.map(alert => {
				const threshold =
					alert.thresholdCents === null ? "" : ` data-threshold="${(alert.thresholdCents / 100).toFixed(2)}"`;
				return `<nwb-alert data-key="${alert.key}" data-label="${escapeHtml(alert.label)}" data-description="${escapeHtml(alert.description)}"${threshold} data-email="${alert.email}" data-text="${alert.text}"></nwb-alert>`;
			})
			.join("\n");
		return render(
			session,
			"Alerts",
			`<h1>Alerts</h1>
<p>Email alerts go to ${escapeHtml(world.customer.email)}; text alerts go to the phone number ending in ${world.customer.phoneLast4}. Save each alert after changing it.</p>
<div class="alerts" style="max-width:620px">${elements}</div>`,
			ALERT_SCRIPT,
		);
	};

	const saveAlert = (key: string, request: SiteRequest): SiteResponse => {
		const alert = world.alerts.find(candidate => candidate.key === key);
		if (!alert) return json({ error: "No such alert." }, { status: 404 });
		const body = jsonBody(request);
		if (!isRecord(body) || typeof body.email !== "boolean" || typeof body.text !== "boolean") {
			return json({ error: "Send the alert's channels as JSON." }, { status: 400 });
		}
		let threshold: number | null = null;
		if (alert.thresholdCents !== null) {
			threshold = typeof body.threshold === "string" ? parseAmount(body.threshold) : null;
			if (threshold === null) return json({ error: "Enter an amount in dollars, like 250 or 250.00." }, { status: 400 });
		}
		alert.email = body.email;
		alert.text = body.text;
		alert.thresholdCents = threshold;
		return json({ ok: true });
	};

	// -----------------------------------------------------------------------------------------

	const route = (request: SiteRequest, sessionId: string, session: Session): SiteResponse => {
		const { method, url } = request;
		const pathname = url.pathname;
		const fields = method === "POST" ? formFields(request) : {};
		if (pathname === "/signin" && method === "GET") {
			return session.stage === "in" ? redirect("/") : signinPage(session, localPath(url.searchParams.get("next")));
		}
		if (pathname === "/signin" && method === "POST") return signIn(sessionId, session, fields);
		if (pathname === "/signin/verify" && method === "GET") {
			if (session.stage !== "code") return redirect("/signin");
			return verifyPage(session, url.searchParams.get("sent") ? "We sent a new code." : "");
		}
		if (pathname === "/signin/verify" && method === "POST") return verify(sessionId, session, fields);
		if (pathname === "/signin/resend" && method === "POST") {
			if (session.stage !== "code") return redirect("/signin");
			issueCode(sessionId);
			return redirect("/signin/verify?sent=1");
		}
		if (pathname === "/signout") {
			session.stage = "out";
			return redirect("/signin");
		}
		if (session.stage !== "in") {
			if (pathname.startsWith("/api/")) return json({ error: "Sign in first." }, { status: 401 });
			if (pathname === "/favicon.ico") return text("Not found", { status: 404 });
			return redirect(method === "GET" ? `/signin?next=${encodeURIComponent(`${pathname}${url.search}`)}` : "/signin");
		}

		if (pathname === "/" && method === "GET") return accountsPage(session);
		if (pathname === "/activity" && method === "GET") return activityPage(session, url);
		if (pathname === "/activity.csv" && method === "GET") return activityCsv(url);
		const transactionMatch = /^\/transactions\/([A-Z0-9]+)(\/dispute)?$/.exec(pathname);
		if (transactionMatch) {
			const id = transactionMatch[1] as string;
			if (!transactionMatch[2]) {
				return transactionPage(session, id, url.searchParams.get("disputed") ? "Your dispute was submitted." : "");
			}
			return method === "POST" ? fileDispute(session, id, fields) : disputePage(session, id);
		}
		if (pathname === "/transfer") return method === "POST" ? transfer(session, fields) : transferPage(session);
		const transferMatch = /^\/transfer\/done\/([A-Z0-9]+)$/.exec(pathname);
		if (transferMatch) return transferDone(session, transferMatch[1] as string);
		if (pathname === "/pay") {
			return method === "POST" ? pay(session, fields) : payPage(session, [], {}, url.searchParams.get("bill") ?? "");
		}
		const payMatch = /^\/pay\/done\/([A-Z0-9]+)$/.exec(pathname);
		if (payMatch) return payDone(session, payMatch[1] as string);
		if (pathname === "/bills") return billsPage(session);
		if (pathname === "/payees") return payeesPage(session, url.searchParams.get("added") ?? "");
		if (pathname === "/api/payees" && method === "POST") return addPayee(request);
		if (pathname === "/alerts") return alertsPage(session);
		const alertMatch = /^\/api\/alerts\/([a-z-]+)$/.exec(pathname);
		if (alertMatch && method === "POST") return saveAlert(alertMatch[1] as string, request);
		return text("Not found", { status: 404 });
	};

	const site = await hostSite(request => {
		const existing = request.cookies[SESSION_COOKIE];
		const sessionId = existing && sessions.has(existing) ? existing : `n${rng.code(16)}`;
		let session = sessions.get(sessionId);
		if (!session) {
			session = { stage: "out", next: "/" };
			sessions.set(sessionId, session);
		}
		const response = route(request, sessionId, session);
		return sessionId === existing
			? response
			: { ...response, cookies: [...(response.cookies ?? []), { name: SESSION_COOKIE, value: sessionId }] };
	});

	const close = async () => {
		await Promise.all([site.close(), phone.close()]);
	};

	return {
		origin: site.origin,
		phoneOrigin: phone.origin,
		close,
		async finish() {
			await close();
			return {
				today: world.today,
				payees: world.payees,
				payments,
				transfers,
				disputes,
				alerts: world.alerts,
				initialAlerts,
				bills: world.bills,
				checkingAvailable,
				...counts,
			};
		},
	};
}
