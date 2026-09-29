/**
 * The inline scripts Parcel Mail's pages run: the virtualized message list with its selection and
 * bulk toolbar, the compose form's recipient autocomplete and attachment upload, and the filter
 * form's condition rows. Each is plain browser JavaScript that talks to the site's JSON endpoints,
 * so everything it changes is recorded by the server.
 */

/**
 * The message list renders only the rows near the scrolled window of `#list`, each positioned
 * absolutely, and fetches pages of rows as scrolling reaches them. The selection lives in a set of
 * ids, not in the checkboxes, since a row that scrolls out of view is removed from the page.
 */
export const LIST_SCRIPT = `
(() => {
	const config = JSON.parse(document.getElementById("list-config").textContent);
	const ROW = 40;
	const PAGE = 50;
	const OVERSCAN = 5;
	const list = document.getElementById("list");
	const spacer = document.getElementById("spacer");
	const countLabel = document.getElementById("count");
	const selectAll = document.getElementById("select-all");
	const selectionLabel = document.getElementById("selection");
	const notice = document.getElementById("list-notice");
	const actionButtons = Array.from(document.querySelectorAll("[data-bulk]"));
	const labelButton = document.getElementById("label-button");
	const labelMenu = document.getElementById("label-menu");
	const selected = new Set();
	const rendered = new Map();
	let total = config.total;
	let rows = new Map();
	let requested = new Set();
	let generation = 0;
	config.rows.forEach((row, index) => rows.set(index, row));
	requested.add(0);

	const query = extra => {
		const params = new URLSearchParams({ view: config.view, q: config.q });
		for (const key of Object.keys(extra)) params.set(key, String(extra[key]));
		return params.toString();
	};

	async function loadPage(page) {
		if (requested.has(page)) return;
		requested.add(page);
		const current = generation;
		const response = await fetch("/api/list?" + query({ offset: page * PAGE, limit: PAGE }));
		const data = await response.json();
		if (current !== generation) return;
		total = data.total;
		data.rows.forEach((row, index) => rows.set(page * PAGE + index, row));
		update();
	}

	function setStar(button, starred) {
		button.textContent = starred ? "\\u2605" : "\\u2606";
		button.setAttribute("aria-pressed", String(starred));
		button.setAttribute("aria-label", starred ? "Starred" : "Not starred");
	}

	function buildRow(row) {
		const element = document.createElement("div");
		element.className = row.read ? "row-item" : "row-item unread";
		element.setAttribute("role", "row");
		element.dataset.id = row.id;
		const box = document.createElement("input");
		box.type = "checkbox";
		box.setAttribute("aria-label", "Select: " + row.subject);
		box.addEventListener("change", () => {
			if (box.checked) selected.add(row.id);
			else selected.delete(row.id);
			syncToolbar();
		});
		const star = document.createElement("button");
		star.type = "button";
		star.className = "star";
		setStar(star, row.starred);
		star.addEventListener("click", async () => {
			const next = !row.starred;
			const ok = await bulk(next ? "star" : "unstar", [row.id], true);
			if (!ok) return;
			row.starred = next;
			setStar(star, next);
		});
		const from = document.createElement("span");
		from.className = "from";
		from.textContent = row.who;
		from.title = row.whoTitle;
		const subject = document.createElement("a");
		subject.className = "subject";
		subject.href = "/message/" + row.id;
		subject.textContent = row.subject || "(no subject)";
		const preview = document.createElement("span");
		preview.className = "snippet";
		preview.textContent = " \\u2014 " + row.snippet;
		subject.appendChild(preview);
		const chips = document.createElement("span");
		chips.className = "chips";
		if (config.q) {
			const folder = document.createElement("span");
			folder.className = "chip folder";
			folder.textContent = row.folderName;
			chips.appendChild(folder);
		}
		for (const label of row.labels) {
			const chip = document.createElement("span");
			chip.className = "chip";
			chip.textContent = label;
			chips.appendChild(chip);
		}
		if (row.attachments > 0) {
			const clip = document.createElement("span");
			clip.className = "chip clip";
			clip.textContent = row.attachments === 1 ? "1 attachment" : row.attachments + " attachments";
			chips.appendChild(clip);
		}
		const time = document.createElement("time");
		time.dateTime = row.date;
		time.textContent = row.dateLabel;
		element.append(box, star, from, subject, chips, time);
		element.addEventListener("click", event => {
			if (event.target.closest("input, button, a")) return;
			location.href = "/message/" + row.id;
		});
		return element;
	}

	function update() {
		spacer.style.height = total * ROW + "px";
		countLabel.textContent = total === 1 ? "1 conversation" : total + " conversations";
		list.setAttribute("aria-rowcount", String(total));
		const first = Math.max(0, Math.floor(list.scrollTop / ROW) - OVERSCAN);
		const last = Math.min(total - 1, Math.ceil((list.scrollTop + list.clientHeight) / ROW) + OVERSCAN - 1);
		const wanted = new Map();
		for (let index = first; index <= last; index++) {
			const row = rows.get(index);
			if (row) wanted.set(row.id, { row, index });
			else loadPage(Math.floor(index / PAGE));
		}
		for (const [id, element] of rendered) {
			if (!wanted.has(id)) {
				element.remove();
				rendered.delete(id);
			}
		}
		for (const [id, entry] of wanted) {
			let element = rendered.get(id);
			if (!element) {
				element = buildRow(entry.row);
				rendered.set(id, element);
				list.appendChild(element);
			}
			element.style.top = entry.index * ROW + "px";
			element.setAttribute("aria-rowindex", String(entry.index + 1));
			element.querySelector("input").checked = selected.has(id);
		}
		document.getElementById("empty").hidden = total !== 0;
		syncToolbar();
	}

	function syncToolbar() {
		const count = selected.size;
		selectionLabel.textContent = count === 0 ? "" : count + " selected";
		for (const button of actionButtons) button.disabled = count === 0;
		labelButton.disabled = count === 0;
		selectAll.checked = count > 0 && count >= total;
		selectAll.indeterminate = count > 0 && count < total;
	}

	function reload() {
		generation++;
		rows = new Map();
		requested = new Set();
		for (const element of rendered.values()) element.remove();
		rendered.clear();
		loadPage(0);
	}

	async function bulk(action, ids, quiet, label) {
		const response = await fetch("/api/bulk", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, ids, label }),
		});
		const data = await response.json();
		if (!response.ok) {
			notice.textContent = data.error;
			notice.className = "error";
			return false;
		}
		if (!quiet) {
			notice.textContent = data.message;
			notice.className = "notice";
			selected.clear();
			reload();
		}
		return true;
	}

	selectAll.addEventListener("change", async () => {
		if (selectAll.checked) {
			const data = await (await fetch("/api/ids?" + query({}))).json();
			for (const id of data.ids) selected.add(id);
		} else selected.clear();
		update();
	});
	for (const button of actionButtons) {
		button.addEventListener("click", () => bulk(button.dataset.bulk, Array.from(selected)));
	}
	labelButton.addEventListener("click", () => {
		labelMenu.hidden = !labelMenu.hidden;
		labelButton.setAttribute("aria-expanded", String(!labelMenu.hidden));
	});
	for (const item of labelMenu.querySelectorAll("[data-label]")) {
		item.addEventListener("click", () => {
			labelMenu.hidden = true;
			labelButton.setAttribute("aria-expanded", "false");
			bulk("label", Array.from(selected), false, item.dataset.label);
		});
	}
	document.addEventListener("click", event => {
		if (!labelMenu.hidden && !event.target.closest("#label-menu, #label-button")) {
			labelMenu.hidden = true;
			labelButton.setAttribute("aria-expanded", "false");
		}
	});
	list.addEventListener("scroll", update);
	window.addEventListener("resize", update);
	update();
})();
`;

/**
 * The compose form. A recipient field turns what is typed into chips: typing opens a popover of
 * matching contacts right under the field, over the Send and Attach buttons, until a contact is
 * picked, Escape is pressed, or the field loses focus. The Cc field stays behind a toggle unless the
 * form starts with Cc recipients. Attach opens a hidden file input; each chosen file is uploaded at
 * once and listed as a chip, and Send waits for the uploads.
 */
export const COMPOSE_SCRIPT = `
(() => {
	const form = document.getElementById("compose-form");
	const sendButton = document.getElementById("send-button");
	const formError = document.getElementById("compose-error");
	const fields = [];

	function recipientField(kind) {
		const box = document.getElementById(kind + "-box");
		const input = document.getElementById(kind + "-input");
		const hidden = document.getElementById(kind + "-value");
		const popover = document.getElementById(kind + "-suggest");
		let options = [];
		let active = -1;
		let sequence = 0;

		const emails = () => Array.from(box.querySelectorAll(".chip")).map(chip => chip.dataset.email);
		const sync = () => { hidden.value = emails().join(","); };

		function addChip(name, email) {
			const address = email.trim().toLowerCase();
			if (emails().includes(address)) return;
			const chip = document.createElement("span");
			chip.className = "chip";
			chip.dataset.email = address;
			chip.textContent = name ? name + " <" + address + ">" : address;
			const remove = document.createElement("button");
			remove.type = "button";
			remove.setAttribute("aria-label", "Remove " + address);
			remove.textContent = "\\u00d7";
			remove.addEventListener("click", () => { chip.remove(); sync(); input.focus(); });
			chip.appendChild(remove);
			box.insertBefore(chip, input);
			sync();
		}
		for (const chip of Array.from(box.querySelectorAll(".chip"))) {
			chip.querySelector("button").addEventListener("click", () => { chip.remove(); sync(); });
		}

		function close() {
			popover.hidden = true;
			popover.innerHTML = "";
			input.setAttribute("aria-expanded", "false");
			input.removeAttribute("aria-activedescendant");
			options = [];
			active = -1;
		}

		function highlight(index) {
			active = index;
			Array.from(popover.children).forEach((option, position) => {
				option.setAttribute("aria-selected", String(position === index));
			});
			if (index >= 0) input.setAttribute("aria-activedescendant", kind + "-option-" + index);
		}

		function pick(index) {
			const contact = options[index];
			if (!contact) return;
			addChip(contact.name, contact.email);
			input.value = "";
			input.removeAttribute("aria-invalid");
			close();
		}

		function commitTyped() {
			const text = input.value.trim().replace(/[,;]+$/, "");
			if (!text) return true;
			const angle = /<([^>]+)>/.exec(text);
			const address = angle ? angle[1] : text;
			if (/^[^\\s@<>,;"]+@[^\\s@<>,;"]+\\.[a-z]{2,}$/i.test(address)) {
				addChip("", address);
				input.value = "";
				input.removeAttribute("aria-invalid");
				return true;
			}
			input.setAttribute("aria-invalid", "true");
			return false;
		}

		async function suggest() {
			const text = input.value.trim();
			const current = ++sequence;
			if (!text) return close();
			const response = await fetch("/api/contacts?q=" + encodeURIComponent(text));
			const data = await response.json();
			if (current !== sequence) return;
			options = data.contacts.filter(contact => !emails().includes(contact.email));
			popover.innerHTML = "";
			options.forEach((contact, index) => {
				const option = document.createElement("div");
				option.setAttribute("role", "option");
				option.id = kind + "-option-" + index;
				option.className = "option";
				const name = document.createElement("strong");
				name.textContent = contact.name;
				const email = document.createElement("span");
				email.className = "muted";
				email.textContent = " " + contact.email;
				option.append(name, email);
				option.addEventListener("mousedown", event => event.preventDefault());
				option.addEventListener("click", () => pick(index));
				popover.appendChild(option);
			});
			if (options.length === 0) return close();
			popover.hidden = false;
			input.setAttribute("aria-expanded", "true");
			highlight(0);
		}

		input.addEventListener("input", () => { input.removeAttribute("aria-invalid"); suggest(); });
		input.addEventListener("keydown", event => {
			if (event.key === "ArrowDown" && options.length > 0) {
				event.preventDefault();
				highlight((active + 1) % options.length);
			} else if (event.key === "ArrowUp" && options.length > 0) {
				event.preventDefault();
				highlight((active - 1 + options.length) % options.length);
			} else if (event.key === "Enter") {
				event.preventDefault();
				if (!popover.hidden && active >= 0) pick(active);
				else commitTyped();
			} else if (event.key === "Escape") {
				close();
			} else if (event.key === "," || event.key === ";") {
				event.preventDefault();
				commitTyped();
			} else if (event.key === "Backspace" && input.value === "") {
				const chips = box.querySelectorAll(".chip");
				const last = chips[chips.length - 1];
				if (last) { last.remove(); sync(); }
			}
		});
		input.addEventListener("blur", () => { commitTyped(); close(); });
		box.addEventListener("click", event => { if (event.target === box) input.focus(); });
		sync();
		return { input, commitTyped, emails };
	}

	fields.push(recipientField("to"), recipientField("cc"));
	const ccToggle = document.getElementById("cc-toggle");
	if (ccToggle) {
		ccToggle.addEventListener("click", () => {
			document.getElementById("cc-field").hidden = false;
			ccToggle.hidden = true;
			document.getElementById("cc-input").focus();
		});
	}

	const attachButton = document.getElementById("attach-button");
	const fileInput = document.getElementById("attach-input");
	const attachmentList = document.getElementById("attachment-list");
	const attachmentValue = document.getElementById("attachments-value");
	let uploading = 0;

	const syncAttachments = () => {
		attachmentValue.value = Array.from(attachmentList.querySelectorAll("[data-attachment]"))
			.map(chip => chip.dataset.attachment)
			.join(",");
	};
	for (const chip of Array.from(attachmentList.querySelectorAll("[data-attachment]"))) {
		chip.querySelector("button").addEventListener("click", () => { chip.remove(); syncAttachments(); });
	}

	function base64(bytes) {
		let binary = "";
		for (let offset = 0; offset < bytes.length; offset += 0x8000) {
			binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
		}
		return btoa(binary);
	}

	async function upload(file) {
		const chip = document.createElement("span");
		chip.className = "chip uploading";
		chip.textContent = file.name + " (uploading\\u2026)";
		attachmentList.appendChild(chip);
		uploading++;
		sendButton.disabled = true;
		try {
			const data = base64(new Uint8Array(await file.arrayBuffer()));
			const response = await fetch("/api/attachments", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: file.name, data }),
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || "upload failed");
			chip.className = "chip attachment";
			chip.dataset.attachment = result.id;
			chip.textContent = result.name + " (" + result.sizeLabel + ")";
			const remove = document.createElement("button");
			remove.type = "button";
			remove.setAttribute("aria-label", "Remove " + result.name);
			remove.textContent = "\\u00d7";
			remove.addEventListener("click", () => { chip.remove(); syncAttachments(); });
			chip.appendChild(remove);
		} catch (error) {
			chip.className = "chip error";
			chip.textContent = file.name + ": " + error.message;
		} finally {
			uploading--;
			sendButton.disabled = uploading > 0;
			syncAttachments();
		}
	}

	attachButton.addEventListener("click", () => fileInput.click());
	fileInput.addEventListener("change", async () => {
		const files = Array.from(fileInput.files);
		fileInput.value = "";
		for (const file of files) await upload(file);
	});

	form.addEventListener("submit", event => {
		let valid = true;
		for (const field of fields) valid = field.commitTyped() && valid;
		if (!valid) {
			event.preventDefault();
			formError.textContent = "A recipient is not a complete address. Pick a contact from the suggestions or type the full address.";
			return;
		}
		if (uploading > 0) {
			event.preventDefault();
			formError.textContent = "Wait for the attachments to finish uploading.";
			return;
		}
		if (fields[0].emails().length === 0 && fields[1].emails().length === 0) {
			event.preventDefault();
			formError.textContent = "Add at least one recipient.";
		}
	});
})();
`;

/** The filter form: conditions are rows added and removed in place, and a count of matching mail follows the form. */
export const FILTER_SCRIPT = `
(() => {
	const form = document.getElementById("filter-form");
	const rows = document.getElementById("conditions");
	const template = document.getElementById("condition-template");
	const addButton = document.getElementById("add-condition");
	const labelSelect = document.getElementById("filter-label");
	const newLabel = document.getElementById("new-label-field");
	const matchCount = document.getElementById("match-count");
	const MAX = 5;

	function renumber() {
		Array.from(rows.children).forEach((row, index) => {
			row.querySelector("select").name = "field" + index;
			row.querySelector("select").setAttribute("aria-label", "Condition " + (index + 1) + " field");
			row.querySelector("input").name = "value" + index;
			row.querySelector("input").setAttribute("aria-label", "Condition " + (index + 1) + " value");
		});
		addButton.disabled = rows.children.length >= MAX;
		for (const button of rows.querySelectorAll("[data-remove]")) button.disabled = rows.children.length === 1;
	}

	function wire(row) {
		row.querySelector("[data-remove]").addEventListener("click", () => {
			row.remove();
			renumber();
			preview();
		});
	}

	for (const row of Array.from(rows.children)) wire(row);
	addButton.addEventListener("click", () => {
		const row = template.content.firstElementChild.cloneNode(true);
		rows.appendChild(row);
		wire(row);
		renumber();
		row.querySelector("input").focus();
	});
	labelSelect.addEventListener("change", () => {
		newLabel.hidden = labelSelect.value !== "__new";
		if (!newLabel.hidden) newLabel.querySelector("input").focus();
	});

	let timer = 0;
	let sequence = 0;
	async function preview() {
		const current = ++sequence;
		const body = new URLSearchParams(new FormData(form)).toString();
		const response = await fetch("/api/filters/preview", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		const data = await response.json();
		if (current !== sequence) return;
		matchCount.textContent = data.count === 1 ? "1 conversation matches" : data.count + " conversations match";
	}
	form.addEventListener("input", () => {
		clearTimeout(timer);
		timer = setTimeout(preview, 250);
	});
	form.addEventListener("change", () => {
		clearTimeout(timer);
		timer = setTimeout(preview, 250);
	});
	renumber();
	preview();
})();
`;
