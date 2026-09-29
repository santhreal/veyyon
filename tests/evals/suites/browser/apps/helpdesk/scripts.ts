/**
 * The helpdesk's page styles and the small scripts behind its custom widgets. Each widget keeps a
 * hidden form field in step with what it shows, so a submit posts exactly what the page displays.
 */

export const STYLE = `
[hidden]{display:none!important}
header.app .today{margin-left:auto;color:#cbd5e1;font-size:13px}
.layout{display:grid;grid-template-columns:1fr 300px;gap:16px;align-items:start}
.msg{border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#fff}
.msg .who{display:flex;gap:8px;align-items:baseline;margin-bottom:6px}
.msg-internal{background:#fffbeb;border-color:#fcd34d}
.msg-public{border-left:4px solid #2563eb}
.msg-auto{background:#f3f4f6}
.chip{display:inline-flex;gap:4px;align-items:center;background:#e0e7ff;border-radius:12px;padding:2px 8px;margin:2px;font-size:13px}
.chip button{background:none;color:#1e3a8a;padding:0 2px}
.tag-editor{display:flex;flex-wrap:wrap;align-items:center;border:1px solid #cbd5e1;border-radius:4px;padding:3px;background:#fff}
.tag-editor input{border:0;flex:1;min-width:90px}
.seg{border:0;padding:0;margin:6px 0}
.seg label{display:inline-block;border:1px solid #cbd5e1;border-radius:4px;padding:3px 8px;margin:0 2px 2px 0;cursor:pointer}
.seg input{position:absolute;opacity:0;width:1px;height:1px}
.seg label:has(input:checked){background:#dbeafe;border-color:#2563eb}
.combo{position:relative}
.combo-button{background:#fff;color:#111827;border:1px solid #cbd5e1;width:100%;text-align:left}
.combo-button::after{content:" \\25BE";float:right}
.combo-popup{position:absolute;z-index:10;background:#fff;border:1px solid #cbd5e1;border-radius:4px;padding:6px;width:100%}
.combo-popup ul{list-style:none;margin:6px 0 0;padding:0;max-height:200px;overflow:auto}
[role=option]{padding:4px 6px;cursor:pointer}
[role=option]:hover,[role=option][aria-selected=true]{background:#eff6ff}
.tabs{display:flex;gap:4px;margin-bottom:6px}
.tabs [role=tab]{background:#e5e7eb;color:#111827}
.tabs [role=tab][aria-selected=true]{background:#1f2937;color:#fff}
textarea{width:100%}
textarea.internal{background:#fffbeb}
.split{position:relative;display:inline-flex;gap:1px;margin-top:6px}
.split [role=menu]{position:absolute;top:34px;left:0;background:#fff;border:1px solid #cbd5e1;border-radius:4px;z-index:10;display:flex;flex-direction:column;min-width:190px}
.split [role=menu] button{background:#fff;color:#111827;text-align:left;border-radius:0}
.badge{display:inline-block;border-radius:10px;padding:1px 8px;font-size:12px;background:#e5e7eb}
.badge.vip{background:#fef3c7;color:#92400e;font-weight:600}
.badge.internal{background:#fee2e2;color:#991b1b}
.badge.spam{background:#fee2e2;color:#991b1b}
.switch{width:40px;height:22px;border-radius:11px;background:#cbd5e1;position:relative;padding:0}
.switch[aria-checked=true]{background:#16a34a}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff}
.switch[aria-checked=true]::after{left:21px}
.editor{min-height:80px;border:1px solid #cbd5e1;border-radius:4px;padding:6px;background:#fff}
.menu-wrap{position:relative;display:inline-block}
.menu{position:absolute;right:0;top:30px;background:#fff;border:1px solid #cbd5e1;border-radius:4px;z-index:10;min-width:180px;display:flex;flex-direction:column}
.menu form{margin:0}
.menu button{width:100%;background:#fff;color:#111827;text-align:left;border-radius:0}
.menu button:hover{background:#eff6ff}
.post{border-bottom:1px solid #e5e7eb;padding:10px 0}
.post .text{white-space:pre-wrap}
.sig{border-top:1px dashed #e5e7eb;margin-top:6px;padding-top:4px;color:#6b7280;font-size:12px}
.pager{display:flex;gap:6px;margin-top:10px}
.pager a,.pager span{padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;text-decoration:none}
.pager span{background:#1f2937;color:#fff}
pre.source{white-space:pre-wrap;font-size:12px;background:#f3f4f6;padding:8px;border-radius:4px}
`;

/** Forms marked `data-confirm` ask before they submit. */
export const CONFIRM_SCRIPT = `
for (const form of document.querySelectorAll("form[data-confirm]")) {
	form.addEventListener("submit", event => {
		if (!confirm(form.dataset.confirm)) event.preventDefault();
	});
}
`;

/** Menus behind a button: one open at a time, closed by a click elsewhere. */
export const MENU_SCRIPT = `
const menus = [...document.querySelectorAll("[data-menu]")];
const closeMenus = except => {
	for (const button of menus) {
		if (button === except) continue;
		document.getElementById(button.dataset.menu).hidden = true;
		button.setAttribute("aria-expanded", "false");
	}
};
for (const button of menus) {
	button.addEventListener("click", event => {
		event.stopPropagation();
		const menu = document.getElementById(button.dataset.menu);
		closeMenus(button);
		menu.hidden = !menu.hidden;
		button.setAttribute("aria-expanded", String(!menu.hidden));
	});
}
document.addEventListener("click", event => {
	if (!event.target.closest("[role=menu]")) closeMenus(null);
});
`;

/** The row checkboxes sit in the table and join the bulk form through their `form` attribute. */
export const BULK_SCRIPT = `
const bulk = document.getElementById("bulk");
const all = document.getElementById("select-all");
all.addEventListener("change", () => {
	for (const box of document.querySelectorAll("input[name=ids]")) box.checked = all.checked;
});
bulk.addEventListener("submit", event => {
	const count = document.querySelectorAll("input[name=ids]:checked").length;
	if (count === 0) {
		event.preventDefault();
		alert("Select at least one ticket first.");
		return;
	}
	if (!confirm("Apply this change to " + count + " ticket(s)?")) event.preventDefault();
});
`;

/** The ticket page: tag chips, the assignee combobox, the composer's tabs and its submit menu. */
export const TICKET_SCRIPT = `
(() => {
	const editor = document.getElementById("tag-editor");
	if (!editor) return;
	const input = document.getElementById("tag-input");
	const value = document.getElementById("tags-value");
	let tags = value.value ? value.value.split(",") : [];
	const render = () => {
		for (const chip of editor.querySelectorAll(".chip")) chip.remove();
		for (const tag of tags) {
			const chip = document.createElement("span");
			chip.className = "chip";
			chip.textContent = tag;
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "\\u00d7";
			remove.setAttribute("aria-label", "Remove tag " + tag);
			remove.addEventListener("click", () => {
				tags = tags.filter(entry => entry !== tag);
				render();
			});
			chip.appendChild(remove);
			editor.insertBefore(chip, input);
		}
		value.value = tags.join(",");
	};
	const add = () => {
		const tag = input.value.trim().toLowerCase().replace(/\\s+/g, "-");
		input.value = "";
		if (tag && !tags.includes(tag)) tags.push(tag);
		render();
	};
	input.addEventListener("keydown", event => {
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			add();
		} else if (event.key === "Backspace" && !input.value && tags.length > 0) {
			tags.pop();
			render();
		}
	});
	document.getElementById("fields").addEventListener("submit", () => {
		if (input.value.trim()) add();
	});
	render();
})();
(() => {
	const button = document.getElementById("assignee-button");
	if (!button) return;
	const popup = document.getElementById("assignee-popup");
	const search = document.getElementById("assignee-search");
	const hidden = document.getElementById("assignee-value");
	const options = [...popup.querySelectorAll("[role=option]")];
	button.addEventListener("click", () => {
		popup.hidden = !popup.hidden;
		button.setAttribute("aria-expanded", String(!popup.hidden));
		if (!popup.hidden) search.focus();
	});
	search.addEventListener("input", () => {
		const query = search.value.toLowerCase();
		for (const option of options) option.hidden = !option.textContent.toLowerCase().includes(query);
	});
	for (const option of options) {
		option.addEventListener("click", () => {
			hidden.value = option.dataset.value;
			button.textContent = option.textContent;
			for (const other of options) other.setAttribute("aria-selected", String(other === option));
			popup.hidden = true;
			button.setAttribute("aria-expanded", "false");
		});
	}
})();
(() => {
	const composer = document.getElementById("composer");
	if (!composer) return;
	const mode = document.getElementById("mode");
	const body = document.getElementById("reply-body");
	for (const tab of composer.querySelectorAll("[role=tab]")) {
		tab.addEventListener("click", () => {
			mode.value = tab.dataset.mode;
			for (const other of composer.querySelectorAll("[role=tab]")) other.setAttribute("aria-selected", String(other === tab));
			body.classList.toggle("internal", mode.value === "internal");
			body.placeholder = mode.value === "internal" ? "Only agents see internal notes" : "The customer receives this reply";
		});
	}
	const toggle = document.getElementById("submit-toggle");
	const menu = document.getElementById("submit-menu");
	toggle.addEventListener("click", () => {
		menu.hidden = !menu.hidden;
		toggle.setAttribute("aria-expanded", String(!menu.hidden));
	});
})();
`;

/** The signature editor copies its text into the form when the form submits. */
export const PROFILE_SCRIPT = `
const editor = document.getElementById("signature-editor");
for (const button of document.querySelectorAll("[data-command]")) {
	button.addEventListener("mousedown", event => event.preventDefault());
	button.addEventListener("click", () => document.execCommand(button.dataset.command));
}
document.getElementById("profile-form").addEventListener("submit", () => {
	document.getElementById("signature-value").value = editor.innerText.replace(/\\u00a0/g, " ");
});
`;

/** Switches flip their hidden field; the review banner covers the page until it is put off. */
export const NOTIFICATIONS_SCRIPT = `
for (const toggle of document.querySelectorAll("[role=switch]")) {
	toggle.addEventListener("click", () => {
		const on = toggle.getAttribute("aria-checked") !== "true";
		toggle.setAttribute("aria-checked", String(on));
		document.getElementById(toggle.dataset.field).value = on ? "on" : "off";
	});
}
const review = document.getElementById("review");
if (review) {
	document.getElementById("review-later").addEventListener("click", async () => {
		await fetch("/settings/review/dismiss", { method: "POST" });
		review.remove();
	});
}
`;

export const SECRET_SCRIPT = `
document.getElementById("reveal").addEventListener("click", () => {
	document.getElementById("secret").hidden = false;
	document.getElementById("masked").hidden = true;
});
`;
