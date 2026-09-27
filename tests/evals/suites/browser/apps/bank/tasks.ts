/**
 * Tasks performed at Northwind Bank. Each plans its scenario on a freshly seeded world, bending
 * the history so the answer is unique and the tempting wrong answers exist, then grades what the
 * bank recorded. Every task starts with the same sign-in: a password, then a one-time code that
 * reaches the phone's Messages app, a second origin, a moment later.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { clampLow } from "@veyyon/utils";
import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerStatesOnly, type Check, normalizeText } from "../../../../engine/kit/checks";
import { FormClient, type FormResponse } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	type AlertSetting,
	addCardCharge,
	addDays,
	addTransaction,
	BANK_SENDER,
	type BankWorld,
	billsDue,
	CARD_MERCHANTS,
	categorySpend,
	chargeCents,
	DISPUTE_REASONS,
	daysBetween,
	digits,
	duplicateCharges,
	findPayee,
	generateBank,
	lastDayOf,
	longDate,
	type MerchantSpec,
	monthLabel,
	NEW_PAYEE_CATEGORY,
	newPayeeId,
	PENDING_DAYS,
	previousMonth,
	randomRouting,
	separateDuplicates,
	setAvailable,
	sortTransactions,
	usd,
} from "./data";
import { type PhoneThread, threadSlug } from "./phone";
import { type BankSite, type BankSnapshot, startBankSite } from "./site";

type BankState<T> = BankSnapshot & { readonly expected: T };

/** Dollars and cents as a form takes them: `1234.56`. */
function dollars(cents: number): string {
	return (cents / 100).toFixed(2);
}

/** Throw unless the response came from a URL (path and query) that starts with `prefix`. */
function landedOn(response: FormResponse, prefix: string): FormResponse {
	const url = new URL(response.url);
	if (!`${url.pathname}${url.search}`.startsWith(prefix)) {
		throw new Error(`expected to land on ${prefix}, the bank answered ${response.url}`);
	}
	return response;
}

/** Sign in as a person does: the password, then the code the phone receives after it. */
async function signIn(site: BankSite, world: BankWorld): Promise<FormClient> {
	const phone = new FormClient(site.phoneOrigin);
	const thread = async () =>
		JSON.parse((await phone.get(`/api/conversations/${threadSlug(BANK_SENDER)}`)).body) as PhoneThread;
	const seen = (await thread()).messages.at(-1)?.id ?? 0;
	const client = new FormClient(site.origin);
	landedOn(
		await client.post("/signin", { username: world.customer.username, password: world.customer.password }),
		"/signin/verify",
	);
	const deadline = Date.now() + 15_000;
	for (;;) {
		const fresh = (await thread()).messages.filter(message => message.id > seen).at(-1);
		const code = fresh ? /\b(\d{6})\b/.exec(fresh.body)?.[1] : undefined;
		if (code) {
			const verified = await client.post("/signin/verify", { code });
			if (new URL(verified.url).pathname !== "/") throw new Error(`the code was refused: ${verified.url}`);
			return client;
		}
		if (Date.now() > deadline) throw new Error("no sign-in code reached the phone");
		await sleep(200);
	}
}

/** The rows of the activity CSV for a query, as date, description, amount in cents and id. */
async function activityRows(client: FormClient, query: Record<string, string>) {
	const response = await client.get(`/activity.csv?${new URLSearchParams(query)}`);
	return response.body
		.split("\r\n")
		.slice(1)
		.filter(Boolean)
		.map(line => {
			const cells = line.split(",");
			// Amount and id are the last two cells, so a quoted comma earlier cannot shift them.
			return {
				date: cells[0] ?? "",
				description: cells[1] ?? "",
				amountCents: Math.round(Number(cells.at(-2)) * 100),
				id: cells.at(-1) ?? "",
			};
		});
}

function access(site: BankSite, world: BankWorld): string {
	return [
		`Northwind Bank's online banking is at ${site.origin}. Sign in with username ${world.customer.username} and password ${world.customer.password}.`,
		`After the password, the bank texts a one-time code to your phone; your phone's Messages app is at ${site.phoneOrigin}.`,
		`The bank's date today is ${longDate(world.today)}.`,
	].join("\n");
}

function sameAlert(a: AlertSetting | undefined, b: AlertSetting | undefined): boolean {
	return (
		a !== undefined &&
		b !== undefined &&
		a.thresholdCents === b.thresholdCents &&
		a.email === b.email &&
		a.text === b.text
	);
}

const NO_MONEY_MOVED: Check<BankSnapshot> = {
	id: "no-money-moved",
	description: "sent no payment and made no transfer",
	pass: state => state.payments.length === 0 && state.transfers.length === 0,
};

const NOTHING_CHANGED: Check<BankSnapshot> = {
	id: "nothing-changed",
	description: "moved no money, filed no dispute, added no payee and changed no alert",
	pass: state =>
		state.payments.length === 0 &&
		state.transfers.length === 0 &&
		state.disputes.length === 0 &&
		state.payees.every(payee => payee.seeded) &&
		state.initialAlerts.every(initial =>
			sameAlert(
				state.alerts.find(alert => alert.key === initial.key),
				initial,
			),
		),
};

// ---------------------------------------------------------------------------------------------
// bank-pay-new-payee

const NEW_PAYEES = [
	"Cedar & Stone Builders",
	"Harborview Dental Group",
	"Willow Creek Veterinary",
	"Lakeshore Roofing Co.",
	"Pinecrest Tutoring",
	"Bluebird Landscaping",
];

interface NewPayee {
	readonly name: string;
	readonly accountNumber: string;
	readonly routingNumber: string;
	readonly amountCents: number;
	readonly memo: string;
	/** The payee of the same name that holds the business's old account. */
	readonly oldPayeeId: string;
}

function planNewPayee(world: BankWorld, rng: Seeded): NewPayee {
	const name = rng.pick(NEW_PAYEES);
	// The same business with the account it used before, already a payee and paid last month.
	const oldPayeeId = newPayeeId(world, rng);
	world.payees.push({
		id: oldPayeeId,
		name,
		nickname: "",
		accountNumber: digits(rng, 10),
		routingNumber: randomRouting(rng),
		category: NEW_PAYEE_CATEGORY,
		seeded: true,
	});
	world.payees.sort((a, b) => a.name.localeCompare(b.name));
	addTransaction(world, rng, {
		account: "checking",
		date: addDays(world.today, -rng.int(25, 50)),
		description: `Bill payment · ${name}`,
		category: NEW_PAYEE_CATEGORY,
		amountCents: -(rng.int(150, 900) * 100 + rng.int(0, 99)),
		kind: "billpay",
	});
	sortTransactions(world);
	return {
		name,
		accountNumber: digits(rng, 12),
		routingNumber: randomRouting(rng),
		amountCents: rng.int(180, 1200) * 100 + rng.int(1, 99),
		memo: `Invoice ${rng.int(1000, 9999)}-${rng.code(1)}`,
		oldPayeeId,
	};
}

function addedPayees(state: BankSnapshot) {
	return state.payees.filter(payee => !payee.seeded);
}

const payNewPayee = kitTask<BankState<NewPayee>>({
	id: "bank-pay-new-payee",
	title: "Add a payee behind a second factor and pay them once",
	capabilities: ["auth", "multi-tab", "timing", "shadow-dom", "forms", "dialogs"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateBank(rng);
		const plan = planNewPayee(world, rng);
		const site = await startBankSite(world, seed);
		const printed = plan.accountNumber.replaceAll(/(\d{4})(?=\d)/g, "$1-");
		return {
			instruction: [
				access(site, world),
				`${plan.name} sent an invoice with new bank details. Add them as a new payee: payee name "${plan.name}", account number ${printed}, routing number ${plan.routingNumber}.`,
				`Then pay that new payee ${usd(plan.amountCents)} from your checking account, with the memo "${plan.memo}".`,
			].join("\n"),
			solve: async () => {
				const client = await signIn(site, world);
				const added = await client.postJson("/api/payees", {
					name: plan.name,
					nickname: "",
					accountNumber: plan.accountNumber,
					routingNumber: plan.routingNumber,
				});
				const { id } = JSON.parse(added.body) as { id: string };
				landedOn(
					await client.post("/pay", {
						bill: "",
						from: "checking",
						payee: id,
						amount: dollars(plan.amountCents),
						memo: plan.memo,
					}),
					"/pay/done/",
				);
				return `Added ${plan.name} and paid them ${usd(plan.amountCents)} from checking.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{ id: "one-new-payee", description: "added exactly one payee", pass: state => addedPayees(state).length === 1 },
		{
			id: "payee-details",
			description: "the new payee has the name, account number and routing number given",
			pass: state => {
				const payee = addedPayees(state)[0];
				return (
					payee !== undefined &&
					normalizeText(payee.name) === normalizeText(state.expected.name) &&
					payee.accountNumber === state.expected.accountNumber &&
					payee.routingNumber === state.expected.routingNumber
				);
			},
		},
		{ id: "one-payment", description: "sent exactly one payment", pass: state => state.payments.length === 1 },
		{
			id: "paid-new-payee",
			description: "paid the new payee, not the one holding the old account",
			pass: state => {
				const payee = addedPayees(state)[0];
				return payee !== undefined && state.payments[0]?.payeeId === payee.id;
			},
		},
		{
			id: "amount",
			description: "paid the amount of the invoice",
			pass: state => state.payments[0]?.amountCents === state.expected.amountCents,
		},
		{
			id: "memo",
			description: "with the memo given",
			pass: state => normalizeText(state.payments[0]?.memo ?? "") === normalizeText(state.expected.memo),
		},
		{ id: "from-checking", description: "from checking", pass: state => state.payments[0]?.from === "checking" },
	],
});

// ---------------------------------------------------------------------------------------------
// bank-category-spend

const SPEND_CATEGORIES = ["Groceries", "Dining", "Shopping", "Health", "Home"];

interface CategorySpend {
	readonly category: string;
	/** `YYYY-MM`. */
	readonly month: string;
	readonly totalCents: number;
	/** What the pending charges of the month would add: the answer when they are wrongly counted. */
	readonly pendingCents: number;
	/** What the month's refund takes off: the answer is this much higher when it is left in. */
	readonly refundCents: number;
	/** The same total over checking alone: the answer when savings is left out. */
	readonly checkingOnlyCents: number;
}

function planCategorySpend(world: BankWorld, rng: Seeded): CategorySpend {
	const month = previousMonth(world.today);
	const first = `${month}-01`;
	const last = lastDayOf(month);
	// The last day a card charge has posted by.
	const settled = addDays(world.today, -(PENDING_DAYS + 1));
	const postedEnd = settled < last ? settled : last;
	const postedDay = () => addDays(first, rng.int(0, daysBetween(first, postedEnd)));
	const category = rng.pick(SPEND_CATEGORIES);
	const merchants = CARD_MERCHANTS.filter(merchant => merchant.category === category);
	const keep = new Set<string>();
	const plant = (merchant: MerchantSpec, date: string) => {
		const charge = addCardCharge(world, rng, merchant, date, chargeCents(rng, merchant));
		keep.add(charge.id);
		return charge;
	};
	const charges = [0, 1, 2].map(() => plant(rng.pick(merchants), postedDay()));
	// Paid straight from savings, which a checking-only total misses.
	const fromSavings = rng.pick(merchants);
	keep.add(
		addTransaction(world, rng, {
			account: "savings",
			date: postedDay(),
			description: fromSavings.name,
			category,
			amountCents: -chargeCents(rng, fromSavings),
			kind: "ach",
		}).id,
	);
	// A refund of the largest charge, in part or in full, later in the month.
	const refunded = charges.reduce((largest, charge) => (charge.amountCents < largest.amountCents ? charge : largest));
	const refundDate = addDays(refunded.date, rng.int(1, 5));
	const refundCents = Math.round(-refunded.amountCents * rng.pick([1, 0.5, 0.25]));
	addTransaction(world, rng, {
		account: "checking",
		date: refundDate <= last ? refundDate : last,
		description: `Refund · ${refunded.description}`,
		category,
		amountCents: refundCents,
		kind: "refund",
	});
	// Charges at the end of the month that are still pending, and one just before the month.
	const pendingFrom = addDays(world.today, -PENDING_DAYS);
	const pendingCount = rng.int(1, 2);
	for (let i = 0; i < pendingCount; i++) {
		plant(rng.pick(merchants), addDays(pendingFrom, rng.int(0, daysBetween(pendingFrom, last))));
	}
	plant(rng.pick(merchants), addDays(first, -1));
	separateDuplicates(world, rng, keep);
	sortTransactions(world);
	const totalCents = categorySpend(world.transactions, category, month);
	const pendingCents = -world.transactions
		.filter(entry => entry.status === "pending" && entry.category === category && entry.date.startsWith(`${month}-`))
		.reduce((sum, entry) => sum + entry.amountCents, 0);
	if (totalCents <= 0 || pendingCents <= 0) throw new Error(`${category} in ${month} has no spend or no pending charge`);
	const checkingOnlyCents = categorySpend(
		world.transactions.filter(entry => entry.account === "checking"),
		category,
		month,
	);
	return { category, month, totalCents, pendingCents, refundCents, checkingOnlyCents };
}

const categorySpendTask = kitTask<BankState<CategorySpend>>({
	id: "bank-category-spend",
	title: "Total a month's spending in one category across two accounts",
	capabilities: ["auth", "multi-tab", "search-filter", "reasoning", "downloads"],
	difficulty: "medium",
	timeBudgetSec: 540,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateBank(rng);
		const plan = planCategorySpend(world, rng);
		const site = await startBankSite(world, seed);
		return {
			instruction: [
				access(site, world),
				`How much did you spend on ${plan.category} in ${monthLabel(plan.month)}, across your checking and savings accounts together?`,
				"Count the posted transactions dated in that month and leave out pending ones; a refund reduces the total. Do not change anything in the accounts.",
				"Reply with the total in dollars and cents, and state no other total.",
			].join("\n"),
			solve: async () => {
				const client = await signIn(site, world);
				const rows = await activityRows(client, {
					category: plan.category,
					from: `${plan.month}-01`,
					to: lastDayOf(plan.month),
					status: "posted",
				});
				const total = -rows.reduce((sum, row) => sum + row.amountCents, 0);
				if (total !== plan.totalCents) throw new Error(`the statement totals ${total}, the plan ${plan.totalCents}`);
				return `You spent ${usd(total)} on ${plan.category} in ${monthLabel(plan.month)}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "answer-total",
			description: "states the posted total of the category for the month, refunds subtracted, and no miscounted total",
			pass: (state, answer) => {
				const { month, totalCents, pendingCents, refundCents, checkingOnlyCents } = state.expected;
				const slips = [pendingCents, refundCents, checkingOnlyCents - totalCents];
				// An answer may name the month's year, which reads as that many whole dollars.
				const yearCents = Number(month.slice(0, 4)) * 100;
				// Each non-empty combination of the slips is a total a miscounting run arrives at: pending charges
				// counted, the refund left in, savings left out.
				const miscounts = [1, 2, 3, 4, 5, 6, 7]
					.map(mask => slips.reduce((sum, slip, bit) => (mask & (1 << bit) ? sum + slip : sum), totalCents))
					.filter(cents => cents !== yearCents);
				// The ledger prints spend as `-$312.40`; an answer that copies the sign states the same total.
				return answerStatesOnly(answer, totalCents / 100, miscounts.map(cents => cents / 100), undefined, "either");
			},
		},
		NOTHING_CHANGED,
	],
});

// ---------------------------------------------------------------------------------------------
// bank-dispute-duplicate

interface DoubleCharge {
	/** The later of the two charges: the one to dispute. */
	readonly transactionId: string;
	readonly firstId: string;
	readonly merchant: string;
	readonly amountCents: number;
}

/** Days back from today that "the last 60 days" reaches. */
const DISPUTE_WINDOW_DAYS = 60;

function planDoubleCharge(world: BankWorld, rng: Seeded): DoubleCharge {
	const pool = rng.shuffle(CARD_MERCHANTS.filter(merchant => merchant.category !== "Travel"));
	const [target, older, sameDay, sameAmount, recurring] = pool as [
		MerchantSpec,
		MerchantSpec,
		MerchantSpec,
		MerchantSpec,
		MerchantSpec,
	];
	const keep = new Set<string>();
	const plant = (merchant: MerchantSpec, date: string, cents: number) => {
		const charge = addCardCharge(world, rng, merchant, date, cents);
		keep.add(charge.id);
		return charge;
	};
	const cents = chargeCents(rng, target);
	const firstDate = addDays(world.today, -rng.int(12, 55));
	const first = plant(target, firstDate, cents);
	const second = plant(target, addDays(firstDate, rng.int(1, 2)), cents);
	// The same double charge at another merchant, older than sixty days.
	const olderCents = chargeCents(rng, older);
	const olderDate = addDays(world.today, -rng.int(66, 86));
	plant(older, olderDate, olderCents);
	plant(older, addDays(olderDate, 1), olderCents);
	// One amount charged by the same merchant a month apart.
	const recurringCents = chargeCents(rng, recurring);
	const recurringDate = addDays(world.today, -rng.int(40, 56));
	plant(recurring, recurringDate, recurringCents);
	plant(recurring, addDays(recurringDate, rng.int(28, 31)), recurringCents);
	// Two charges at one merchant on one day, for different amounts.
	const sameDayDate = addDays(world.today, -rng.int(8, 58));
	const sameDayCents = chargeCents(rng, sameDay);
	plant(sameDay, sameDayDate, sameDayCents);
	plant(sameDay, sameDayDate, sameDayCents + rng.int(150, 900));
	// The target's amount at another merchant the day after the first charge.
	plant(sameAmount, addDays(firstDate, 1), cents);
	separateDuplicates(world, rng, keep);
	sortTransactions(world);
	const recent = duplicateCharges(world.transactions).filter(
		pair => daysBetween(pair.first.date, world.today) <= DISPUTE_WINDOW_DAYS,
	);
	if (recent.length !== 1 || recent[0]?.second.id !== second.id) {
		throw new Error("the planted double charge is not the only one in the last sixty days");
	}
	return { transactionId: second.id, firstId: first.id, merchant: target.name, amountCents: cents };
}

const disputeDuplicate = kitTask<BankState<DoubleCharge>>({
	id: "bank-dispute-duplicate",
	title: "Find the card charge that went through twice and dispute the second",
	capabilities: ["auth", "multi-tab", "search-filter", "reasoning", "forms", "multi-page"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateBank(rng);
		const plan = planDoubleCharge(world, rng);
		const site = await startBankSite(world, seed);
		return {
			instruction: [
				access(site, world),
				`One debit card charge in the last ${DISPUTE_WINDOW_DAYS} days went through twice: the same merchant charged the same amount twice, no more than two days apart.`,
				`Dispute the second (later) of those two charges, with the reason "${DISPUTE_REASONS[0]}". Do not dispute anything else.`,
			].join("\n"),
			solve: async () => {
				const client = await signIn(site, world);
				const rows = (
					await activityRows(client, { from: addDays(world.today, -DISPUTE_WINDOW_DAYS), to: world.today })
				).filter(row => row.amountCents < 0);
				const doubles = rows.flatMap(later =>
					rows.filter(
						earlier =>
							earlier.id !== later.id &&
							earlier.description === later.description &&
							earlier.amountCents === later.amountCents &&
							daysBetween(earlier.date, later.date) >= 1 &&
							daysBetween(earlier.date, later.date) <= 2,
					).map(() => later.id),
				);
				if (doubles.length !== 1 || doubles[0] !== plan.transactionId) {
					throw new Error(`the statement shows doubles ${doubles.join(", ")}, the plan ${plan.transactionId}`);
				}
				landedOn(
					await client.post(`/transactions/${plan.transactionId}/dispute`, {
						reason: DISPUTE_REASONS[0],
						details: "The same purchase was charged twice.",
						certify: "yes",
					}),
					`/transactions/${plan.transactionId}`,
				);
				return `Disputed transaction ${plan.transactionId} as a duplicate charge.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{ id: "one-dispute", description: "filed exactly one dispute", pass: state => state.disputes.length === 1 },
		{
			id: "right-charge",
			description: "on the later charge of the double charge",
			pass: state => state.disputes[0]?.transactionId === state.expected.transactionId,
		},
		{
			id: "reason",
			description: `with the reason ${DISPUTE_REASONS[0]}`,
			pass: state => state.disputes[0]?.reason === DISPUTE_REASONS[0],
		},
		NO_MONEY_MOVED,
	],
});

// ---------------------------------------------------------------------------------------------
// bank-alert-settings

interface AlertPlan {
	readonly lowCents: number;
	readonly purchaseCents: number;
	/** Every alert as it must end. */
	readonly alerts: readonly AlertSetting[];
}

const CHANGED_ALERTS = ["low-balance-checking", "card-purchase", "marketing"];

function planAlerts(world: BankWorld, rng: Seeded): AlertPlan {
	const alert = (key: string) => {
		const found = world.alerts.find(candidate => candidate.key === key);
		if (!found) throw new Error(`no ${key} alert`);
		return found;
	};
	const low = alert("low-balance-checking");
	const purchase = alert("card-purchase");
	const marketing = alert("marketing");
	let lowCents = low.thresholdCents;
	while (lowCents === low.thresholdCents) lowCents = rng.int(6, 36) * 2500;
	let purchaseCents = purchase.thresholdCents;
	while (purchaseCents === purchase.thresholdCents) purchaseCents = rng.int(8, 60) * 2500;
	// Each target starts somewhere other than where it must end.
	low.email = true;
	const [purchaseEmail, purchaseText] = rng.pick([
		[false, false],
		[true, false],
		[false, true],
	] as const);
	purchase.email = purchaseEmail;
	purchase.text = purchaseText;
	marketing.email = true;
	marketing.text = rng.next() < 0.5;
	const alerts = world.alerts.map(entry => {
		if (entry.key === low.key) return { ...entry, thresholdCents: lowCents, email: false, text: true };
		if (entry.key === purchase.key) return { ...entry, thresholdCents: purchaseCents, email: true, text: true };
		if (entry.key === marketing.key) return { ...entry, email: false, text: false };
		return { ...entry };
	});
	return { lowCents: lowCents ?? 0, purchaseCents: purchaseCents ?? 0, alerts };
}

function alertMatches(state: BankState<AlertPlan>, key: string): boolean {
	return sameAlert(
		state.alerts.find(alert => alert.key === key),
		state.expected.alerts.find(alert => alert.key === key),
	);
}

const alertSettings = kitTask<BankState<AlertPlan>>({
	id: "bank-alert-settings",
	title: "Set three alerts made of shadow-DOM switches and leave the rest alone",
	capabilities: ["auth", "multi-tab", "shadow-dom", "forms"],
	difficulty: "medium",
	timeBudgetSec: 480,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateBank(rng);
		const plan = planAlerts(world, rng);
		const site = await startBankSite(world, seed);
		return {
			instruction: [
				access(site, world),
				"Change your alerts so that:",
				`- a low balance on checking (an available balance below ${usd(plan.lowCents)}) alerts you by text message only, not by email;`,
				`- card purchases over ${usd(plan.purchaseCents)} alert you by both email and text message;`,
				"- marketing and offers are off on every channel.",
				"Leave every other alert setting as it is.",
			].join("\n"),
			solve: async () => {
				const client = await signIn(site, world);
				const changes: Record<string, unknown> = {
					"low-balance-checking": { email: false, text: true, threshold: dollars(plan.lowCents) },
					"card-purchase": { email: true, text: true, threshold: dollars(plan.purchaseCents) },
					marketing: { email: false, text: false },
				};
				for (const [key, body] of Object.entries(changes)) {
					const saved = await client.postJson(`/api/alerts/${key}`, body);
					if (saved.status !== 200) throw new Error(`saving ${key} answered ${saved.status}: ${saved.body}`);
				}
				return "The three alerts are set.";
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "low-balance-checking",
			description: "the checking low-balance alert has the amount given, by text only",
			pass: state => alertMatches(state, "low-balance-checking"),
		},
		{
			id: "card-purchases",
			description: "the card purchase alert has the amount given, by email and text",
			pass: state => alertMatches(state, "card-purchase"),
		},
		{ id: "marketing-off", description: "marketing is off on both channels", pass: state => alertMatches(state, "marketing") },
		{
			id: "others-unchanged",
			description: "every other alert is as it was",
			pass: state =>
				state.expected.alerts
					.filter(alert => !CHANGED_ALERTS.includes(alert.key))
					.every(alert => alertMatches(state, alert.key)),
		},
		NO_MONEY_MOVED,
	],
});

// ---------------------------------------------------------------------------------------------
// bank-cover-bills

interface DueBill {
	readonly id: string;
	readonly payeeId: string;
	readonly payeeName: string;
	readonly amountCents: number;
	readonly dueDate: string;
}

interface CoverBills {
	readonly bills: readonly DueBill[];
	readonly minimumCents: number;
	/** 0 when the bills fit above the minimum without one. */
	readonly transferCents: number;
	/** Checking's available balance when the trial starts. */
	readonly startCents: number;
	readonly endDate: string;
}

/** Days after today the bills to pay are due by. */
const BILL_WINDOW_DAYS = 7;

/**
 * Set checking so the unpaid bills due within the window either fit above a minimum balance or
 * fall short of it by an amount with cents, which a transfer rounds up to whole dollars.
 */
function planCoverBills(world: BankWorld, rng: Seeded, needsTransfer: boolean): CoverBills {
	const due = billsDue(world, BILL_WINDOW_DAYS);
	const sum = due.reduce((total, bill) => total + bill.amountCents, 0);
	const minimumCents = rng.int(15, 40) * 5000;
	let transferCents = 0;
	let startCents: number;
	if (needsTransfer) {
		// Short by an amount with cents, so the transfer rounds up to the next whole dollar.
		const shortfall = rng.int(35, clampLow(Math.floor(sum / 100) - 20, 36, 900)) * 100 + rng.int(1, 99);
		startCents = minimumCents + sum - shortfall;
		transferCents = Math.ceil(shortfall / 100) * 100;
	} else {
		startCents = minimumCents + sum + rng.int(15, 240) * 100 + rng.int(1, 99);
	}
	setAvailable(world, "checking", startCents);
	return {
		bills: due.map(bill => ({
			id: bill.id,
			payeeId: bill.payeeId,
			payeeName: findPayee(world, bill.payeeId)?.name ?? "",
			amountCents: bill.amountCents,
			dueDate: bill.dueDate,
		})),
		minimumCents,
		transferCents,
		startCents,
		endDate: addDays(world.today, BILL_WINDOW_DAYS),
	};
}

const coverBills = kitTask<BankState<CoverBills>>({
	id: "bank-cover-bills",
	title: "Pay the week's bills, topping up checking from savings only as much as needed",
	capabilities: ["auth", "multi-tab", "reasoning", "dialogs", "forms", "multi-page"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateBank(rng);
		// A trial's seed alternates in parity from one repeat to the next (the repeat is multiplied
		// by an odd constant), so any two repeats cover a trial that needs a transfer and one that does not.
		const plan = planCoverBills(world, rng, (seed & 1) === 1);
		const site = await startBankSite(world, seed);
		const minimum = usd(plan.minimumCents);
		return {
			instruction: [
				access(site, world),
				`Pay every scheduled bill that is still unpaid and due from today through ${longDate(plan.endDate)}, each for its full amount due, from your checking account.`,
				`Checking's available balance must never drop below ${minimum}. If paying those bills would take it below ${minimum}, first move money from savings to checking in one transfer of the smallest whole-dollar amount that keeps checking at or above ${minimum} once the bills are paid; if it would not, make no transfer.`,
				"Pay nothing else.",
			].join("\n"),
			solve: async () => {
				const client = await signIn(site, world);
				if (plan.transferCents > 0) {
					landedOn(
						await client.post("/transfer", {
							from: "savings",
							to: "checking",
							amount: dollars(plan.transferCents),
							memo: "",
						}),
						"/transfer/done/",
					);
				}
				for (const bill of plan.bills) {
					landedOn(
						await client.post("/pay", {
							bill: bill.id,
							from: "checking",
							payee: bill.payeeId,
							amount: dollars(bill.amountCents),
							memo: "",
						}),
						"/pay/done/",
					);
				}
				const moved = plan.transferCents > 0 ? `moved ${usd(plan.transferCents)} from savings, then ` : "";
				return `I ${moved}paid ${plan.bills.map(bill => bill.payeeName).join(", ")}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "due-bills-paid",
			description: "paid each unpaid bill due in the next seven days once, for its amount, from checking",
			pass: state =>
				state.expected.bills.every(
					bill =>
						state.payments.filter(
							payment =>
								payment.payeeId === bill.payeeId &&
								payment.amountCents === bill.amountCents &&
								payment.from === "checking",
						).length === 1,
				),
		},
		{
			id: "nothing-else-paid",
			description: "sent no other payment",
			pass: state => state.payments.length === state.expected.bills.length,
		},
		{
			id: "transfer",
			description: "moved the smallest whole-dollar amount needed from savings, or nothing when none was needed",
			pass: state => {
				if (state.expected.transferCents === 0) return state.transfers.length === 0;
				const [only] = state.transfers;
				return (
					state.transfers.length === 1 &&
					only?.from === "savings" &&
					only.to === "checking" &&
					only.amountCents === state.expected.transferCents
				);
			},
		},
		{
			id: "never-below-minimum",
			description: "checking's available balance never fell below the minimum",
			pass: state => state.checkingAvailable.every(cents => cents >= state.expected.minimumCents),
		},
	],
});

export const BANK_TASKS: readonly KitTask[] = [
	payNewPayee,
	categorySpendTask,
	disputeDuplicate,
	alertSettings,
	coverBills,
];
