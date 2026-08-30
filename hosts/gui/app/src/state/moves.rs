//! Every move over the store.
//!
//! One function per thing the operator can do, each taking `&mut Store` and
//! returning nothing or the one value the caller needs. No toolkit, no clock,
//! no IO: the time a move happens is passed in, so a move is called from a test
//! the same way the window calls it.

use super::model::{
	Appearance, FONT_MAX, FONT_MIN, Message, Overlay, Palette, PaletteRow, ProjectId, Route,
	SESSION_TITLE_UNTITLED, Session, SessionId, SettingsPage, Store,
};

/// How long a notice stays under the composer.
const NOTICE_MS: u64 = 4_000;

/// How long a session title may be before it is cut at a word. A title is one
/// stored string that several surfaces show at different widths, so this is the
/// bound on what is kept, not on what any row displays: the sidebar row and the
/// header both shorten it again to the space they have.
pub const TITLE_MAX: usize = 120;

/// Select a conversation and put the route back on it.
pub fn select(store: &mut Store, id: &SessionId) {
	if store.session(id).is_none() {
		return;
	}
	store.selected = Some(id.clone());
	store.route = Route::Chat;
	store.overlay = Overlay::None;
}

/// Move the selection one row through the drawn order, wrapping at both ends.
pub fn cycle(store: &mut Store, forward: bool) {
	let order = store.visible_order();
	if order.is_empty() {
		return;
	}
	let at = store
		.selected
		.as_ref()
		.and_then(|id| order.iter().position(|row| row == id));
	let next = match (at, forward) {
		(Some(at), true) => (at + 1) % order.len(),
		(Some(at), false) => (at + order.len() - 1) % order.len(),
		(None, true) => 0,
		(None, false) => order.len() - 1,
	};
	let id = order[next].clone();
	select(store, &id);
}

/// Fold or unfold a checkout's group.
pub fn toggle_project(store: &mut Store, id: &ProjectId) {
	if let Some(project) = store.projects.iter_mut().find(|project| &project.id == id) {
		project.collapsed = !project.collapsed;
	}
}

pub fn toggle_sidebar(store: &mut Store) {
	store.settings.sidebar_open = !store.settings.sidebar_open;
}

/// Set the sidebar width from a drag, clamped.
pub fn set_sidebar_width(store: &mut Store, width: f32) {
	store.settings.sidebar_width = width.clamp(super::model::SIDEBAR_MIN, super::model::SIDEBAR_MAX);
}

/// Return the sidebar to its opening width, which is what a double-click on the
/// handle is for.
pub fn reset_sidebar_width(store: &mut Store) {
	store.settings.sidebar_width = super::model::SIDEBAR_DEFAULT;
}

/// Start a conversation in the selected checkout and select it.
pub fn new_session(store: &mut Store) -> SessionId {
	let project = store
		.selected_session()
		.map(|session| session.project.clone())
		.or_else(|| store.projects.first().map(|project| project.id.clone()))
		.unwrap_or_else(|| ProjectId::new("cwd"));
	let ordinal = store.next_session;
	store.next_session += 1;
	let id = SessionId::new(format!("s{ordinal}"));
	let mut session = Session::new(id.as_str(), &project, SESSION_TITLE_UNTITLED);
	session.updated_ms = store.now_ms;
	store.sessions.push(session);
	select(store, &id);
	id
}

/// Delete a conversation, which is the only way one leaves the list.
///
/// The last one is not deletable: an empty list has nothing to type into, and a
/// window whose composer points at nothing takes a keystroke and drops it.
pub fn delete_session(store: &mut Store, id: &SessionId) {
	if store.sessions.len() < 2 {
		return;
	}
	let Some(at) = store.sessions.iter().position(|session| &session.id == id) else {
		return;
	};
	let title = store.sessions.remove(at).title;
	if store.selected.as_ref() == Some(id) {
		store.selected = store.visible_order().first().cloned();
	}
	notify(store, format!("Deleted {title}"));
}

/// Replace the selected conversation's draft and caret. The text element owns
/// the editing; the store owns the draft, so switching conversations and coming
/// back finds what was typed.
pub fn set_draft(store: &mut Store, text: String, caret: usize) {
	if let Some(session) = store.selected_session_mut() {
		session.caret = caret.min(text.len());
		session.draft = text;
	}
}

/// Send the draft: it becomes a message in the transcript, and the conversation
/// takes its name from the first one. Returns whether anything was sent, so the
/// caller knows whether to clear its input element.
///
/// Nothing answers. No engine is attached, and the window says so under the
/// last message rather than inventing a reply.
pub fn send(store: &mut Store) -> bool {
	let now = store.now_ms;
	let Some(session) = store.selected_session_mut() else {
		return false;
	};
	let text = session.draft.trim().to_owned();
	if text.is_empty() {
		return false;
	}
	let id = session.next_message_id();
	if session.messages.is_empty() {
		session.title = title_from(&text);
	}
	session.messages.push(Message::written(id, now, &text));
	session.draft.clear();
	session.caret = 0;
	session.updated_ms = now;
	true
}

/// What a conversation is called once its first message names it: the first
/// line, cut at a word.
pub fn title_from(text: &str) -> String {
	let line = text
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.unwrap_or(SESSION_TITLE_UNTITLED);
	if line.chars().count() <= TITLE_MAX {
		return line.to_owned();
	}
	let mut cut = String::new();
	for word in line.split_whitespace() {
		if cut.chars().count() + word.chars().count() + 1 > TITLE_MAX {
			break;
		}
		if !cut.is_empty() {
			cut.push(' ');
		}
		cut.push_str(word);
	}
	if cut.is_empty() {
		cut.extend(line.chars().take(TITLE_MAX));
	}
	cut
}

/// Retire the notice if its time is up. Returns whether anything moved, so the
/// caller only asks for another frame when it has to.
pub fn tick(store: &mut Store, now_ms: u64) -> bool {
	store.now_ms = now_ms;
	if let Some(until) = store.notice_until
		&& now_ms >= until
	{
		store.notice = None;
		store.notice_until = None;
		return true;
	}
	false
}

/// Say something under the composer for a few seconds.
pub fn notify(store: &mut Store, text: impl Into<String>) {
	store.notice = Some(text.into());
	store.notice_until = Some(store.now_ms + NOTICE_MS);
}

/// Open the palette over whatever is on screen.
pub fn open_palette(store: &mut Store) {
	store.overlay = Overlay::Palette(Palette { query: String::new(), selected: 0 });
}

/// Close whatever is open.
pub fn close_overlay(store: &mut Store) {
	store.overlay = Overlay::None;
}

/// Type into the palette, which resets the cursor to the first match.
pub fn palette_query(store: &mut Store, query: String) {
	if let Overlay::Palette(palette) = &mut store.overlay {
		palette.query = query;
		palette.selected = 0;
	}
}

/// Move the palette cursor, clamped to the matches rather than wrapping: a list
/// that wraps under a held key never settles at either end.
pub fn palette_move(store: &mut Store, delta: isize) {
	let count = palette_rows(store).len();
	if count == 0 {
		return;
	}
	if let Overlay::Palette(palette) = &mut store.overlay {
		let at = palette.selected as isize + delta;
		palette.selected = at.clamp(0, count as isize - 1) as usize;
	}
}

/// Take the highlighted palette row.
pub fn palette_accept(store: &mut Store) {
	let rows = palette_rows(store);
	let Some(palette) = store.overlay.palette() else {
		return;
	};
	let Some(row) = rows.get(palette.selected) else {
		return;
	};
	let key = row.key.clone();
	store.overlay = Overlay::None;
	match key.strip_prefix("session:") {
		Some(id) => select(store, &SessionId::new(id)),
		None => run_action(store, &key),
	}
}

/// Every command the palette can run, by key. One table, so the palette and the
/// keymap name the same set.
pub fn actions() -> Vec<(&'static str, &'static str)> {
	vec![
		("new-session", "New conversation"),
		("delete-session", "Delete this conversation"),
		("toggle-sidebar", "Show or hide the conversation list"),
		("settings", "Settings"),
		("flip-appearance", "Light or dark appearance"),
	]
}

/// Carry out a command by key.
pub fn run_action(store: &mut Store, key: &str) {
	match key {
		"new-session" => {
			new_session(store);
		},
		"delete-session" => {
			if let Some(id) = store.selected.clone() {
				delete_session(store, &id);
			}
		},
		"toggle-sidebar" => toggle_sidebar(store),
		"settings" => open_settings(store, SettingsPage::Appearance),
		"flip-appearance" => {
			store.settings.appearance = store.settings.appearance.flipped();
		},
		_ => notify(store, format!("No command named {key}")),
	}
}

/// The palette's rows for its current query, in the order it draws them.
///
/// Filtering lives here rather than in the view so the cursor, the accept and
/// the drawn list read one list.
pub fn palette_rows(store: &Store) -> Vec<PaletteRow> {
	let Some(palette) = store.overlay.palette() else {
		return Vec::new();
	};
	let query = palette.query.trim().to_lowercase();
	let matches = |haystack: &str| query.is_empty() || haystack.to_lowercase().contains(&query);

	// The checkout a conversation belongs to is worth a column only when there
	// is more than one of them. One repeated down the list says nothing and
	// crowds the title it sits beside.
	let name_checkouts = store.projects.len() > 1;
	let mut rows: Vec<PaletteRow> = store
		.sessions
		.iter()
		.filter(|session| matches(&session.title))
		.map(|session| PaletteRow {
			key:     format!("session:{}", session.id.as_str()),
			label:   session.title.clone(),
			detail:  if name_checkouts {
				store
					.project(&session.project)
					.map(|project| project.name.clone())
					.unwrap_or_default()
			} else {
				String::new()
			},
			current: store.selected.as_ref() == Some(&session.id),
		})
		.collect();
	rows.extend(
		actions()
			.into_iter()
			// A command matches on its label alone. Matching a key as well
			// returns rows whose text does not contain what was typed, and a
			// list that answers "app" with a line about light and dark reads as
			// a wrong answer.
			.filter(|(_, label)| matches(label))
			.map(|(key, label)| PaletteRow {
				key:     key.to_owned(),
				label:   label.to_owned(),
				detail:  "Command".to_owned(),
				current: false,
			}),
	);
	rows
}

/// Open a settings page.
pub fn open_settings(store: &mut Store, page: SettingsPage) {
	store.route = Route::Settings(page);
	store.overlay = Overlay::None;
}

/// Leave settings for the conversation.
pub fn close_settings(store: &mut Store) {
	store.route = Route::Chat;
}

/// Set the appearance directly.
pub fn set_appearance(store: &mut Store, appearance: Appearance) {
	store.settings.appearance = appearance;
}

/// Set the text size, clamped to what the window can draw.
pub fn set_font_size(store: &mut Store, size: f32) {
	store.settings.font_size = size.clamp(FONT_MIN, FONT_MAX);
}

/// Group the conversation list by checkout, or run it flat.
pub fn toggle_group_by_folder(store: &mut Store) {
	store.settings.group_by_folder = !store.settings.group_by_folder;
}
