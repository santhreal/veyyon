/**
 * The board page's own JavaScript and CSS.
 *
 * Cards move by dragging (pointer events on most boards, the HTML drag-and-drop events on a board
 * whose `drag` is `html5`) and through a "Move to…" dialog; a title is edited in place after a
 * double-click; a card opens in a modal with a label popover, an assignee select, a due-date field
 * with a calendar popover, a checklist and comments. Every change is posted to the server, which
 * is the only record a grader reads. The script reads `TRELLIS`, which the page defines before it.
 */

export const BOARD_STYLE = String.raw`
main{max-width:none;padding:12px 16px}
.boardbar{margin-bottom:8px}
.boardbar h1{margin:0;font-size:20px}
.filterbar{background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;margin-bottom:10px}
.filterbar label{display:flex;gap:6px;align-items:center;margin:0}
.board{display:flex;gap:10px;align-items:flex-start;overflow-x:auto;padding-bottom:8px}
.column{flex:none;width:252px;background:#e9ecf1;border-radius:8px;display:flex;flex-direction:column;max-height:calc(100vh - 170px)}
.column-head{display:flex;justify-content:space-between;align-items:center;padding:8px 10px 4px}
.column-head h2{font-size:14px;margin:0}
.count{font-size:12px;color:#475569}
.cards{overflow-y:auto;padding:4px 6px;min-height:48px;flex:1}
.column-foot{padding:4px 6px 8px}
.add-card{width:100%;text-align:left}
.kcard{position:relative;background:#fff;border-radius:6px;box-shadow:0 1px 2px rgba(15,23,42,.18);padding:7px 30px 6px 8px;margin-bottom:6px;cursor:pointer;user-select:none;-webkit-user-select:none}
.kcard:hover{box-shadow:0 2px 6px rgba(15,23,42,.25)}
.kcard:focus{outline:2px solid #2563eb;outline-offset:1px}
.kcard.filtered-out,.kcard.dragging{display:none}
.ctitle{font-weight:500;word-break:break-word}
.title-input{width:100%;font:inherit;font-weight:500;user-select:text;-webkit-user-select:text}
.meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:#475569;margin-top:4px}
.badge{border-radius:3px;padding:0 4px}
.badge.overdue{background:#fee2e2;color:#b91c1c}
.badge.done-badge{background:#dcfce7;color:#166534}
.avatar{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#334155;color:#fff;font-size:10px;font-weight:700}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
.chip{display:inline-block;height:8px;min-width:36px;border-radius:4px;cursor:pointer}
.chip-text{display:none}
body.labels-expanded .chip{height:auto;min-width:0;padding:0 6px;color:#fff;font-size:11px;font-weight:600}
body.labels-expanded .chip-text{display:inline}
.menu-btn{position:absolute;top:4px;right:4px;background:transparent;color:#475569;padding:0 6px;opacity:.45;font-size:16px;line-height:18px}
.kcard:hover .menu-btn,.kcard:focus-within .menu-btn{opacity:1}
.placeholder{border:2px dashed #94a3b8;background:#d7dde6;border-radius:6px;margin-bottom:6px}
.ghost{position:fixed;pointer-events:none;z-index:100;transform:rotate(3deg);opacity:.92;box-shadow:0 8px 20px rgba(15,23,42,.35);margin:0}
body.is-dragging,body.is-dragging *{cursor:grabbing}
.menu{position:fixed;z-index:70;background:#fff;border:1px solid #cbd5e1;border-radius:6px;box-shadow:0 6px 18px rgba(15,23,42,.2);padding:4px;min-width:190px}
.menu-item{display:flex;justify-content:space-between;width:100%;background:transparent;color:#111827;text-align:left;padding:5px 8px}
.menu-item:hover,.menu-item:focus{background:#e0e7ff}
kbd{font:11px ui-monospace,monospace;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:3px;padding:0 4px;color:#334155}
.card-dialog{position:relative;width:620px;max-width:620px;max-height:90vh;overflow-y:auto}
.card-dialog h2{margin:4px 0 8px;padding-right:30px}
.card-dialog h3{font-size:13px;margin:14px 0 6px;color:#334155}
.card-dialog section{position:relative}
.close{position:absolute;top:8px;right:8px;background:transparent;color:#334155;font-size:20px;padding:0 8px}
.popover{position:absolute;z-index:60;background:#fff;border:1px solid #cbd5e1;border-radius:6px;box-shadow:0 6px 18px rgba(15,23,42,.2);padding:8px;min-width:220px}
.label-option{display:flex;gap:8px;align-items:center;width:100%;background:transparent;color:#111827;padding:4px 6px;text-align:left}
.label-option:hover{background:#f1f5f9}
.swatch{display:inline-block;width:34px;height:16px;border-radius:3px}
.modal-chip{display:inline-block;color:#fff;border-radius:3px;padding:1px 8px;font-size:12px;font-weight:600}
.checklist{list-style:none;padding:0;margin:0}
.checklist li{display:flex;align-items:center;gap:8px;padding:2px 0}
.checklist li label{display:flex;gap:8px;align-items:center;margin:0;flex:1}
.checklist li.done span{text-decoration:line-through;color:#6b7280}
.comment{border-top:1px solid #e5e7eb;padding:6px 0}
.calendar-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.calendar-grid{display:grid;grid-template-columns:repeat(7,32px);gap:2px;text-align:center}
.calendar-grid button{padding:4px 0;background:#f8fafc;color:#111827}
.calendar-grid button.today{border:1px solid #2563eb}
.calendar-grid button.selected{background:#2563eb;color:#fff}
.dow{font-size:11px;color:#6b7280}
.composer textarea{width:100%;min-height:54px;resize:vertical}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#991b1b;color:#fff;padding:8px 14px;border-radius:6px;z-index:90}
.help-table td:first-child{white-space:nowrap}
`;

export const BOARD_SCRIPT = String.raw`
(function () {
"use strict";
var T = TRELLIS;
var board = document.getElementById("board");
var toastEl = document.getElementById("toast");

function $(selector, root) { return (root || document).querySelector(selector); }
function $$(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
function h(tag, attrs, children) {
	var el = document.createElement(tag);
	Object.keys(attrs || {}).forEach(function (key) {
		var value = attrs[key];
		if (value === undefined || value === null || value === false) return;
		if (key === "text") el.textContent = value;
		else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), value);
		else if (key === "value" || key === "checked") el[key] = value;
		else el.setAttribute(key, value === true ? "" : String(value));
	});
	(children || []).forEach(function (child) { if (child) el.appendChild(typeof child === "string" ? document.createTextNode(child) : child); });
	return el;
}
function post(url, body) {
	return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
		.then(function (response) {
			return response.json().then(function (data) {
				if (!response.ok) throw new Error(data.error || "The change was not saved.");
				return data;
			});
		});
}
function toast(message) {
	toastEl.textContent = message;
	toastEl.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(function () { toastEl.hidden = true; }, 4000);
}
function reload() { location.reload(); }
function cardId(card) { return card.getAttribute("data-card"); }
function cardEl(id) { return board.querySelector('.kcard[data-card="' + id + '"]'); }
function listOf(column) { return board.querySelector('.cards[data-list="' + column + '"]'); }
function cardsIn(list) { return $$(".kcard", list); }
function visibleCards(list) {
	return cardsIn(list).filter(function (card) { return !card.classList.contains("filtered-out") && !card.classList.contains("dragging"); });
}
function labelOf(id) {
	for (var i = 0; i < T.labels.length; i++) if (T.labels[i].id === id) return T.labels[i];
	return { id: id, name: id, color: "#64748b" };
}
function columnName(id) {
	for (var i = 0; i < T.columns.length; i++) if (T.columns[i].id === id) return T.columns[i].name;
	return id;
}

// ---- Filters --------------------------------------------------------------------------------
var filterLabel = document.getElementById("filter-label");
var filterMember = document.getElementById("filter-member");
var filterQuery = document.getElementById("filter-q");
function applyFilters() {
	var label = filterLabel.value;
	var member = filterMember.value;
	var query = filterQuery.value.trim().toLowerCase();
	var active = Boolean(label || member || query);
	cardsIn(board).forEach(function (card) {
		var labels = (card.getAttribute("data-labels") || "").split(" ");
		var assignee = card.getAttribute("data-assignee") || "";
		var title = $(".ctitle", card).textContent.toLowerCase();
		var shown = (!label || labels.indexOf(label) >= 0)
			&& (!member || (member === "none" ? assignee === "" : assignee === member))
			&& (!query || title.indexOf(query) >= 0);
		card.classList.toggle("filtered-out", !shown);
	});
	$$(".column", board).forEach(function (column) {
		var list = $(".cards", column);
		var all = cardsIn(list).length;
		$(".count", column).textContent = active ? visibleCards(list).length + " of " + all : String(all);
	});
	document.getElementById("filter-status").textContent = active ? "Some cards are hidden by the filter." : "";
	var url = new URL(location.href);
	[["label", label], ["member", member], ["q", filterQuery.value.trim()]].forEach(function (pair) {
		if (pair[1]) url.searchParams.set(pair[0], pair[1]);
		else url.searchParams.delete(pair[0]);
	});
	history.replaceState(null, "", url.pathname + url.search);
}
function clearFilters() {
	filterLabel.value = "";
	filterMember.value = "";
	filterQuery.value = "";
	applyFilters();
}
filterLabel.addEventListener("change", applyFilters);
filterMember.addEventListener("change", applyFilters);
filterQuery.addEventListener("input", applyFilters);
document.getElementById("clear-filters").addEventListener("click", clearFilters);
applyFilters();

// ---- Label text -----------------------------------------------------------------------------
if (localStorage.getItem("trellis-labels-expanded") === "1") document.body.classList.add("labels-expanded");
function toggleLabelText() {
	var expanded = document.body.classList.toggle("labels-expanded");
	localStorage.setItem("trellis-labels-expanded", expanded ? "1" : "0");
}

// ---- Placing a dragged card -----------------------------------------------------------------
function makePlaceholder(card) {
	var placeholder = h("div", { class: "placeholder", "aria-hidden": "true" });
	placeholder.style.height = card.getBoundingClientRect().height + "px";
	return placeholder;
}
/** Put the placeholder above the first visible card whose middle is below y, or at the bottom. */
function placeIn(list, y, placeholder) {
	var before = null;
	var cards = visibleCards(list);
	for (var i = 0; i < cards.length; i++) {
		var rect = cards[i].getBoundingClientRect();
		if (y < rect.top + rect.height / 2) { before = cards[i]; break; }
	}
	if (before) { if (placeholder.nextElementSibling !== before) list.insertBefore(placeholder, before); }
	else if (list.lastElementChild !== placeholder) list.appendChild(placeholder);
}
function nextCardAfter(node, skip) {
	var next = node.nextElementSibling;
	while (next && (!next.classList.contains("kcard") || next === skip)) next = next.nextElementSibling;
	return next;
}
function sendMove(id, column, before) {
	return post("/api/cards/" + id + "/move", { column: column, before: before }).then(reload, function (error) {
		toast(error.message);
		setTimeout(reload, 1500);
	});
}
/** Drop the card where its placeholder is and record the move; nothing is sent when it did not move. */
function dropAt(card, placeholder, origin) {
	var list = placeholder.parentNode;
	if (!list) { card.classList.remove("dragging"); return; }
	var next = nextCardAfter(placeholder, card);
	var column = list.getAttribute("data-list");
	list.insertBefore(card, placeholder);
	placeholder.remove();
	card.classList.remove("dragging");
	var before = next ? cardId(next) : null;
	if (origin && origin.column === column && origin.before === before) return;
	sendMove(cardId(card), column, before);
}
function originOf(card) {
	var next = nextCardAfter(card, card);
	return { column: card.parentNode.getAttribute("data-list"), before: next ? cardId(next) : null };
}

// ---- Pointer dragging -----------------------------------------------------------------------
var drag = null;
var suppressClick = false;
function listAt(x, y) {
	var el = document.elementFromPoint(x, y);
	var column = el && el.closest ? el.closest("#board .column") : null;
	return column ? $(".cards", column) : null;
}
function beginPointerDrag() {
	var card = drag.card;
	var rect = card.getBoundingClientRect();
	drag.active = true;
	drag.origin = originOf(card);
	drag.offsetX = drag.startX - rect.left;
	drag.offsetY = drag.startY - rect.top;
	var ghost = card.cloneNode(true);
	ghost.classList.add("ghost");
	ghost.removeAttribute("data-card");
	ghost.removeAttribute("tabindex");
	ghost.setAttribute("aria-hidden", "true");
	ghost.style.width = rect.width + "px";
	document.body.appendChild(ghost);
	drag.ghost = ghost;
	drag.placeholder = makePlaceholder(card);
	card.parentNode.insertBefore(drag.placeholder, card);
	card.classList.add("dragging");
	document.body.classList.add("is-dragging");
	closeMenu();
	requestAnimationFrame(autoScroll);
}
function followPointer() {
	drag.ghost.style.left = drag.x - drag.offsetX + "px";
	drag.ghost.style.top = drag.y - drag.offsetY + "px";
	var list = listAt(drag.x, drag.y);
	if (list) placeIn(list, drag.y, drag.placeholder);
}
function autoScroll() {
	if (!drag || !drag.active) return;
	var list = listAt(drag.x, drag.y);
	if (list) {
		var rect = list.getBoundingClientRect();
		var delta = drag.y < rect.top + 36 ? -12 : drag.y > rect.bottom - 36 ? 12 : 0;
		if (delta !== 0) {
			var before = list.scrollTop;
			list.scrollTop += delta;
			if (list.scrollTop !== before) placeIn(list, drag.y, drag.placeholder);
		}
	}
	requestAnimationFrame(autoScroll);
}
function endPointerDrag(state, drop) {
	state.ghost.remove();
	document.body.classList.remove("is-dragging");
	suppressClick = true;
	setTimeout(function () { suppressClick = false; }, 0);
	if (!drop) {
		state.placeholder.remove();
		state.card.classList.remove("dragging");
		return;
	}
	dropAt(state.card, state.placeholder, state.origin);
}
if (T.drag === "pointer") {
	board.addEventListener("pointerdown", function (event) {
		if (event.button !== 0) return;
		var card = event.target.closest(".kcard");
		if (!card || event.target.closest("button, input, textarea, select")) return;
		drag = { card: card, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
	});
	document.addEventListener("pointermove", function (event) {
		if (!drag) return;
		drag.x = event.clientX;
		drag.y = event.clientY;
		if (!drag.active) {
			if (Math.abs(drag.x - drag.startX) + Math.abs(drag.y - drag.startY) < 6) return;
			beginPointerDrag();
		}
		event.preventDefault();
		followPointer();
	});
	document.addEventListener("pointerup", function (event) {
		if (!drag) return;
		var state = drag;
		drag = null;
		if (!state.active) return;
		state.x = event.clientX;
		state.y = event.clientY;
		var list = listAt(state.x, state.y);
		if (list) placeIn(list, state.y, state.placeholder);
		endPointerDrag(state, true);
	});
	document.addEventListener("pointercancel", function () {
		if (drag && drag.active) endPointerDrag(drag, false);
		drag = null;
	});
}

// ---- HTML drag and drop ---------------------------------------------------------------------
var native = null;
function columnFromEvent(event) {
	var target = event.target && event.target.closest ? event.target : event.target && event.target.parentElement;
	return target ? target.closest("#board .column") : null;
}
if (T.drag === "html5") {
	board.addEventListener("dragstart", function (event) {
		var card = event.target.closest ? event.target.closest(".kcard") : null;
		if (!card) return;
		native = { card: card, placeholder: makePlaceholder(card), origin: originOf(card) };
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("text/plain", cardId(card));
		}
		closeMenu();
		var state = native;
		// Hiding the card inside dragstart would cancel the drag, so it waits a tick.
		setTimeout(function () {
			if (native !== state) return;
			if (!state.placeholder.parentNode) card.parentNode.insertBefore(state.placeholder, card);
			card.classList.add("dragging");
		}, 0);
	});
	// A column accepts the card on dragenter as well as dragover: a drop right after the pointer
	// crosses into a new element is decided by that element's dragenter.
	function acceptDrag(event) {
		var column = columnFromEvent(event);
		if (!column || !native) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		placeIn($(".cards", column), event.clientY, native.placeholder);
	}
	board.addEventListener("dragenter", acceptDrag);
	board.addEventListener("dragover", acceptDrag);
	board.addEventListener("drop", function (event) {
		var column = columnFromEvent(event);
		if (!column) return;
		var state = native;
		if (!state && event.dataTransfer) {
			var dragged = cardEl(event.dataTransfer.getData("text/plain"));
			if (dragged) state = { card: dragged, placeholder: makePlaceholder(dragged), origin: originOf(dragged) };
		}
		if (!state) return;
		event.preventDefault();
		native = null;
		placeIn($(".cards", column), event.clientY, state.placeholder);
		dropAt(state.card, state.placeholder, state.origin);
	});
	board.addEventListener("dragend", function () {
		if (!native) return;
		native.placeholder.remove();
		native.card.classList.remove("dragging");
		native = null;
	});
}

// ---- Card menu ------------------------------------------------------------------------------
var menu = null;
function menuItem(text, key, action) {
	return h("button", { type: "button", role: "menuitem", class: "menu-item", onclick: function () { closeMenu(); action(); } }, [
		h("span", { text: text }),
		h("kbd", { text: key }),
	]);
}
function openMenu(card, anchor) {
	closeMenu();
	var id = cardId(card);
	var rect = anchor.getBoundingClientRect();
	menu = h("div", { class: "menu", role: "menu", "aria-label": "Card actions" }, [
		menuItem("Open card", "Enter", function () { openCard(id); }),
		menuItem("Edit title", "E", function () { startTitleEdit(cardEl(id)); }),
		menuItem("Move to…", "M", function () { openMoveDialog(id); }),
		menuItem("Archive", "C", function () { archive(id); }),
	]);
	menu.setAttribute("data-for", id);
	menu.style.left = Math.min(rect.left, window.innerWidth - 210) + "px";
	menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 160) + "px";
	document.body.appendChild(menu);
	$(".menu-item", menu).focus();
}
function closeMenu() {
	if (!menu) return;
	menu.remove();
	menu = null;
}
document.addEventListener("pointerdown", function (event) {
	if (menu && !menu.contains(event.target) && !event.target.closest(".menu-btn")) closeMenu();
}, true);

// ---- Clicks on the board --------------------------------------------------------------------
var clickTimer = null;
board.addEventListener("click", function (event) {
	if (suppressClick) return;
	var target = event.target;
	var menuButton = target.closest(".menu-btn");
	if (menuButton) {
		event.stopPropagation();
		var owner = menuButton.closest(".kcard");
		if (menu && menu.getAttribute("data-for") === cardId(owner)) closeMenu();
		else openMenu(owner, menuButton);
		return;
	}
	var add = target.closest(".add-card");
	if (add) { openComposer(add.closest(".column")); return; }
	if (target.closest(".chip")) { toggleLabelText(); return; }
	var card = target.closest(".kcard");
	if (!card || target.closest("input, textarea, button, select")) return;
	// The second click of a double-click on the title edits it instead of opening the card.
	if (event.detail > 1 && target.closest(".ctitle")) {
		clearTimeout(clickTimer);
		clickTimer = null;
		return;
	}
	if (event.detail > 1) return;
	clearTimeout(clickTimer);
	clickTimer = setTimeout(function () {
		clickTimer = null;
		openCard(cardId(card));
	}, 280);
});
board.addEventListener("dblclick", function (event) {
	var title = event.target.closest(".ctitle");
	if (!title) return;
	clearTimeout(clickTimer);
	clickTimer = null;
	startTitleEdit(title.closest(".kcard"));
});

// ---- Inline title editing -------------------------------------------------------------------
function startTitleEdit(card) {
	if (!card || $(".title-input", card)) return;
	var title = $(".ctitle", card);
	var original = title.textContent;
	var input = h("input", { class: "title-input", value: original, "aria-label": "Card title", maxlength: "120" });
	var finished = false;
	function finish(save) {
		if (finished) return;
		finished = true;
		var value = input.value.replace(/\s+/g, " ").trim();
		input.remove();
		title.hidden = false;
		if (!save || !value || value === original) return;
		title.textContent = value;
		post("/api/cards/" + cardId(card), { title: value }).catch(function (error) {
			title.textContent = original;
			toast(error.message);
		});
	}
	input.addEventListener("keydown", function (event) {
		event.stopPropagation();
		if (event.key === "Enter") { event.preventDefault(); finish(true); }
		else if (event.key === "Escape") { event.preventDefault(); finish(false); }
	});
	input.addEventListener("blur", function () { finish(true); });
	input.addEventListener("click", function (event) { event.stopPropagation(); });
	title.hidden = true;
	title.parentNode.insertBefore(input, title.nextSibling);
	input.focus();
	input.select();
}

// ---- Adding a card --------------------------------------------------------------------------
var composer = null;
function closeComposer() {
	if (!composer) return;
	composer.el.remove();
	composer.button.hidden = false;
	composer = null;
}
function openComposer(column) {
	closeComposer();
	var button = $(".add-card", column);
	var field = h("textarea", { "aria-label": "Title of the new card", placeholder: "Enter a title for this card…", maxlength: "120" });
	function submit() {
		var title = field.value.replace(/\s+/g, " ").trim();
		if (!title) { field.focus(); return; }
		post("/api/boards/" + T.board + "/cards", { column: column.getAttribute("data-column"), title: title }).then(reload, function (error) { toast(error.message); });
	}
	var el = h("div", { class: "composer" }, [
		field,
		h("div", { class: "row" }, [
			h("button", { type: "button", text: "Add card", onclick: submit }),
			h("button", { type: "button", class: "secondary", text: "Cancel", onclick: closeComposer }),
		]),
	]);
	field.addEventListener("keydown", function (event) {
		event.stopPropagation();
		if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
		else if (event.key === "Escape") { event.preventDefault(); closeComposer(); }
	});
	button.hidden = true;
	button.parentNode.appendChild(el);
	composer = { el: el, button: button };
	field.focus();
}

// ---- Archiving ------------------------------------------------------------------------------
function archive(id) {
	post("/api/cards/" + id + "/archive").then(reload, function (error) { toast(error.message); });
}

// ---- The card modal -------------------------------------------------------------------------
var modal = null;
var modalDirty = false;
var labelsOpen = false;
var modalCard = null;
var calendar = null;
function openCard(id) {
	closeMenu();
	fetch("/api/cards/" + id).then(function (response) { return response.json(); }).then(function (data) {
		if (data.error) { toast(data.error); return; }
		modalDirty = false;
		labelsOpen = false;
		renderModal(data.card);
	});
}
function closeModal(keep) {
	if (!modal) return;
	modal.remove();
	modal = null;
	calendar = null;
	labelsOpen = false;
	if (modalDirty && !keep) reload();
}
function change(card, path, body, onError) {
	return post("/api/cards/" + card.id + path, body).then(function (data) {
		modalDirty = true;
		renderModal(data.card);
		return data.card;
	}, function (error) {
		if (onError) onError(error.message);
		else toast(error.message);
	});
}
function pad(n) { return n < 10 ? "0" + n : String(n); }
function isoOf(year, month, day) { return year + "-" + pad(month + 1) + "-" + pad(day); }
function slashOf(iso) {
	var parts = iso.split("-").map(Number);
	return parts[1] + "/" + parts[2] + "/" + parts[0];
}
function parseSlash(value) {
	var match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
	if (!match) return null;
	return isoOf(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
}
var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function renderCalendar(state, input) {
	var first = new Date(Date.UTC(state.year, state.month, 1));
	var days = new Date(Date.UTC(state.year, state.month + 1, 0)).getUTCDate();
	var selected = parseSlash(input.value);
	var cells = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(function (name) { return h("span", { class: "dow", text: name }); });
	for (var blank = 0; blank < first.getUTCDay(); blank++) cells.push(h("span"));
	for (var day = 1; day <= days; day++) {
		var iso = isoOf(state.year, state.month, day);
		cells.push(h("button", {
			type: "button",
			"data-date": iso,
			"aria-label": MONTHS[state.month] + " " + day + ", " + state.year,
			class: (iso === T.today ? "today " : "") + (iso === selected ? "selected" : ""),
			text: String(day),
			onclick: (function (value) {
				return function () {
					input.value = slashOf(value);
					closeCalendar();
					input.focus();
				};
			})(iso),
		}));
	}
	state.el.replaceChildren(
		h("div", { class: "calendar-head" }, [
			h("button", { type: "button", class: "secondary", "aria-label": "Previous month", text: "‹", onclick: function () { shiftMonth(state, input, -1); } }),
			h("strong", { "aria-live": "polite", text: MONTHS[state.month] + " " + state.year }),
			h("button", { type: "button", class: "secondary", "aria-label": "Next month", text: "›", onclick: function () { shiftMonth(state, input, 1); } }),
		]),
		h("div", { class: "calendar-grid" }, cells),
	);
}
function shiftMonth(state, input, delta) {
	state.month += delta;
	if (state.month < 0) { state.month = 11; state.year--; }
	if (state.month > 11) { state.month = 0; state.year++; }
	renderCalendar(state, input);
}
function toggleCalendar(section, input, card) {
	if (calendar) { closeCalendar(); return; }
	var base = (parseSlash(input.value) || card.due || T.today).split("-").map(Number);
	calendar = { year: base[0], month: base[1] - 1, el: h("div", { class: "popover", role: "dialog", "aria-label": "Choose a due date" }) };
	calendar.el.style.top = "64px";
	calendar.el.style.left = "0";
	renderCalendar(calendar, input);
	section.appendChild(calendar.el);
}
function closeCalendar() {
	if (!calendar) return;
	calendar.el.remove();
	calendar = null;
}
function labelPopover(card) {
	var options = T.labels.map(function (label) {
		var on = card.labels.indexOf(label.id) >= 0;
		return h("button", {
			type: "button",
			class: "label-option",
			role: "menuitemcheckbox",
			"aria-checked": on ? "true" : "false",
			onclick: function () { change(card, "/labels", { label: label.id, on: !on }); },
		}, [h("span", { class: "swatch", style: "background:" + label.color }), h("span", { text: label.name }), h("span", { text: on ? "✓" : "" })]);
	});
	var popover = h("div", { class: "popover", role: "menu", "aria-label": "Labels" }, [
		h("div", { class: "row", style: "justify-content:space-between" }, [
			h("strong", { text: "Labels" }),
			h("button", { type: "button", class: "secondary", "aria-label": "Close labels", text: "×", onclick: function () { labelsOpen = false; renderModal(card); } }),
		]),
	].concat(options));
	popover.style.top = "56px";
	popover.style.left = "0";
	return popover;
}
function renderModal(card) {
	if (!modal) {
		modal = h("div", { class: "overlay", id: "card-overlay" });
		modal.addEventListener("pointerdown", function (event) { if (event.target === modal) closeModal(); });
		document.body.appendChild(modal);
	}
	calendar = null;
	modalCard = card;
	var chips = card.labels.map(function (id) {
		var label = labelOf(id);
		return h("span", { class: "modal-chip", style: "background:" + label.color, text: label.name });
	});
	var labelsSection = h("section", { "aria-label": "Labels" }, [
		h("h3", { text: "Labels" }),
		h("div", { class: "row" }, chips.concat([
			h("button", {
				type: "button",
				class: "secondary",
				id: "cd-labels",
				"aria-haspopup": "menu",
				"aria-expanded": labelsOpen ? "true" : "false",
				text: "Edit labels",
				onclick: function () { labelsOpen = !labelsOpen; renderModal(card); },
			}),
		])),
		labelsOpen ? labelPopover(card) : null,
	]);
	var assignee = h("select", { id: "cd-assignee", "aria-label": "Assignee" }, [h("option", { value: "", text: "Unassigned" })].concat(
		T.members.map(function (member) { return h("option", { value: member.id, text: member.name }); }),
	));
	assignee.value = card.assignee || "";
	assignee.addEventListener("change", function () { change(card, "", { assignee: assignee.value || null }); });
	var dueInput = h("input", { id: "cd-due", "aria-label": "Due date", placeholder: "M/D/YYYY", autocomplete: "off", value: card.due ? slashOf(card.due) : "" });
	var dueError = h("div", { class: "error", id: "cd-due-error", role: "alert" });
	function saveDue() {
		dueError.textContent = "";
		change(card, "", { due: dueInput.value }, function (message) { dueError.textContent = message; });
	}
	dueInput.addEventListener("keydown", function (event) { if (event.key === "Enter") { event.preventDefault(); saveDue(); } });
	var dueSection = h("section", { "aria-label": "Due date" }, [
		h("h3", { text: "Due date" }),
		h("div", { class: "row" }, [
			dueInput,
			h("button", { type: "button", class: "secondary", id: "cd-calendar", "aria-haspopup": "dialog", text: "Calendar", onclick: function () { toggleCalendar(dueSection, dueInput, card); } }),
			h("button", { type: "button", id: "cd-due-save", text: "Save", onclick: saveDue }),
			card.due ? h("button", { type: "button", class: "secondary", id: "cd-due-remove", text: "Remove", onclick: function () { change(card, "", { due: null }); } }) : null,
		]),
		dueError,
	]);
	var items = card.checklist.map(function (item) {
		var box = h("input", { type: "checkbox", checked: item.done, "aria-label": item.text });
		box.addEventListener("change", function () { change(card, "/checklist/" + item.id, { done: box.checked }); });
		return h("li", { class: item.done ? "done" : "" }, [
			h("label", {}, [box, h("span", { text: item.text })]),
			h("button", { type: "button", class: "secondary", "aria-label": "Delete item " + item.text, text: "×", onclick: function () { change(card, "/checklist/" + item.id + "/delete", {}); } }),
		]);
	});
	var newItem = h("input", { id: "cd-check-new", "aria-label": "New checklist item", placeholder: "Add an item", maxlength: "120" });
	function addItem() {
		var text = newItem.value.replace(/\s+/g, " ").trim();
		if (!text) return;
		change(card, "/checklist", { text: text }).then(function (updated) { if (updated) $("#cd-check-new").focus(); });
	}
	newItem.addEventListener("keydown", function (event) { if (event.key === "Enter") { event.preventDefault(); addItem(); } });
	var doneCount = card.checklist.filter(function (item) { return item.done; }).length;
	var comment = h("textarea", { id: "cd-comment", "aria-label": "Write a comment", placeholder: "Write a comment…" });
	var dialog = h("div", { class: "dialog card-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "cd-title" }, [
		h("button", { type: "button", class: "close", "aria-label": "Close", text: "×", onclick: function () { closeModal(); } }),
		h("div", { class: "muted", text: card.key + " · in list " + columnName(card.column) }),
		h("h2", { id: "cd-title", text: card.title }),
		card.completed ? h("p", { class: "notice", text: "Completed on " + card.completedLong }) : null,
		labelsSection,
		h("section", { "aria-label": "Assignee" }, [h("h3", { text: "Assignee" }), assignee]),
		dueSection,
		h("section", { "aria-label": "Checklist" }, [
			h("h3", { text: "Checklist " + (card.checklist.length ? doneCount + "/" + card.checklist.length : "") }),
			h("ul", { class: "checklist" }, items),
			h("div", { class: "row", style: "margin-top:6px" }, [newItem, h("button", { type: "button", id: "cd-check-add", text: "Add", onclick: addItem })]),
		]),
		h("section", { "aria-label": "Comments" }, [
			h("h3", { text: "Comments" }),
			h("div", {}, card.comments.map(function (entry) {
				return h("div", { class: "comment" }, [h("strong", { text: entry.author }), h("span", { class: "muted", text: " · " + entry.date }), h("div", { text: entry.body })]);
			})),
			comment,
			h("div", { class: "row" }, [h("button", { type: "button", class: "secondary", text: "Comment", onclick: function () {
				var body = comment.value.trim();
				if (body) change(card, "/comments", { body: body });
			} })]),
		]),
		h("div", { class: "row", style: "margin-top:16px" }, [
			h("button", { type: "button", class: "secondary", id: "cd-move", text: "Move…", onclick: function () { closeModal(true); openMoveDialog(card.id); } }),
			h("button", { type: "button", class: "secondary", id: "cd-archive", text: "Archive", onclick: function () { archive(card.id); } }),
		]),
	]);
	modal.replaceChildren(dialog);
}

// ---- Move dialog ----------------------------------------------------------------------------
var moveDialog = null;
function closeMoveDialog() {
	if (!moveDialog) return;
	moveDialog.remove();
	moveDialog = null;
	if (modalDirty) reload();
}
function openMoveDialog(id) {
	closeMenu();
	var card = cardEl(id);
	if (!card) return;
	var from = card.parentNode.getAttribute("data-list");
	var columnSelect = h("select", { id: "move-column", "aria-label": "Column" }, T.columns.map(function (column) {
		return h("option", { value: column.id, text: column.name });
	}));
	columnSelect.value = from;
	var positionSelect = h("select", { id: "move-position", "aria-label": "Position" });
	function others(column) {
		return cardsIn(listOf(column)).map(cardId).filter(function (other) { return other !== id; });
	}
	function fillPositions() {
		var column = columnSelect.value;
		var count = others(column).length + 1;
		var options = [];
		for (var position = 1; position <= count; position++) {
			var note = position === 1 ? " (top)" : position === count ? " (bottom)" : "";
			options.push(h("option", { value: String(position), text: position + note }));
		}
		positionSelect.replaceChildren.apply(positionSelect, options);
		positionSelect.value = column === from ? String(cardsIn(listOf(column)).indexOf(card) + 1) : "1";
	}
	columnSelect.addEventListener("change", fillPositions);
	fillPositions();
	function submit() {
		var column = columnSelect.value;
		var position = Number(positionSelect.value);
		var ids = others(column);
		var before = ids[position - 1] || null;
		sendMove(id, column, before);
	}
	moveDialog = h("div", { class: "overlay", id: "move-overlay" }, [
		h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "move-title" }, [
			h("h2", { id: "move-title", text: "Move card" }),
			h("p", { class: "muted", text: $(".ctitle", card).textContent }),
			h("label", {}, ["Column ", columnSelect]),
			h("label", {}, ["Position ", positionSelect]),
			h("p", { class: "muted", text: "Positions count every card in the column, including cards the filter hides." }),
			h("div", { class: "row" }, [
				h("button", { type: "button", id: "move-submit", text: "Move", onclick: submit }),
				h("button", { type: "button", class: "secondary", text: "Cancel", onclick: closeMoveDialog }),
			]),
		]),
	]);
	moveDialog.addEventListener("pointerdown", function (event) { if (event.target === moveDialog) closeMoveDialog(); });
	document.body.appendChild(moveDialog);
	columnSelect.focus();
}

// ---- Keyboard shortcuts ---------------------------------------------------------------------
var help = null;
var SHORTCUTS = [
	["?", "Show or hide this list"],
	["/", "Search card titles"],
	["x", "Clear every filter"],
	["j or ↓", "Focus the next card in the column"],
	["k or ↑", "Focus the previous card in the column"],
	["h or ←", "Focus a card in the column to the left"],
	["l or →", "Focus a card in the column to the right"],
	["Enter", "Open the focused card"],
	["e", "Edit the focused card's title"],
	["m", "Move the focused card (Move to…)"],
	["c", "Archive the focused card"],
	["Esc", "Close the open dialog, popover or menu"],
];
function toggleHelp() {
	if (help) { help.remove(); help = null; return; }
	help = h("div", { class: "overlay", id: "help-overlay" }, [
		h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "help-title" }, [
			h("button", { type: "button", class: "close", "aria-label": "Close", text: "×", onclick: toggleHelp }),
			h("h2", { id: "help-title", text: "Keyboard shortcuts" }),
			h("p", { class: "muted", text: "Shortcuts act on the focused card, or else on the card under the pointer. In a card's menu they act on that card." }),
			h("table", { class: "help-table" }, SHORTCUTS.map(function (row) {
				return h("tr", {}, [h("td", {}, [h("kbd", { text: row[0] })]), h("td", { text: row[1] })]);
			})),
		]),
	]);
	help.addEventListener("pointerdown", function (event) { if (event.target === help) toggleHelp(); });
	document.body.appendChild(help);
}
document.getElementById("help-button").addEventListener("click", toggleHelp);
var hovered = null;
board.addEventListener("pointerover", function (event) {
	var card = event.target.closest(".kcard");
	if (card) hovered = card;
});
board.addEventListener("pointerleave", function () { hovered = null; });
function activeCard() {
	if (menu) return cardEl(menu.getAttribute("data-for"));
	var focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest("#board .kcard") : null;
	return focused || hovered;
}
function focusCard(card) {
	if (!card) return;
	card.focus();
	card.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function stepCard(card, delta) {
	if (!card) { focusCard(visibleCards(board)[0]); return; }
	var cards = visibleCards(card.parentNode);
	var index = cards.indexOf(card) + delta;
	if (index >= 0 && index < cards.length) focusCard(cards[index]);
}
function stepColumn(card, delta) {
	var lists = $$(".cards", board);
	if (!card) { focusCard(visibleCards(board)[0]); return; }
	var from = lists.indexOf(card.parentNode);
	var row = visibleCards(card.parentNode).indexOf(card);
	for (var index = from + delta; index >= 0 && index < lists.length; index += delta) {
		var cards = visibleCards(lists[index]);
		if (cards.length) { focusCard(cards[Math.min(row, cards.length - 1)]); return; }
	}
}
function closeTopmost() {
	if (calendar) closeCalendar();
	else if (labelsOpen && modal) { labelsOpen = false; renderModal(modalCard); }
	else if (moveDialog) closeMoveDialog();
	else if (modal) closeModal();
	else if (help) toggleHelp();
	else if (menu) closeMenu();
	else if (composer) closeComposer();
}
document.addEventListener("keydown", function (event) {
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	var target = event.target;
	if (event.key === "Escape") { closeTopmost(); return; }
	var typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
	if (typing) return;
	if (target && target.closest && target.closest(".menu") && (event.key === "Enter" || event.key === " ")) return;
	if (modal || moveDialog) return;
	if (event.key === "?") { event.preventDefault(); toggleHelp(); return; }
	if (help) return;
	if (event.key === "/") { event.preventDefault(); filterQuery.focus(); return; }
	if (event.key === "x") { event.preventDefault(); clearFilters(); return; }
	var card = activeCard();
	switch (event.key) {
		case "j": case "ArrowDown": event.preventDefault(); stepCard(card, 1); return;
		case "k": case "ArrowUp": event.preventDefault(); stepCard(card, -1); return;
		case "h": case "ArrowLeft": event.preventDefault(); stepColumn(card, -1); return;
		case "l": case "ArrowRight": event.preventDefault(); stepColumn(card, 1); return;
	}
	if (!card) return;
	var id = cardId(card);
	if (event.key === "Enter") { event.preventDefault(); closeMenu(); openCard(id); }
	else if (event.key === "e") { event.preventDefault(); closeMenu(); startTitleEdit(card); }
	else if (event.key === "m") { event.preventDefault(); openMoveDialog(id); }
	else if (event.key === "c") { event.preventDefault(); closeMenu(); archive(id); }
});
})();
`;

export const ARCHIVE_SCRIPT = String.raw`
document.querySelectorAll("[data-restore]").forEach(function (button) {
	button.addEventListener("click", function () {
		button.disabled = true;
		fetch("/api/cards/" + button.getAttribute("data-restore") + "/restore", { method: "POST" }).then(function () { location.reload(); });
	});
});
`;
