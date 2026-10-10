/**
 * PayBox: the payment provider Skyway's checkout embeds as a frame from its own origin.
 *
 * The frame collects the card on PayBox's origin, exchanges it for a single-use token, and posts
 * the token to the parent window with `postMessage`. Skyway's server charges the token through
 * PayBox's charge endpoint, and PayBox records the charge. The card never reaches Skyway, so a
 * page script on Skyway's origin cannot read or fill the card fields: they are in another origin's
 * document.
 */

import type { Seeded } from "../../../../engine/kit/seeded";
import {
	escapeHtml,
	type HostedSite,
	hostSite,
	html,
	json,
	jsonBody,
	type SiteRequest,
	type SiteResponse,
	text,
} from "../../../../engine/kit/web-host";
import { money } from "../../ui";
import { scriptJson } from "./scripts";

/** A charge PayBox made for the merchant. */
export interface Charge {
	readonly id: string;
	readonly amountCents: number;
	readonly last4: string;
	/** Paid with the card PayBox keeps for the customer rather than one typed in. */
	readonly savedCard: boolean;
	readonly description: string;
}

export interface TestCard {
	/** Sixteen digits in groups of four. */
	readonly number: string;
	/** `MM/YY`. */
	readonly expiry: string;
	readonly cvc: string;
	readonly name: string;
}

/** What Skyway's server presents to charge a token. */
export const MERCHANT_KEY = "not-a-real-merchant-key";

export interface PayBox extends HostedSite {
	readonly charges: readonly Charge[];
}

export interface PayBoxOptions {
	/** The site's date: a card that expired before it is refused. */
	readonly today: string;
	/** The one customer PayBox keeps a card for, and that card's last four digits. */
	readonly customer: string;
	readonly savedCardLast4: string;
	readonly rng: Seeded;
}

interface Token {
	readonly last4: string;
	readonly savedCard: boolean;
	used: boolean;
}

function luhnSum(digits: string): number {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let digit = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
	}
	return sum;
}

/** A Visa-shaped test number that passes the Luhn check, with an expiry after `today`. */
export function testCard(rng: Seeded, today: string, name: string, avoidLast4: string): TestCard {
	for (;;) {
		let body = "4";
		while (body.length < 15) body += String(rng.int(0, 9));
		const digits = `${body}${(10 - (luhnSum(`${body}0`) % 10)) % 10}`;
		if (digits.endsWith(avoidLast4)) continue;
		const month = String(rng.int(1, 12)).padStart(2, "0");
		const year = String(Number(today.slice(2, 4)) + rng.int(1, 4));
		return {
			number: digits.replaceAll(/(\d{4})(?=\d)/g, "$1 "),
			expiry: `${month}/${year}`,
			cvc: String(rng.int(100, 999)),
			name: name.toUpperCase(),
		};
	}
}

export function cardLast4(card: TestCard): string {
	return card.number.replaceAll(" ", "").slice(-4);
}

const FRAME_STYLE = `
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;padding:14px;font:14px/1.45 system-ui,sans-serif;color:#0f172a;background:#f8fafc}
.brand{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.brand strong{color:#7c3aed;font-size:16px}
.brand span{color:#64748b;font-size:12px}
fieldset{border:1px solid #e2e8f0;border-radius:6px;margin:0 0 10px;padding:8px 10px}
label{display:block;margin:6px 0 2px}
label.choice{display:flex;gap:6px;align-items:center;margin:4px 0}
input[type=text]{width:100%;font:inherit;padding:6px 8px;border:1px solid #cbd5e1;border-radius:4px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{margin-top:10px;width:100%;background:#7c3aed;color:#fff;border:0;border-radius:4px;padding:8px;font:inherit;cursor:pointer}
button:disabled{opacity:.5}
.error{color:#b91c1c;min-height:1em;margin:6px 0 0}
.status{color:#475569;margin:6px 0 0}
`;

const FRAME_SCRIPT = `
const form = document.getElementById("pay");
const newCard = document.getElementById("new-card");
const number = document.getElementById("card-number");
const expiry = document.getElementById("card-expiry");
const cvc = document.getElementById("card-cvc");
const holder = document.getElementById("card-name");
const error = document.getElementById("pay-error");
const status = document.getElementById("pay-status");
const submit = document.getElementById("pay-submit");
for (const radio of document.querySelectorAll("input[name=source]")) {
	radio.addEventListener("change", () => { newCard.hidden = document.querySelector("input[name=source]:checked").value !== "new"; });
}
number.addEventListener("input", () => {
	const digits = number.value.replace(/\\D/g, "").slice(0, 16);
	number.value = digits.replace(/(\\d{4})(?=\\d)/g, "$1 ");
});
expiry.addEventListener("input", () => {
	const digits = expiry.value.replace(/\\D/g, "").slice(0, 4);
	expiry.value = digits.length > 2 ? digits.slice(0, 2) + "/" + digits.slice(2) : digits;
});
form.addEventListener("submit", async event => {
	event.preventDefault();
	error.textContent = "";
	if (window.parent === window || !PAYBOX.parent) {
		error.textContent = "This payment form works only inside the merchant's checkout.";
		return;
	}
	const source = document.querySelector("input[name=source]:checked");
	const body = source && source.value === "saved"
		? { saved: true, customer: PAYBOX.customer }
		: { number: number.value, expiry: expiry.value, cvc: cvc.value, name: holder.value };
	submit.disabled = true;
	status.textContent = "Checking your card…";
	const response = await fetch("/api/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await response.json();
	if (!response.ok) {
		error.textContent = data.error;
		status.textContent = "";
		submit.disabled = false;
		return;
	}
	status.textContent = "Card ending in " + data.last4 + " accepted. Completing your payment…";
	window.parent.postMessage({ type: "paybox:token", token: data.token }, PAYBOX.parent);
});
`;

/** The fields of a parsed JSON object; anything else has none. */
export function fieldsOf(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

/** The origin a frame may post its token to, or "" when `value` is not an http origin. */
function parentOrigin(value: string): string {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
	} catch {
		return "";
	}
}

export async function startPayBox(options: PayBoxOptions): Promise<PayBox> {
	const tokens = new Map<string, Token>();
	const charges: Charge[] = [];

	const frame = (url: URL): SiteResponse => {
		const amount = Number(url.searchParams.get("amount") ?? "0");
		const merchant = url.searchParams.get("merchant") ?? "the merchant";
		const customer = url.searchParams.get("customer") ?? "";
		const saved = customer === options.customer;
		const config = { parent: parentOrigin(url.searchParams.get("parent") ?? ""), customer };
		return html(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>PayBox secure payment</title><style>${FRAME_STYLE}</style></head>
<body>
<form id="pay" novalidate>
<div class="brand"><strong>PayBox</strong><span>Secure payment to ${escapeHtml(merchant)}</span></div>
${
	saved
		? `<fieldset><legend>Pay with</legend>
<label class="choice"><input type="radio" name="source" value="saved" checked> Visa ending in ${escapeHtml(options.savedCardLast4)} (saved)</label>
<label class="choice"><input type="radio" name="source" value="new"> A different card</label>
</fieldset>`
		: ""
}
<div id="new-card"${saved ? " hidden" : ""}>
<label for="card-number">Card number</label><input type="text" id="card-number" inputmode="numeric" autocomplete="cc-number" placeholder="1234 5678 9012 3456">
<div class="pair">
<div><label for="card-expiry">Expiry (MM/YY)</label><input type="text" id="card-expiry" autocomplete="cc-exp" placeholder="MM/YY"></div>
<div><label for="card-cvc">Security code</label><input type="text" id="card-cvc" inputmode="numeric" autocomplete="cc-csc" maxlength="4" placeholder="CVC"></div>
</div>
<label for="card-name">Name on card</label><input type="text" id="card-name" autocomplete="cc-name">
</div>
<p id="pay-error" class="error" role="alert"></p>
<button id="pay-submit">Pay ${escapeHtml(money(Number.isFinite(amount) ? amount : 0))}</button>
<p id="pay-status" class="status" role="status"></p>
</form>
<script>const PAYBOX = ${scriptJson(config)};${FRAME_SCRIPT}</script>
</body>
</html>`);
	};

	const tokenize = (request: SiteRequest): SiteResponse => {
		const body = fieldsOf(jsonBody(request));
		const issue = (last4: string, savedCard: boolean) => {
			const token = `tok_${options.rng.code(16)}`;
			tokens.set(token, { last4, savedCard, used: false });
			return json({ token, last4 });
		};
		if (body.saved === true) {
			if (body.customer !== options.customer)
				return json({ error: "There is no saved card for this customer." }, { status: 400 });
			return issue(options.savedCardLast4, true);
		}
		const digits = String(body.number ?? "").replaceAll(/[\s-]/g, "");
		if (!/^\d{16}$/.test(digits) || luhnSum(digits) % 10 !== 0) {
			return json({ error: "Your card number is invalid." }, { status: 400 });
		}
		const expiry = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(body.expiry ?? "").trim());
		const month = Number(expiry?.[1]);
		if (!expiry || month < 1 || month > 12)
			return json({ error: "Your card's expiry date is incomplete." }, { status: 400 });
		// A card is good through the last day of its expiry month.
		if (`20${expiry[2]}-${expiry[1]}` < options.today.slice(0, 7)) {
			return json({ error: "Your card has expired." }, { status: 400 });
		}
		if (!/^\d{3}$/.test(String(body.cvc ?? "").trim())) {
			return json({ error: "Your card's security code is incomplete." }, { status: 400 });
		}
		if (!String(body.name ?? "").trim()) return json({ error: "Enter the name on the card." }, { status: 400 });
		return issue(digits.slice(-4), false);
	};

	const charge = (request: SiteRequest): SiteResponse => {
		if (request.headers.authorization !== `Bearer ${MERCHANT_KEY}`)
			return json({ error: "Unknown merchant." }, { status: 401 });
		const body = fieldsOf(jsonBody(request));
		const token = tokens.get(String(body.token ?? ""));
		const amountCents = Number(body.amountCents);
		if (!token) return json({ error: "The payment token is not valid." }, { status: 402 });
		if (token.used) return json({ error: "The payment token was already used." }, { status: 402 });
		if (!Number.isInteger(amountCents) || amountCents <= 0)
			return json({ error: "The amount is not valid." }, { status: 400 });
		token.used = true;
		const recorded: Charge = {
			id: `ch_${options.rng.code(12)}`,
			amountCents,
			last4: token.last4,
			savedCard: token.savedCard,
			description: String(body.description ?? ""),
		};
		charges.push(recorded);
		return json({ id: recorded.id, last4: recorded.last4 });
	};

	const site = await hostSite(request => {
		const { method, url } = request;
		if (url.pathname === "/frame" && method === "GET") return frame(url);
		if (url.pathname === "/api/tokens" && method === "POST") return tokenize(request);
		if (url.pathname === "/api/charges" && method === "POST") return charge(request);
		if (url.pathname === "/" && method === "GET")
			return text("PayBox payments. The checkout form is served inside merchant pages.");
		return text("Not found", { status: 404 });
	});

	return { origin: site.origin, close: () => site.close(), charges };
}
