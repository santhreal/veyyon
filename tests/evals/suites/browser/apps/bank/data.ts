/**
 * Northwind Bank's world: a customer with a checking and a savings account, ninety days of
 * transactions ending on the bank's own date, payees, the scheduled bills of the current cycle,
 * alert settings, and the text messages already on the customer's phone. The balance, spending,
 * duplicate and due-bill rules here are the ones every page and every grader uses.
 */

import type { Seeded } from "../../../../engine/kit/seeded";

export type AccountId = "checking" | "savings";

export const ACCOUNT_IDS: readonly AccountId[] = ["checking", "savings"];

export interface Account {
	readonly id: AccountId;
	readonly name: string;
	/** Ten digits; pages show the last four. */
	readonly number: string;
	/** The balance before the earliest listed transaction, which no page shows. */
	openingCents: number;
}

export type TransactionKind = "card" | "ach" | "billpay" | "deposit" | "transfer" | "refund" | "interest";

export const KIND_LABELS: Readonly<Record<TransactionKind, string>> = {
	card: "Debit card purchase",
	ach: "Electronic payment",
	billpay: "Bill payment",
	deposit: "Direct deposit",
	transfer: "Transfer",
	refund: "Card refund",
	interest: "Interest",
};

export interface Transaction {
	readonly id: string;
	readonly account: AccountId;
	/** `YYYY-MM-DD`. */
	readonly date: string;
	readonly description: string;
	readonly category: string;
	/** Negative for money out, positive for money in. */
	amountCents: number;
	readonly status: "posted" | "pending";
	readonly kind: TransactionKind;
}

export interface Payee {
	readonly id: string;
	readonly name: string;
	readonly nickname: string;
	readonly accountNumber: string;
	readonly routingNumber: string;
	/** The category its bill payments are filed under. */
	readonly category: string;
	/** Present before the trial started. */
	readonly seeded: boolean;
}

export interface Bill {
	readonly id: string;
	readonly payeeId: string;
	readonly amountCents: number;
	readonly dueDate: string;
	paidOn: string | null;
}

export interface AlertSetting {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	/** Null for an alert without an amount. */
	thresholdCents: number | null;
	email: boolean;
	text: boolean;
}

export interface SeededSms {
	readonly sender: string;
	readonly body: string;
	/** How long before the trial started it arrived. */
	readonly ageMinutes: number;
}

export interface Customer {
	readonly name: string;
	readonly email: string;
	readonly username: string;
	readonly password: string;
	readonly phoneLast4: string;
	readonly cardLast4: string;
}

export interface BankWorld {
	/** The bank's date, `YYYY-MM-DD`: the last day its statements list. */
	readonly today: string;
	readonly customer: Customer;
	readonly accounts: readonly Account[];
	/** Newest first. */
	readonly transactions: Transaction[];
	readonly payees: Payee[];
	readonly bills: Bill[];
	readonly alerts: AlertSetting[];
	readonly sms: SeededSms[];
}

/** Days of history the accounts list, today included. */
export const HISTORY_DAYS = 90;
/** Card purchases and bill payments dated within this many days before today, or today, are pending. */
export const PENDING_DAYS = 4;
export const BANK_SENDER = "Northwind Bank";
export const DISPUTE_REASONS = [
	"Duplicate charge",
	"Unauthorized charge",
	"Incorrect amount",
	"Item not received",
	"Canceled subscription",
	"Other",
] as const;
/** The category a bill payment to a payee the customer added is filed under. */
export const NEW_PAYEE_CATEGORY = "Bill payment";

const DAY_MS = 86_400_000;
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function utc(iso: string): Date {
	return new Date(`${iso}T00:00:00Z`);
}

function isoOf(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
	return isoOf(new Date(utc(iso).getTime() + days * DAY_MS));
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
	return Math.round((utc(to).getTime() - utc(from).getTime()) / DAY_MS);
}

/** The same day of the month `months` months earlier, or that month's last day when it is shorter. */
export function monthsBefore(iso: string, months: number): string {
	const date = utc(iso);
	const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1));
	const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
	return isoOf(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date.getUTCDate(), last))));
}

/** `YYYY-MM` of the month before the one `iso` falls in. */
export function previousMonth(iso: string): string {
	return monthsBefore(`${iso.slice(0, 7)}-01`, 1).slice(0, 7);
}

/** The last day of a `YYYY-MM` month. */
export function lastDayOf(month: string): string {
	return addDays(monthsBefore(`${month}-01`, -1), -1);
}

/** `Jun 3, 2025`. */
export function shortDate(iso: string): string {
	const date = utc(iso);
	return `${(MONTHS[date.getUTCMonth()] ?? "").slice(0, 3)} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** `Tuesday, June 3, 2025`. */
export function longDate(iso: string): string {
	const date = utc(iso);
	return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** `May 2025` from `2025-05`. */
export function monthLabel(month: string): string {
	return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** `$1,234.56`, or `-$1,234.56`. */
export function usd(cents: number): string {
	return USD.format(cents / 100);
}

/** Cents from a dollar amount a form holds (`1,234.56`, `$75`), or null when it is not a positive amount. */
export function parseAmount(value: string): number | null {
	const plain = value.trim().replace(/^\$/, "").replaceAll(",", "");
	if (!/^\d+(\.\d{1,2})?$/.test(plain)) return null;
	const cents = Math.round(Number(plain) * 100);
	return cents > 0 ? cents : null;
}

export function last4(value: string): string {
	return value.slice(-4);
}

/** A string of `count` digits that does not start with 0. */
export function digits(rng: Seeded, count: number): string {
	let out = String(rng.int(1, 9));
	while (out.length < count) out += String(rng.int(0, 9));
	return out;
}

/** The ABA checksum: 3, 7 and 1 weights over the nine digits sum to a multiple of ten. */
export function routingValid(routing: string): boolean {
	if (!/^\d{9}$/.test(routing)) return false;
	const d = [...routing].map(Number);
	const sum = (at: number) => (d[at] ?? 0) + (d[at + 3] ?? 0) + (d[at + 6] ?? 0);
	return (3 * sum(0) + 7 * sum(1) + sum(2)) % 10 === 0;
}

/** A leading 0, seven random digits, and the one check digit (weight 1) that makes {@link routingValid} hold. */
export function randomRouting(rng: Seeded): string {
	const head = `0${digits(rng, 7)}`;
	for (let check = 0; ; check++) if (routingValid(`${head}${check}`)) return `${head}${check}`;
}

export function accountOf(world: Pick<BankWorld, "accounts">, id: AccountId): Account {
	const account = world.accounts.find(entry => entry.id === id);
	if (!account) throw new Error(`no ${id} account`);
	return account;
}

/** `Checking …4821`. */
export function accountLabel(world: Pick<BankWorld, "accounts">, id: AccountId): string {
	const account = accountOf(world, id);
	return `${account.name} …${last4(account.number)}`;
}

export function isAccountId(value: string | undefined): value is AccountId {
	return value === "checking" || value === "savings";
}

/** Opening balance plus every posted transaction. */
export function currentBalance(world: Pick<BankWorld, "accounts" | "transactions">, id: AccountId): number {
	return world.transactions.reduce(
		(sum, entry) => (entry.account === id && entry.status === "posted" ? sum + entry.amountCents : sum),
		accountOf(world, id).openingCents,
	);
}

/** The current balance less every pending debit; pending credits do not count until they post. */
export function availableBalance(world: Pick<BankWorld, "accounts" | "transactions">, id: AccountId): number {
	return world.transactions.reduce(
		(sum, entry) =>
			entry.account === id && entry.status === "pending" && entry.amountCents < 0 ? sum + entry.amountCents : sum,
		currentBalance(world, id),
	);
}

/** Set an account's opening balance so its available balance is `cents` now. */
export function setAvailable(world: BankWorld, id: AccountId, cents: number): void {
	const account = accountOf(world, id);
	account.openingCents += cents - availableBalance(world, id);
}

/**
 * What was spent on a category in a `YYYY-MM` month across both accounts: posted transactions
 * dated in the month, with refunds and other credits subtracting. Pending ones do not count.
 */
export function categorySpend(transactions: readonly Transaction[], category: string, month: string): number {
	return -transactions
		.filter(entry => entry.status === "posted" && entry.category === category && entry.date.startsWith(`${month}-`))
		.reduce((sum, entry) => sum + entry.amountCents, 0);
}

export interface DuplicatePair {
	readonly first: Transaction;
	readonly second: Transaction;
}

/** Card charges of the same merchant and amount dated at most two days apart, earlier one first. */
export function duplicateCharges(transactions: readonly Transaction[]): DuplicatePair[] {
	const charges = transactions
		.filter(entry => entry.kind === "card" && entry.amountCents < 0)
		.sort((a, b) => a.date.localeCompare(b.date));
	const pairs: DuplicatePair[] = [];
	for (let i = 0; i < charges.length; i++) {
		const first = charges[i] as Transaction;
		for (let j = i + 1; j < charges.length; j++) {
			const second = charges[j] as Transaction;
			if (daysBetween(first.date, second.date) > 2) break;
			if (first.description === second.description && first.amountCents === second.amountCents) {
				pairs.push({ first, second });
			}
		}
	}
	return pairs;
}

/** Unpaid bills due from today through `days` days after it. */
export function billsDue(world: Pick<BankWorld, "bills" | "today">, days: number): Bill[] {
	const end = addDays(world.today, days);
	return world.bills.filter(bill => bill.paidOn === null && bill.dueDate >= world.today && bill.dueDate <= end);
}

export function findPayee(world: Pick<BankWorld, "payees">, id: string): Payee | undefined {
	return world.payees.find(payee => payee.id === id);
}

export function codeText(code: string): string {
	return `${BANK_SENDER}: ${code} is your sign-in code. It expires in 5 minutes. Never share it; we will never call to ask for it.`;
}

// ---------------------------------------------------------------------------------------------
// Generation

export interface MerchantSpec {
	readonly name: string;
	readonly category: string;
	/** Dollars. */
	readonly min: number;
	readonly max: number;
	/** Relative frequency of a day's purchase. */
	readonly weight: number;
}

export const CARD_MERCHANTS: readonly MerchantSpec[] = [
	{ name: "Greenleaf Market", category: "Groceries", min: 18, max: 160, weight: 6 },
	{ name: "Harvest Grocers", category: "Groceries", min: 12, max: 120, weight: 5 },
	{ name: "Corner Pantry", category: "Groceries", min: 4, max: 40, weight: 4 },
	{ name: "Blue Door Bistro", category: "Dining", min: 22, max: 95, weight: 3 },
	{ name: "Taco Loco", category: "Dining", min: 8, max: 30, weight: 4 },
	{ name: "Maple Street Cafe", category: "Dining", min: 4, max: 18, weight: 6 },
	{ name: "Noodle House", category: "Dining", min: 12, max: 45, weight: 3 },
	{ name: "Fuel Stop", category: "Gas", min: 25, max: 70, weight: 3 },
	{ name: "Riverside Gas", category: "Gas", min: 20, max: 65, weight: 3 },
	{ name: "Northgate Outfitters", category: "Shopping", min: 25, max: 240, weight: 2 },
	{ name: "Bookworm Books", category: "Shopping", min: 9, max: 60, weight: 2 },
	{ name: "Pixel Electronics", category: "Shopping", min: 20, max: 400, weight: 1 },
	{ name: "Cineplex 8", category: "Entertainment", min: 12, max: 48, weight: 2 },
	{ name: "Arcade Alley", category: "Entertainment", min: 10, max: 40, weight: 1 },
	{ name: "Wellness Pharmacy", category: "Health", min: 6, max: 90, weight: 2 },
	{ name: "Lakeside Clinic", category: "Health", min: 25, max: 180, weight: 1 },
	{ name: "Hearth & Hardware", category: "Home", min: 8, max: 220, weight: 2 },
	{ name: "Garden Gate Nursery", category: "Home", min: 12, max: 140, weight: 1 },
	{ name: "SkyWay Airlines", category: "Travel", min: 120, max: 520, weight: 1 },
	{ name: "MetroRail", category: "Travel", min: 3, max: 30, weight: 2 },
];

interface Subscription {
	readonly name: string;
	readonly cents: readonly number[];
}

const SUBSCRIPTIONS: readonly Subscription[] = [
	{ name: "StreamFlix", cents: [1549, 1799, 2299] },
	{ name: "Tunely Music", cents: [1099, 1199] },
	{ name: "CloudVault Storage", cents: [299, 999] },
	{ name: "Ironworks Gym", cents: [3900, 4900, 5500] },
];

interface Biller {
	readonly name: string;
	readonly category: string;
	readonly nickname: string;
	/** Whether every bill is the same amount. */
	readonly fixed: boolean;
	/** Dollars. */
	readonly min: number;
	readonly max: number;
}

const BILLERS: readonly Biller[] = [
	{ name: "Oakmont Property Management", category: "Housing", nickname: "Rent", fixed: true, min: 1450, max: 2100 },
	{ name: "Brightline Electric", category: "Utilities", nickname: "", fixed: false, min: 58, max: 190 },
	{ name: "Clearwater Utility", category: "Utilities", nickname: "Water", fixed: false, min: 34, max: 96 },
	{ name: "Beacon Internet", category: "Utilities", nickname: "", fixed: true, min: 55, max: 90 },
	{ name: "Summit Mobile", category: "Phone", nickname: "", fixed: true, min: 45, max: 110 },
	{ name: "Safeguard Insurance", category: "Insurance", nickname: "Car insurance", fixed: true, min: 95, max: 240 },
	{ name: "Evergreen Auto Loan", category: "Loans", nickname: "Car loan", fixed: true, min: 260, max: 480 },
	{ name: "Northwind Visa", category: "Credit card", nickname: "Visa", fixed: false, min: 180, max: 1100 },
	{ name: "Riverbend Waste Services", category: "Utilities", nickname: "", fixed: true, min: 24, max: 48 },
];

const EMPLOYERS = ["Crestview Labs", "Halcyon Freight", "Brightwater Schools", "Juniper Health Partners"];
const FIRST = ["Avery", "Jordan", "Riley", "Morgan", "Casey", "Taylor", "Quinn", "Rowan", "Emerson", "Hayden"];
const LAST = ["Nakamura", "Okafor", "Lindqvist", "Moreau", "Castillo", "Haddad", "Novak", "Brennan", "Iverson", "Delgado"];

function weightedPick<T extends { readonly weight: number }>(rng: Seeded, items: readonly T[]): T {
	const total = items.reduce((sum, item) => sum + item.weight, 0);
	let roll = rng.next() * total;
	for (const item of items) {
		roll -= item.weight;
		if (roll < 0) return item;
	}
	return items[items.length - 1] as T;
}

/** Every day of the history, oldest first. */
function historyDates(world: Pick<BankWorld, "today">): string[] {
	const dates: string[] = [];
	for (let back = HISTORY_DAYS - 1; back >= 0; back--) dates.push(addDays(world.today, -back));
	return dates;
}

function uniqueId(prefix: string, rng: Seeded, taken: (id: string) => boolean): string {
	for (;;) {
		const id = `${prefix}${rng.int(10_000_000, 99_999_999)}`;
		if (!taken(id)) return id;
	}
}

export interface NewTransaction {
	readonly account: AccountId;
	readonly date: string;
	readonly description: string;
	readonly category: string;
	readonly amountCents: number;
	readonly kind: TransactionKind;
}

/** Add a transaction, pending or posted by its kind and date; the list is re-sorted by {@link sortTransactions}. */
export function addTransaction(world: BankWorld, rng: Seeded, fields: NewTransaction): Transaction {
	const pending =
		(fields.kind === "card" || fields.kind === "billpay") && daysBetween(fields.date, world.today) <= PENDING_DAYS;
	const entry: Transaction = {
		...fields,
		id: uniqueId("TX", rng, id => world.transactions.some(existing => existing.id === id)),
		status: pending ? "pending" : "posted",
	};
	world.transactions.push(entry);
	return entry;
}

/** Newest first; transactions of one day keep the order they were added in, reversed. */
export function sortTransactions(world: BankWorld): void {
	const order = new Map(world.transactions.map((entry, index) => [entry.id, index]));
	world.transactions.sort(
		(a, b) => b.date.localeCompare(a.date) || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0),
	);
}

/** A card purchase amount at a merchant, in cents, never a whole dollar. */
export function chargeCents(rng: Seeded, merchant: MerchantSpec): number {
	return rng.int(merchant.min, merchant.max - 1) * 100 + rng.int(1, 99);
}

export function addCardCharge(world: BankWorld, rng: Seeded, merchant: MerchantSpec, date: string, cents: number): Transaction {
	return addTransaction(world, rng, {
		account: "checking",
		date,
		description: merchant.name,
		category: merchant.category,
		amountCents: -cents,
		kind: "card",
	});
}

/**
 * Change the amount of one charge of every duplicate pair until none is left, except pairs whose
 * two charges are both in `keep`, which a planner placed on purpose.
 */
export function separateDuplicates(world: BankWorld, rng: Seeded, keep: ReadonlySet<string>): void {
	for (let round = 0; round < 100; round++) {
		const pairs = duplicateCharges(world.transactions).filter(
			pair => !(keep.has(pair.first.id) && keep.has(pair.second.id)),
		);
		if (pairs.length === 0) return;
		for (const { first, second } of pairs) {
			const moved = keep.has(second.id) ? first : second;
			moved.amountCents -= rng.int(11, 89);
		}
	}
	throw new Error("card charges kept repeating after 100 rounds of separation");
}

export function newPayeeId(world: Pick<BankWorld, "payees">, rng: Seeded): string {
	for (;;) {
		const id = `PY${rng.code(6)}`;
		if (!world.payees.some(payee => payee.id === id)) return id;
	}
}

function addPayroll(world: BankWorld, rng: Seeded): void {
	const employer = rng.pick(EMPLOYERS);
	const cents = rng.int(2050, 2650) * 100 + rng.int(0, 99);
	for (const date of historyDates(world)) {
		const day = Number(date.slice(8));
		if (day !== 1 && day !== 15) continue;
		addTransaction(world, rng, {
			account: "checking",
			date,
			description: `${employer} payroll`,
			category: "Income",
			amountCents: cents,
			kind: "deposit",
		});
	}
}

function addSavingsActivity(world: BankWorld, rng: Seeded): void {
	const checking = last4(accountOf(world, "checking").number);
	const savings = last4(accountOf(world, "savings").number);
	const monthly = rng.pick([250, 300, 400, 500]) * 100;
	for (const date of historyDates(world)) {
		if (date === world.today) continue;
		const day = Number(date.slice(8));
		if (day === 20) {
			const fields = { date, category: "Transfer", kind: "transfer" } as const;
			addTransaction(world, rng, { ...fields, account: "checking", description: `Transfer to Savings …${savings}`, amountCents: -monthly });
			addTransaction(world, rng, { ...fields, account: "savings", description: `Transfer from Checking …${checking}`, amountCents: monthly });
		}
		if (addDays(date, 1).endsWith("-01")) {
			addTransaction(world, rng, {
				account: "savings",
				date,
				description: "Interest paid",
				category: "Interest",
				amountCents: rng.int(420, 1890),
				kind: "interest",
			});
		}
	}
	// A few larger costs paid straight from savings.
	const payable = CARD_MERCHANTS.filter(merchant => ["Home", "Health", "Travel"].includes(merchant.category));
	for (let i = 0; i < 3; i++) {
		const merchant = rng.pick(payable);
		addTransaction(world, rng, {
			account: "savings",
			date: addDays(world.today, -rng.int(8, HISTORY_DAYS - 1)),
			description: merchant.name,
			category: merchant.category,
			amountCents: -rng.int(Math.max(60, merchant.min) * 100, (merchant.max + 200) * 100),
			kind: "ach",
		});
	}
}

function addSubscriptions(world: BankWorld, rng: Seeded): void {
	for (const subscription of SUBSCRIPTIONS) {
		const cents = rng.pick(subscription.cents);
		const day = rng.int(3, 27);
		for (const date of historyDates(world)) {
			if (Number(date.slice(8)) !== day) continue;
			addTransaction(world, rng, {
				account: "checking",
				date,
				description: subscription.name,
				category: "Subscriptions",
				amountCents: -cents,
				kind: "card",
			});
		}
	}
}

function addCardPurchases(world: BankWorld, rng: Seeded): void {
	for (const date of historyDates(world)) {
		const count = rng.pick([0, 1, 1, 2, 2, 2, 3, 3]);
		for (let i = 0; i < count; i++) {
			const merchant = weightedPick(rng, CARD_MERCHANTS);
			addCardCharge(world, rng, merchant, date, chargeCents(rng, merchant));
		}
	}
}

type BillRole = "due" | "paid-early" | "later" | "past";

/**
 * The billers are payees; each has one bill in the current cycle and a monthly payment history.
 * The cycle always holds three or four unpaid bills due within the next seven days, one bill in
 * that window already paid, two unpaid bills due after it, and the rest paid in the last week.
 */
function addBillers(world: BankWorld, rng: Seeded): void {
	const billers = rng.shuffle(BILLERS);
	const dueCount = rng.int(3, 4);
	const windowOffsets = rng.sample([1, 2, 3, 4, 5, 6, 7], dueCount + 1);
	const start = addDays(world.today, -(HISTORY_DAYS - 1));
	billers.forEach((biller, index) => {
		let role: BillRole = "past";
		let offset = rng.int(-6, -1);
		if (index < dueCount) {
			role = "due";
			offset = windowOffsets[index] as number;
		} else if (index === dueCount) {
			role = "paid-early";
			offset = windowOffsets[index] as number;
		} else if (index === dueCount + 1) {
			role = "later";
			offset = 8;
		} else if (index === dueCount + 2) {
			role = "later";
			offset = rng.int(11, 24);
		}
		const payee: Payee = {
			id: newPayeeId(world, rng),
			name: biller.name,
			nickname: biller.nickname,
			accountNumber: digits(rng, rng.int(8, 12)),
			routingNumber: randomRouting(rng),
			category: biller.category,
			seeded: true,
		};
		world.payees.push(payee);
		const fixedCents = rng.int(biller.min, biller.max) * 100 + (biller.max < 500 ? rng.pick([0, 99, 49, 18]) : 0);
		const amount = () => (biller.fixed ? fixedCents : rng.int(biller.min * 100, biller.max * 100));
		const pay = (date: string, cents: number) =>
			addTransaction(world, rng, {
				account: "checking",
				date,
				description: `Bill payment · ${biller.name}`,
				category: biller.category,
				amountCents: -cents,
				kind: "billpay",
			});
		const dueDate = addDays(world.today, offset);
		for (let back = 1; back <= 3; back++) {
			const earlier = monthsBefore(dueDate, back);
			if (earlier >= start) pay(earlier, amount());
		}
		const cents = amount();
		let paidOn: string | null = null;
		if (role === "past") paidOn = addDays(dueDate, -rng.int(0, 1));
		if (role === "paid-early") paidOn = addDays(world.today, -rng.int(1, 2));
		if (paidOn) pay(paidOn, cents);
		world.bills.push({ id: `BL${rng.int(1000, 9999)}${index}`, payeeId: payee.id, amountCents: cents, dueDate, paidOn });
	});
	world.bills.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function addPeople(world: BankWorld, rng: Seeded): void {
	const taken = new Set(world.customer.name.split(" "));
	for (let i = 0; i < 2; i++) {
		const first = rng.pick(FIRST.filter(name => !taken.has(name)));
		const lastName = rng.pick(LAST.filter(name => !taken.has(name)));
		taken.add(first);
		world.payees.push({
			id: newPayeeId(world, rng),
			name: `${first} ${lastName}`,
			nickname: "",
			accountNumber: digits(rng, 10),
			routingNumber: randomRouting(rng),
			category: NEW_PAYEE_CATEGORY,
			seeded: true,
		});
	}
}

function initialAlerts(world: BankWorld, rng: Seeded): AlertSetting[] {
	const checking = last4(accountOf(world, "checking").number);
	const savings = last4(accountOf(world, "savings").number);
	const coin = () => rng.next() < 0.5;
	return [
		{
			key: "low-balance-checking",
			label: `Low balance · Checking …${checking}`,
			description: "When the available balance of this account falls below the amount you set.",
			thresholdCents: rng.int(4, 20) * 2500,
			email: coin(),
			text: coin(),
		},
		{
			key: "low-balance-savings",
			label: `Low balance · Savings …${savings}`,
			description: "When the available balance of this account falls below the amount you set.",
			thresholdCents: rng.int(20, 80) * 5000,
			email: coin(),
			text: coin(),
		},
		{
			key: "card-purchase",
			label: "Card purchases",
			description: "When a debit card purchase is over the amount you set.",
			thresholdCents: rng.int(4, 40) * 2500,
			email: coin(),
			text: coin(),
		},
		{
			key: "withdrawal",
			label: "Withdrawals and transfers",
			description: "When a withdrawal or an outgoing transfer is over the amount you set.",
			thresholdCents: rng.int(4, 40) * 2500,
			email: coin(),
			text: coin(),
		},
		{
			key: "deposit",
			label: "Deposits",
			description: "When a deposit posts to any of your accounts.",
			thresholdCents: null,
			email: coin(),
			text: coin(),
		},
		{
			key: "bill-due",
			label: "Bill due reminders",
			description: "Three days before a scheduled bill is due.",
			thresholdCents: null,
			email: coin(),
			text: coin(),
		},
		{
			key: "security",
			label: "Security",
			description: "Sign-ins from a new device and changes to your profile.",
			thresholdCents: null,
			email: true,
			text: coin(),
		},
		{
			key: "marketing",
			label: "Marketing and offers",
			description: "Rates, promotions and product news from Northwind.",
			thresholdCents: null,
			email: coin(),
			text: coin(),
		},
	];
}

function phoneHistory(world: BankWorld, rng: Seeded): SeededSms[] {
	const oldCode = () => String(rng.int(100_000, 999_999));
	const day = 24 * 60;
	return [
		{ sender: BANK_SENDER, body: codeText(oldCode()), ageMinutes: rng.int(20, 30) * day },
		{ sender: BANK_SENDER, body: codeText(oldCode()), ageMinutes: rng.int(8, 12) * day },
		{
			sender: BANK_SENDER,
			body: `${BANK_SENDER}: your ${monthLabel(previousMonth(world.today))} statement is ready to view.`,
			ageMinutes: rng.int(2, 3) * day + rng.int(0, 600),
		},
		{ sender: BANK_SENDER, body: codeText(oldCode()), ageMinutes: rng.int(26, 70) * 60 },
		{
			sender: "Parcel Express",
			body: `Parcel Express: your package ${rng.code(8)} arrives today between 2pm and 6pm.`,
			ageMinutes: rng.int(1, 2) * day,
		},
		{
			sender: "RideShare",
			body: `Your RideShare pickup PIN is ${rng.int(1000, 9999)}.`,
			ageMinutes: rng.int(300, 900),
		},
		{
			sender: "Dr. Patel's Office",
			body: `Reminder: dental cleaning on Thursday at 9:30am. Reply C to confirm. Ref ${oldCode()}`,
			ageMinutes: rng.int(60, 240),
		},
		{ sender: "Mom", body: "Are you coming on Sunday? Call me when you can.", ageMinutes: rng.int(5, 50) },
	];
}

/** A customer, two accounts, ninety days of history, payees, the bills of this cycle, alerts and a phone. */
export function generateBank(rng: Seeded): BankWorld {
	const month = String(rng.int(4, 12)).padStart(2, "0");
	const today = `2025-${month}-0${rng.int(2, 3)}`;
	const first = rng.pick(FIRST);
	const lastName = rng.pick(LAST);
	const checkingNumber = digits(rng, 10);
	let savingsNumber = digits(rng, 10);
	while (last4(savingsNumber) === last4(checkingNumber)) savingsNumber = digits(rng, 10);
	const world: BankWorld = {
		today,
		customer: {
			name: `${first} ${lastName}`,
			email: `${first}.${lastName}@example.test`.toLowerCase(),
			username: `${first}${lastName}${rng.int(10, 99)}`.toLowerCase(),
			password: `not-a-real-${rng.code(6).toLowerCase()}`,
			phoneLast4: String(rng.int(1000, 9999)),
			cardLast4: String(rng.int(1000, 9999)),
		},
		accounts: [
			{ id: "checking", name: "Checking", number: checkingNumber, openingCents: 0 },
			{ id: "savings", name: "Savings", number: savingsNumber, openingCents: 0 },
		],
		transactions: [],
		payees: [],
		bills: [],
		alerts: [],
		sms: [],
	};
	addPayroll(world, rng);
	addSubscriptions(world, rng);
	addCardPurchases(world, rng);
	addSavingsActivity(world, rng);
	addBillers(world, rng);
	addPeople(world, rng);
	world.payees.sort((a, b) => a.name.localeCompare(b.name));
	separateDuplicates(world, rng, new Set());
	sortTransactions(world);
	setAvailable(world, "checking", rng.int(2600, 5400) * 100 + rng.int(0, 99));
	setAvailable(world, "savings", rng.int(9000, 17000) * 100 + rng.int(0, 99));
	world.alerts.push(...initialAlerts(world, rng));
	world.sms.push(...phoneHistory(world, rng));
	return world;
}
