/**
 * The bank's client-side code: the six-box code entry, the native confirmation before money
 * moves, and the two custom elements whose controls live in open shadow roots (the payee form and
 * the alert settings). Each posts to the server, which records the outcome.
 */

/** Six one-digit boxes that advance as digits are typed and spread a pasted or filled code. */
export const OTP_SCRIPT = `
const boxes = Array.from(document.querySelectorAll(".otp input"));
const spread = (from, digits) => {
	digits.split("").forEach((digit, offset) => { if (boxes[from + offset]) boxes[from + offset].value = digit; });
	boxes[Math.min(from + digits.length, boxes.length - 1)].focus();
};
boxes.forEach((box, index) => {
	box.addEventListener("input", () => {
		const digits = box.value.replace(/\\D/g, "");
		if (digits.length > 1) { box.value = ""; spread(index, digits); return; }
		box.value = digits;
		if (digits && index < boxes.length - 1) boxes[index + 1].focus();
	});
	box.addEventListener("keydown", event => {
		if (event.key === "Backspace" && !box.value && index > 0) boxes[index - 1].focus();
	});
	box.addEventListener("paste", event => {
		const digits = (event.clipboardData ? event.clipboardData.getData("text") : "").replace(/\\D/g, "").slice(0, 6);
		if (!digits) return;
		event.preventDefault();
		spread(index, digits);
	});
});
document.getElementById("otp-form").addEventListener("submit", () => {
	document.getElementById("code").value = boxes.map(box => box.value).join("");
});
boxes[0].focus();
`;

/** Ask with the browser's own confirm dialog before a payment or a transfer is sent. */
export function confirmScript(formId: string, verb: "pay" | "transfer"): string {
	return `
const form = document.getElementById(${JSON.stringify(formId)});
form.addEventListener("submit", event => {
	const field = name => form.elements.namedItem(name);
	const amount = field("amount").value.trim().replace(/^\\$/, "");
	const from = field("from");
	const other = field(${JSON.stringify(verb === "pay" ? "payee" : "to")});
	if (!from.value || !other.value || !amount) return;
	const source = from.selectedOptions[0].dataset.label;
	const target = other.selectedOptions[0].dataset.label;
	const question = ${
		verb === "pay"
			? `"Send a payment of $" + amount + " to " + target + " from " + source + " today?"`
			: `"Transfer $" + amount + " from " + source + " to " + target + " now?"`
	};
	if (!window.confirm(question)) { event.preventDefault(); return; }
	form.querySelector("button[type=submit]").disabled = true;
});
`;
}

const PAYEE_TEMPLATE = `<style>
:host{display:block}
form{background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:14px;max-width:460px}
h2{margin:0 0 8px;font-size:17px}
label{display:block;margin:8px 0 2px}
input{font:inherit;padding:5px 7px;border:1px solid #cbd5e1;border-radius:4px;width:100%;box-sizing:border-box}
input[aria-invalid=true]{border-color:#b91c1c}
.error{color:#b91c1c;margin:2px 0 0;min-height:1em;font-size:13px}
button{background:#2563eb;color:#fff;border:0;border-radius:4px;padding:6px 12px;cursor:pointer;font:inherit;margin-top:10px}
button:disabled{opacity:.45}
.hint{color:#6b7280;font-size:13px;margin:0}
</style>
<form novalidate>
<h2>Add a payee</h2>
<p class="hint">Find the account and routing numbers on the payee's invoice.</p>
<label for="name">Payee name</label><input id="name" name="name" autocomplete="off">
<p class="error" data-error="name"></p>
<label for="nickname">Nickname (optional)</label><input id="nickname" name="nickname" autocomplete="off">
<label for="account">Account number</label><input id="account" name="account" inputmode="numeric" autocomplete="off">
<p class="error" data-error="account"></p>
<label for="confirm">Re-enter account number</label><input id="confirm" name="confirm" inputmode="numeric" autocomplete="off">
<p class="error" data-error="confirm"></p>
<label for="routing">Routing number</label><input id="routing" name="routing" inputmode="numeric" autocomplete="off">
<p class="error" data-error="routing"></p>
<button type="submit">Add payee</button>
<p class="status" role="status"></p>
</form>`;

/** `<nwb-payee-form>`: the add-payee form, validated as it is filled, inside an open shadow root. */
export const PAYEE_SCRIPT = `
const PAYEE_TEMPLATE = ${JSON.stringify(PAYEE_TEMPLATE)};
const routingValid = value => {
	if (!/^\\d{9}$/.test(value)) return false;
	const d = value.split("").map(Number);
	return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + d[2] + d[5] + d[8]) % 10 === 0;
};
class PayeeForm extends HTMLElement {
	connectedCallback() {
		if (this.shadowRoot) return;
		const root = this.attachShadow({ mode: "open" });
		root.innerHTML = PAYEE_TEMPLATE;
		const form = root.querySelector("form");
		const status = root.querySelector("[role=status]");
		const submit = root.querySelector("button[type=submit]");
		const field = name => form.elements.namedItem(name);
		const problem = name => {
			const value = field(name).value.trim();
			if (name === "name") return value ? "" : "Enter the payee's name.";
			if (name === "account") return /^\\d{4,17}$/.test(value) ? "" : "Use 4 to 17 digits only, with no spaces or dashes.";
			if (name === "confirm") return value === field("account").value.trim() ? "" : "The account numbers do not match.";
			if (name === "routing") return routingValid(value) ? "" : "Enter a valid 9-digit routing number.";
			return "";
		};
		const show = (name, message) => {
			root.querySelector('[data-error="' + name + '"]').textContent = message;
			field(name).setAttribute("aria-invalid", message ? "true" : "false");
		};
		const checked = ["name", "account", "confirm", "routing"];
		for (const name of checked) {
			field(name).addEventListener("input", () => {
				if (name === "account" && /\\D/.test(field(name).value)) show(name, "Use digits only, with no spaces or dashes.");
				else if (field(name).getAttribute("aria-invalid") === "true") show(name, problem(name));
			});
			field(name).addEventListener("blur", () => { if (field(name).value) show(name, problem(name)); });
		}
		form.addEventListener("submit", async event => {
			event.preventDefault();
			let valid = true;
			for (const name of checked) {
				const message = problem(name);
				show(name, message);
				if (message) valid = false;
			}
			if (!valid) { status.textContent = "Correct the fields marked in red."; return; }
			submit.disabled = true;
			status.textContent = "Adding payee…";
			const response = await fetch("/api/payees", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: field("name").value.trim(),
					nickname: field("nickname").value.trim(),
					accountNumber: field("account").value.trim(),
					routingNumber: field("routing").value.trim(),
				}),
			});
			const result = await response.json();
			if (!response.ok) { status.textContent = result.error; submit.disabled = false; return; }
			location.href = "/payees?added=" + encodeURIComponent(result.id);
		});
	}
}
customElements.define("nwb-payee-form", PayeeForm);
`;

const ALERT_TEMPLATE = `<style>
:host{display:block;margin-bottom:10px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px}
h3{margin:0 0 2px;font-size:15px}
.description{margin:0 0 8px;color:#6b7280}
.row{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-top:6px}
input{font:inherit;padding:4px 7px;border:1px solid #cbd5e1;border-radius:4px;width:110px}
label.switch{display:inline-flex;gap:6px;align-items:center;cursor:pointer}
[role=switch]{width:38px;height:22px;border-radius:11px;border:0;background:#cbd5e1;position:relative;cursor:pointer;padding:0}
[role=switch]::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
[role=switch][aria-checked=true]{background:#16a34a}
[role=switch][aria-checked=true]::after{left:19px}
.save{background:#2563eb;color:#fff;border:0;border-radius:4px;padding:5px 12px;cursor:pointer;font:inherit}
.save:disabled{opacity:.45;cursor:not-allowed}
.error{color:#b91c1c;margin:4px 0 0;min-height:1em}
[role=status]{color:#6b7280}
</style>
<div class="card">
<h3></h3>
<p class="description"></p>
<div class="row threshold"><label>Amount ($) <input name="threshold" inputmode="decimal" autocomplete="off"></label></div>
<div class="row">
<label class="switch"><button type="button" role="switch" data-channel="email" aria-label="Email"></button><span>Email</span></label>
<label class="switch"><button type="button" role="switch" data-channel="text" aria-label="Text message"></button><span>Text message</span></label>
</div>
<p class="error"></p>
<div class="row"><button type="button" class="save" disabled>Save</button><span role="status"></span></div>
</div>`;

/** `<nwb-alert>`: one alert's amount and channel switches, saved by its own button, in an open shadow root. */
export const ALERT_SCRIPT = `
const ALERT_TEMPLATE = ${JSON.stringify(ALERT_TEMPLATE)};
class AlertSetting extends HTMLElement {
	connectedCallback() {
		if (this.shadowRoot) return;
		const root = this.attachShadow({ mode: "open" });
		root.innerHTML = ALERT_TEMPLATE;
		const data = this.dataset;
		root.querySelector("h3").textContent = data.label;
		root.querySelector(".description").textContent = data.description;
		const input = root.querySelector("input[name=threshold]");
		const hasThreshold = data.threshold !== undefined;
		if (hasThreshold) input.value = data.threshold;
		else root.querySelector(".threshold").remove();
		const switches = Array.from(root.querySelectorAll("[role=switch]"));
		for (const toggle of switches) toggle.setAttribute("aria-checked", data[toggle.dataset.channel] === "true" ? "true" : "false");
		const save = root.querySelector(".save");
		const status = root.querySelector("[role=status]");
		const error = root.querySelector(".error");
		const changed = () => { save.disabled = false; status.textContent = "Unsaved changes"; };
		for (const toggle of switches) {
			toggle.addEventListener("click", () => {
				toggle.setAttribute("aria-checked", toggle.getAttribute("aria-checked") === "true" ? "false" : "true");
				changed();
			});
		}
		if (hasThreshold) input.addEventListener("input", changed);
		save.addEventListener("click", async () => {
			const body = {};
			for (const toggle of switches) body[toggle.dataset.channel] = toggle.getAttribute("aria-checked") === "true";
			if (hasThreshold) {
				const value = input.value.trim().replace(/^\\$/, "").replace(/,/g, "");
				if (!/^\\d+(\\.\\d{1,2})?$/.test(value) || Number(value) <= 0) {
					error.textContent = "Enter an amount in dollars, like 250 or 250.00.";
					return;
				}
				body.threshold = value;
			}
			error.textContent = "";
			save.disabled = true;
			status.textContent = "Saving…";
			const response = await fetch("/api/alerts/" + encodeURIComponent(data.key), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const result = await response.json();
			if (!response.ok) { error.textContent = result.error; save.disabled = false; status.textContent = ""; return; }
			status.textContent = "Saved";
		});
	}
}
customElements.define("nwb-alert", AlertSetting);
`;
