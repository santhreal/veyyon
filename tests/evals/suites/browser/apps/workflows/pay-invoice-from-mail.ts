/**
 * workflow-pay-invoice-from-mail: one invoice carried from Parcel Mail to Northwind Bank and back.
 *
 * A vendor emails an invoice naming the account it is paid into; a later email in the same
 * conversation corrects the amount due and moves the vendor to a new account, whose numbers appear
 * only in that email. The bank already has the vendor as a payee on the old account. The invoice is
 * paid at the bank, and the reply to the vendor's latest email states the confirmation number the
 * bank shows only once the payment is sent.
 *
 * Every step has a decoy: the original email's amount and account, the payee on file, a coworker's
 * forward of the uncorrected invoice, a vendor of a look-alike name with an open invoice of swapped
 * digits and a newer bank-details email of its own, and another vendor's open invoice with a payee
 * on file. The grade reads the account and amount the bank's payment reached, not the route to it.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerHasText, answerNamesOnly } from "../../../../engine/kit/checks";
import { FormClient } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	addTransaction,
	availableBalance,
	BANK_SENDER,
	type BankWorld,
	digits,
	generateBank,
	last4,
	NEW_PAYEE_CATEGORY,
	newPayeeId,
	randomRouting,
	setAvailable,
	sortTransactions,
} from "../bank/data";
import { type PhoneThread, threadSlug } from "../bank/phone";
import { type BankSite, type BankSnapshot, type Payment, startBankSite } from "../bank/site";
import {
	addContact,
	addDays,
	addMessage,
	composePrefill,
	findMessage,
	firstName,
	forwardBlock,
	fullDate,
	generateMail,
	type MailWorld,
	monthName,
	newPerson,
	type Person,
	type SentMail,
	timeOn,
} from "../mail/data";
import { type MailSnapshot, startMailSite } from "../mail/site";

interface Company {
	readonly company: string;
	readonly domain: string;
	readonly work: string;
}

/** A vendor, and a company whose name starts the same way. */
const VENDORS: readonly (readonly [Company, Company])[] = [
	[
		{ company: "Kestrel Print Co.", domain: "kestrelprint.test", work: "print runs" },
		{ company: "Kestrel Printworks", domain: "kestrel-printworks.test", work: "banner printing" },
	],
	[
		{ company: "Ironleaf Logistics", domain: "ironleaf-logistics.test", work: "freight handling" },
		{ company: "Ironleaf Logistic Services", domain: "ironleaf-services.test", work: "warehouse storage" },
	],
	[
		{ company: "Tidewater Facilities", domain: "tidewater-facilities.test", work: "cleaning services" },
		{ company: "Tidewater Facility Care", domain: "tidewatercare.test", work: "window cleaning" },
	],
	[
		{ company: "Copperline Networks", domain: "copperline.test", work: "network support" },
		{ company: "Copperline Networking", domain: "copperline-networking.test", work: "cabling work" },
	],
	[
		{ company: "Ashgrove Design Studio", domain: "ashgrove-studio.test", work: "design work" },
		{ company: "Ashgrove Designs", domain: "ashgrovedesigns.test", work: "product photography" },
	],
];

/** Vendors unrelated to the one paid; one of them has an invoice open too. */
const OTHER_VENDORS: readonly Company[] = [
	{ company: "Marlow Catering", domain: "marlowcatering.test", work: "event catering" },
	{ company: "Saltmarsh Signs", domain: "saltmarsh-signs.test", work: "signage" },
	{ company: "Fernway Plumbing", domain: "fernway-plumbing.test", work: "plumbing repairs" },
	{ company: "Quillon Translation", domain: "quillon.test", work: "translation work" },
];

/** New worlds a seed may be drawn into before the planner gives up on it. */
const MAX_DRAWS = 32;

interface InvoicePayment {
	readonly company: string;
	readonly invoice: string;
	/** The invoice's conversation, which the correction continues. */
	readonly threadId: string;
	/** The vendor's latest email about the invoice: the correction. */
	readonly correctionId: string;
	readonly correctionSender: string;
	/** What the correction set, and what the original email said. */
	readonly amountCents: number;
	readonly staleAmountCents: number;
	/** The account the correction asks to be paid into. */
	readonly accountNumber: string;
	readonly routingNumber: string;
	/** The account the original email named, which the vendor's payee on file holds. */
	readonly oldAccountNumber: string;
	/** The look-alike vendor's account on file, and the new one its own email announced. */
	readonly lookalikeAccounts: readonly string[];
	/** The account on file of the vendor whose other invoice is open. */
	readonly otherVendorAccount: string;
}

interface InvoiceState {
	readonly mail: MailSnapshot;
	readonly bank: BankSnapshot;
	readonly expected: InvoicePayment;
}

interface Worlds {
	readonly mail: MailWorld;
	readonly bank: BankWorld;
	readonly plan: InvoicePayment;
}

/** `$4,812.50` from cents. */
function dollars(cents: number): string {
	const [whole, fraction] = (cents / 100).toFixed(2).split(".") as [string, string];
	return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

/** An account number as an invoice prints it: `4821-0093-7765`. */
function grouped(account: string): string {
	return account.replaceAll(/(\d{4})(?=\d)/g, "$1-");
}

interface PayTo {
	readonly company: string;
	readonly routing: string;
	readonly account: string;
}

function payToLines(payTo: PayTo): string {
	return `Account name: ${payTo.company}\nRouting number: ${payTo.routing}\nAccount number: ${payTo.account}`;
}

function invoiceBody(
	to: string,
	invoice: string,
	work: string,
	cents: number,
	due: string,
	signer: Person,
	company: string,
	payTo: PayTo | null,
): string {
	const payment = payTo
		? `Please pay by bank transfer to our account:\n${payToLines(payTo)}`
		: "Payment can be made by bank transfer to the account on file.";
	return `Hello ${to},\n\nPlease find attached invoice ${invoice} for ${work}.\n\nAmount due: ${dollars(cents)}\nDue date: ${fullDate(due)}\n\n${payment}\n\nReply to this email with any questions about the invoice.\n\n${signer.name}\n${company}`;
}

/** The month before the one `day` falls in, by name. */
function serviceMonth(day: string): string {
	return monthName((new Date(`${day}T12:00:00Z`).getUTCMonth() + 11) % 12);
}

/** A five-digit invoice number whose last two digits differ, so swapping them names another invoice. */
function invoiceDigits(rng: Seeded): string {
	for (;;) {
		const value = String(rng.int(10000, 99999));
		if (value[3] !== value[4]) return value;
	}
}

/** The bank's customer as the mailbox's owner, or null when a payee already has that name. */
function ownedBy(bank: BankWorld, mail: MailWorld, rng: Seeded): BankWorld | null {
	const { name, email } = mail.account;
	if (bank.payees.some(payee => payee.name === name)) return null;
	const username = `${name.replaceAll(" ", "")}${rng.int(10, 99)}`.toLowerCase();
	return { ...bank, customer: { ...bank.customer, name, email, username } };
}

/**
 * Plant the invoice, its correction and the decoys in the mailbox, and the vendors' payees on file
 * in the bank: every amount differs from every other, and every account a page shows ends in digits
 * no other payee's account ends in.
 */
function plantInvoice(mail: MailWorld, bank: BankWorld, rng: Seeded): InvoicePayment {
	const [vendor, lookalike] = rng.pick(VENDORS);
	const other = rng.pick(OTHER_VENDORS);
	const user: Person = { name: mail.account.name, email: mail.account.email };
	const userFirst = firstName(user);

	const number = invoiceDigits(rng);
	const invoice = `INV-${number}`;
	const lookalikeInvoice = `INV-${number.slice(0, 3)}${number[4]}${number[3]}`;
	let otherInvoice = `INV-${invoiceDigits(rng)}`;
	while (otherInvoice === invoice || otherInvoice === lookalikeInvoice) otherInvoice = `INV-${invoiceDigits(rng)}`;

	let amounts: number[] = [];
	while (new Set(amounts).size !== 7) {
		const stale = rng.int(900, 1900) * 100 + rng.pick([0, 25, 50, 75]);
		amounts = [
			stale,
			stale + rng.pick([-1, 1]) * rng.int(4, 24) * 2500,
			rng.int(300, 2400) * 100 + rng.int(0, 99),
			rng.int(300, 2400) * 100 + rng.int(0, 99),
			rng.int(150, 900) * 100 + rng.int(0, 99),
			rng.int(150, 900) * 100 + rng.int(0, 99),
			rng.int(150, 900) * 100 + rng.int(0, 99),
		];
	}
	const [staleAmountCents, amountCents, lookalikeCents, otherCents, vendorPaid, lookalikePaid, otherPaid] =
		amounts as [number, number, number, number, number, number, number];

	const endings = new Set(bank.payees.map(payee => last4(payee.accountNumber)));
	const account = (length: number) => {
		for (;;) {
			const value = digits(rng, length);
			if (!endings.has(last4(value))) {
				endings.add(last4(value));
				return value;
			}
		}
	};
	const oldAccount = account(rng.int(9, 12));
	const newAccount = account(12);
	const lookalikeOld = account(10);
	const lookalikeNew = account(12);
	const otherAccount = account(10);
	const oldRouting = randomRouting(rng);
	let newRouting = randomRouting(rng);
	while (newRouting === oldRouting) newRouting = randomRouting(rng);

	// The bank: each vendor is a payee on the account it was paid into before, paid last month.
	const available = availableBalance(bank, "checking");
	const onFile = (company: string, accountNumber: string, routingNumber: string, paidCents: number) => {
		bank.payees.push({
			id: newPayeeId(bank, rng),
			name: company,
			nickname: "",
			accountNumber,
			routingNumber,
			category: NEW_PAYEE_CATEGORY,
			seeded: true,
		});
		addTransaction(bank, rng, {
			account: "checking",
			date: addDays(bank.today, -rng.int(20, 60)),
			description: `Bill payment · ${company}`,
			category: NEW_PAYEE_CATEGORY,
			amountCents: -paidCents,
			kind: "billpay",
		});
	};
	onFile(vendor.company, oldAccount, oldRouting, vendorPaid);
	onFile(lookalike.company, lookalikeOld, randomRouting(rng), lookalikePaid);
	onFile(other.company, otherAccount, randomRouting(rng), otherPaid);
	bank.payees.sort((a, b) => a.name.localeCompare(b.name));
	sortTransactions(bank);
	setAvailable(bank, "checking", available);

	// The mailbox: the invoice, a coworker's forward of it, and the correction, in that order.
	const billing = addContact(mail, newPerson(mail, rng, vendor.domain));
	const accounts: Person = { name: `${vendor.company} Accounts`, email: `accounts@${vendor.domain}` };
	const day = addDays("2025-05-19", rng.int(0, 10));
	const due = addDays(day, 30);
	const subject = `Invoice ${invoice} for ${serviceMonth(day)} ${vendor.work}`;
	const original = addMessage(mail, rng, {
		from: billing,
		to: [user],
		subject,
		body: invoiceBody(
			userFirst,
			invoice,
			`${vendor.work} in ${serviceMonth(day)}`,
			staleAmountCents,
			due,
			billing,
			vendor.company,
			{ company: vendor.company, routing: oldRouting, account: oldAccount },
		),
		date: timeOn(rng, day, 8, 17),
		folder: rng.next() < 0.6 ? "archive" : "inbox",
		labels: rng.next() < 0.5 ? ["Finance"] : [],
		attachments: [{ name: `${invoice}.pdf`, size: rng.int(40, 180) * 1024 }],
	});
	const coworker = rng.pick(mail.contacts.filter(contact => contact.email.endsWith(`@${mail.homeDomain}`)));
	addMessage(mail, rng, {
		from: coworker,
		to: [user],
		subject: `Fwd: ${subject}`,
		body: `Hi ${userFirst},\n\nThis landed with me by mistake, can you take care of it?\n\n${firstName(coworker)}\n\n${forwardBlock(original)}`,
		date: timeOn(rng, addDays(day, rng.int(1, 3)), 8, 17),
		folder: "inbox",
		read: rng.next() < 0.5,
	});
	const correctionDay = addDays(day, rng.int(6, 9));
	const correction = addMessage(mail, rng, {
		from: accounts,
		to: [user],
		subject: `Re: ${subject}`,
		threadId: original.threadId,
		body: `Hello ${userFirst},\n\nWe need to correct invoice ${invoice}: one line was billed incorrectly. The corrected amount due is ${dollars(amountCents)}; the due date stays ${fullDate(due)}.\n\nWe have also moved our banking, and payments to our old account ending ${last4(oldAccount)} will be returned. Please pay this invoice into our new account:\n${payToLines({ company: vendor.company, routing: newRouting, account: grouped(newAccount) })}\n\nPlease disregard the amount and the bank details in the original email; the invoice number stays the same.\n\nThank you,\n${vendor.company} Accounts`,
		date: timeOn(rng, correctionDay, 8, 17),
		folder: "inbox",
		read: false,
	});

	// A vendor of a look-alike name: an open invoice of swapped digits, and later, new bank details.
	const lookalikeBilling = addContact(mail, newPerson(mail, rng, lookalike.domain));
	const lookalikeDay = addDays(day, rng.int(-6, 3));
	addMessage(mail, rng, {
		from: lookalikeBilling,
		to: [user],
		subject: `Invoice ${lookalikeInvoice} for ${serviceMonth(lookalikeDay)} ${lookalike.work}`,
		body: invoiceBody(
			userFirst,
			lookalikeInvoice,
			`${lookalike.work} in ${serviceMonth(lookalikeDay)}`,
			lookalikeCents,
			addDays(lookalikeDay, 30),
			lookalikeBilling,
			lookalike.company,
			null,
		),
		date: timeOn(rng, lookalikeDay, 8, 17),
		folder: "inbox",
		attachments: [{ name: `${lookalikeInvoice}.pdf`, size: rng.int(40, 180) * 1024 }],
	});
	addMessage(mail, rng, {
		from: { name: `${lookalike.company} Accounts`, email: `accounts@${lookalike.domain}` },
		to: [user],
		subject: `New bank details for ${lookalike.company}`,
		body: `Hello ${userFirst},\n\nWe have moved our banking. Please pay every ${lookalike.company} invoice, including ${lookalikeInvoice}, into our new account; payments to our old account ending ${last4(lookalikeOld)} will be returned.\n${payToLines({ company: lookalike.company, routing: randomRouting(rng), account: grouped(lookalikeNew) })}\n\nThank you,\n${lookalike.company} Accounts`,
		date: timeOn(rng, addDays(correctionDay, rng.int(1, 5)), 8, 17),
		folder: "inbox",
		read: false,
	});

	// Another vendor's invoice, open and payable to its account on file.
	const otherBilling = addContact(mail, newPerson(mail, rng, other.domain));
	const otherDay = addDays(day, rng.int(2, 12));
	addMessage(mail, rng, {
		from: otherBilling,
		to: [user],
		subject: `Invoice ${otherInvoice} for ${serviceMonth(otherDay)} ${other.work}`,
		body: invoiceBody(
			userFirst,
			otherInvoice,
			`${other.work} in ${serviceMonth(otherDay)}`,
			otherCents,
			addDays(otherDay, 30),
			otherBilling,
			other.company,
			null,
		),
		date: timeOn(rng, otherDay, 8, 17),
		folder: "inbox",
		labels: rng.next() < 0.5 ? ["Finance"] : [],
		attachments: [{ name: `${otherInvoice}.pdf`, size: rng.int(40, 180) * 1024 }],
	});

	return {
		company: vendor.company,
		invoice,
		threadId: original.threadId,
		correctionId: correction.id,
		correctionSender: accounts.email,
		amountCents,
		staleAmountCents,
		accountNumber: newAccount,
		routingNumber: newRouting,
		oldAccountNumber: oldAccount,
		lookalikeAccounts: [lookalikeOld, lookalikeNew],
		otherVendorAccount: otherAccount,
	};
}

/**
 * The trial's worlds, each application's generated from its own stream of the trial seed. A draw
 * whose bank already has a payee of the mailbox owner's name is drawn again.
 */
function planWorlds(seed: number): Worlds {
	for (let draw = 0; draw < MAX_DRAWS; draw++) {
		const root = new Seeded((seed ^ Math.imul(draw + 1, 0x85ebca6b)) >>> 0);
		const stream = () => new Seeded(Math.floor(root.next() * 4_294_967_296));
		const mail = generateMail(stream());
		const bank = ownedBy(generateBank(stream()), mail, root);
		if (!bank) continue;
		return { mail, bank, plan: plantInvoice(mail, bank, stream()) };
	}
	throw new Error(`no draw of seed ${seed} gave the bank's customer a name no payee has`);
}

/** Sign in to the bank as a person does: the password, then the code the phone receives after it. */
async function signInToBank(site: BankSite, world: BankWorld): Promise<FormClient> {
	const phone = new FormClient(site.phoneOrigin);
	const thread = async () =>
		JSON.parse((await phone.get(`/api/conversations/${threadSlug(BANK_SENDER)}`)).body) as PhoneThread;
	const seen = (await thread()).messages.at(-1)?.id ?? 0;
	const client = new FormClient(site.origin);
	const signin = await client.post("/signin", {
		username: world.customer.username,
		password: world.customer.password,
	});
	if (new URL(signin.url).pathname !== "/signin/verify") throw new Error(`the password was refused: ${signin.url}`);
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

async function signInToMail(origin: string, world: MailWorld): Promise<FormClient> {
	const client = new FormClient(origin);
	const { email, password } = world.account;
	const response = await client.post("/signin", { email, password, next: "/mail/inbox" });
	if (!response.url.endsWith("/mail/inbox")) throw new Error(`signing in failed; it answered ${response.url}`);
	return client;
}

// ---------------------------------------------------------------------------------------------
// Grading

function onlySent(state: InvoiceState): SentMail | undefined {
	return state.mail.sent.length === 1 ? state.mail.sent[0] : undefined;
}

/**
 * What the account itself wrote in a message: quoted lines and the `On … wrote:` line dropped, and
 * nothing from a forwarded-message header on.
 */
function ownText(body: string): string {
	const lines: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		if (/^\s*-{3,}\s*forwarded message/i.test(line)) break;
		if (/^\s*>/.test(line) || /^\s*on .+ wrote:\s*$/i.test(line)) continue;
		lines.push(line);
	}
	return lines.join("\n");
}

/** Whether the payment reached the account number and routing number the correction gave. */
function reachesCorrected(state: InvoiceState, payment: Payment): boolean {
	const payee = state.bank.payees.find(entry => entry.id === payment.payeeId);
	return payee?.accountNumber === state.expected.accountNumber && payee.routingNumber === state.expected.routingNumber;
}

/** Whether any payment reached a payee holding one of the account numbers. */
function paidInto(state: InvoiceState, accounts: readonly string[]): boolean {
	return state.bank.payments.some(payment => {
		const account = state.bank.payees.find(payee => payee.id === payment.payeeId)?.accountNumber;
		return account !== undefined && accounts.includes(account);
	});
}

/** The one payment that reached the corrected account; none when no payment or several did. */
function correctedPayment(state: InvoiceState): Payment | undefined {
	const reached = state.bank.payments.filter(payment => reachesCorrected(state, payment));
	return reached.length === 1 ? reached[0] : undefined;
}

/**
 * Whether the text names a confirmation number such as `P4821937` as a whole term, with or without
 * a hyphen or space between its letters and its digits.
 */
function namesConfirmation(text: string, id: string): boolean {
	const parts = /^([A-Z]+)(\d+)$/i.exec(id);
	if (!parts) return answerHasText(text, id);
	return new RegExp(`(?<![\\p{L}\\p{N}])${parts[1]}[-\\s]?${parts[2]}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** Whether the text states the corrected payment's confirmation number and no other the bank gave. */
function statesConfirmation(state: InvoiceState, text: string): boolean {
	const payment = correctedPayment(state);
	if (!payment) return false;
	const others = [
		...state.bank.payments.map(entry => entry.id),
		...state.bank.transfers.map(entry => entry.id),
		...state.bank.disputes.map(entry => entry.id),
	];
	return answerNamesOnly(text, payment.id, others, namesConfirmation);
}

export const payInvoiceFromMailTask: KitTask = kitTask<InvoiceState>({
	id: "workflow-pay-invoice-from-mail",
	title: "Pay a vendor's corrected invoice at the bank and reply with the confirmation number",
	capabilities: [
		"workflow",
		"auth",
		"multi-tab",
		"search-filter",
		"reading",
		"reasoning",
		"forms",
		"shadow-dom",
		"dialogs",
	],
	difficulty: "expert",
	timeBudgetSec: 1200,
	async start({ seed }) {
		const { mail, bank, plan } = planWorlds(seed);
		const mailSite = await startMailSite(mail, seed);
		const bankSite = await startBankSite(bank, seed).catch(async (error: unknown) => {
			await mailSite.close();
			throw error;
		});
		return {
			instruction: [
				`Parcel Mail is a webmail service at ${mailSite.origin}. Sign in with email ${mail.account.email} and password ${mail.account.password}.`,
				`Northwind Bank's online banking is at ${bankSite.origin}. Sign in with username ${bank.customer.username} and password ${bank.customer.password}. After the password, the bank texts a one-time code to your phone; your phone's Messages app is at ${bankSite.phoneOrigin}.`,
				`${plan.company} emailed you invoice ${plan.invoice}. Pay it through Northwind Bank: the amount currently due on it, into the bank account ${plan.company} currently asks to be paid into.`,
				`Then reply to ${plan.company}'s latest email about that invoice, in that email's conversation, stating the confirmation number the bank gave for the payment.`,
				"Pay nothing else and send no other email. When you are done, answer with the confirmation number alone.",
			].join("\n"),
			solve: async () => {
				const bankClient = await signInToBank(bankSite, bank);
				const added = await bankClient.postJson("/api/payees", {
					name: plan.company,
					nickname: "",
					accountNumber: plan.accountNumber,
					routingNumber: plan.routingNumber,
				});
				const payee: unknown = JSON.parse(added.body);
				if (added.status !== 200 || typeof payee !== "object" || payee === null || !("id" in payee)) {
					throw new Error(`the payee was refused: ${added.body}`);
				}
				const paid = await bankClient.post("/pay", {
					bill: "",
					from: "checking",
					payee: String(payee.id),
					amount: (plan.amountCents / 100).toFixed(2),
					memo: plan.invoice,
				});
				const confirmation = /Confirmation <strong>([A-Z0-9]+)<\/strong>/.exec(paid.body)?.[1];
				if (!confirmation) throw new Error(`the payment was not sent; the bank answered ${paid.url}`);

				const mailClient = await signInToMail(mailSite.origin, mail);
				const correction = findMessage(mail, plan.correctionId);
				if (!correction) throw new Error(`message ${plan.correctionId} is not in the mailbox`);
				const prefill = composePrefill(mail, correction, "reply");
				const sent = await mailClient.post("/compose/send", {
					mode: "reply",
					source: correction.id,
					to: prefill.to.map(person => person.email).join(","),
					cc: prefill.cc.map(person => person.email).join(","),
					subject: prefill.subject,
					body: `Hello,\n\nInvoice ${plan.invoice} is paid: ${dollars(plan.amountCents)} to your account ending ${last4(plan.accountNumber)}. The bank's confirmation number is ${confirmation}.${prefill.body}`,
					attachments: "",
				});
				if (!sent.url.includes("notice=sent")) throw new Error(`the reply was not sent; it answered ${sent.url}`);
				return confirmation;
			},
			finish: async () => {
				const [mailState, bankState] = await Promise.all([mailSite.finish(), bankSite.finish()]);
				return { mail: mailState, bank: bankState, expected: plan };
			},
		};
	},
	checks: [
		{
			id: "one-payment",
			description: "the bank sent exactly one payment",
			pass: state => state.bank.payments.length === 1,
		},
		{
			id: "paid-corrected-account",
			description: "a payment reached the account and routing number the vendor's correction gave",
			pass: state => correctedPayment(state) !== undefined,
		},
		{
			id: "corrected-amount",
			description: "the payment to the corrected account is for the corrected amount, not the original one",
			pass: state => correctedPayment(state)?.amountCents === state.expected.amountCents,
		},
		{
			id: "old-account-unpaid",
			description: "no payment reached the vendor's old account, the payee already on file",
			pass: state => !paidInto(state, [state.expected.oldAccountNumber]),
		},
		{
			id: "lookalike-unpaid",
			description: "no payment reached the vendor of the look-alike name, on its old account or its new one",
			pass: state => !paidInto(state, state.expected.lookalikeAccounts),
		},
		{
			id: "other-invoice-unpaid",
			description: "no payment reached the other vendor whose invoice is open",
			pass: state => !paidInto(state, [state.expected.otherVendorAccount]),
		},
		{
			id: "nothing-else-paid",
			description: "every payment went to the corrected account, and no money was transferred",
			pass: state =>
				state.bank.payments.every(payment => reachesCorrected(state, payment)) && state.bank.transfers.length === 0,
		},
		{
			id: "one-email-sent",
			description: "sent exactly one email",
			pass: state => state.mail.sent.length === 1,
		},
		{
			id: "reply-to-vendor",
			description: "the email goes to the sender of the vendor's latest email about the invoice, and nobody else",
			pass: state => {
				const recipients = new Set([...(onlySent(state)?.to ?? []), ...(onlySent(state)?.cc ?? [])]);
				return recipients.size === 1 && recipients.has(state.expected.correctionSender);
			},
		},
		{
			id: "in-invoice-conversation",
			description: "the email is a reply in the invoice's conversation",
			pass: state => {
				const mail = onlySent(state);
				return mail?.threadId === state.expected.threadId && (mail.mode === "reply" || mail.mode === "replyall");
			},
		},
		{
			id: "reply-states-confirmation",
			description: "the reply states the confirmation number of the payment to the corrected account, and no other",
			pass: state => statesConfirmation(state, ownText(onlySent(state)?.body ?? "")),
		},
		{
			id: "answer-states-confirmation",
			description: "the answer is that confirmation number, and no other",
			pass: (state, answer) => statesConfirmation(state, answer),
		},
	],
});
