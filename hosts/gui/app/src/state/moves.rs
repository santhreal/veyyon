//! Every move over the store.
//!
//! One function per thing the operator can do, each taking `&mut Store` and
//! returning nothing or the one value the caller needs. No toolkit, no clock,
//! no IO: the time a move happens is passed in, so a move is called from a test
//! the same way the window calls it.
//!
//! What is NOT here: how a reply is composed, which is `super::agent`, and what
//! the window looks like, which is every module outside `state`.

use super::{
	agent,
	model::{
		Activity, Appearance, Block, Message, Overlay, Palette, PaletteKind, PaletteRow, ProjectId,
		Role, Route, SESSION_TITLE_UNTITLED, Session, SessionId, SettingsPage, Store, TERMINAL_MIN,
		TerminalTab,
	},
};

/// How long a notice stays under the composer.
const NOTICE_MS: u64 = 4_000;

/// Select a session, which clears its unread mark and moves the route back to
/// the conversation.
///
/// Selecting is also how a `Done` session settles: it has been read, so it
/// stops asking. Nothing else in the app marks a session read, because nothing
/// else means the operator looked at it.
pub fn select(store: &mut Store, id: &SessionId) {
	if store.session(id).is_none() {
		return;
	}
	store.selected = Some(id.clone());
	store.route = Route::Chat;
	store.overlay = Overlay::None;
	if let Some(session) = store.session_mut(id) {
		session.unread = false;
		if session.status == Activity::Done {
			session.status = Activity::Idle;
		}
	}
}

/// Move the selection one row through the drawn order, wrapping at both ends.
///
/// With nothing selected the cursor enters at the end it would have wrapped to,
/// so the first press from the new-session canvas lands on a row rather than
/// doing nothing.
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

/// Fold or unfold a project's group.
pub fn toggle_project(store: &mut Store, id: &ProjectId) {
	if let Some(project) = store.projects.iter_mut().find(|project| &project.id == id) {
		project.collapsed = !project.collapsed;
	}
}

/// Show or hide the sidebar.
pub fn toggle_sidebar(store: &mut Store) {
	store.settings.sidebar_open = !store.settings.sidebar_open;
}

/// Set the sidebar width from a drag, clamped.
pub fn set_sidebar_width(store: &mut Store, width: f32) {
	store.settings.sidebar_width = width.clamp(super::model::SIDEBAR_MIN, super::model::SIDEBAR_MAX);
	store.settings.sidebar_open = true;
}

/// Return the sidebar to its default width, which is what a double-click on the
/// handle does.
pub fn reset_sidebar_width(store: &mut Store) {
	store.settings.sidebar_width = super::model::SIDEBAR_DEFAULT;
}

/// Open or close the terminal panel.
pub fn toggle_terminal(store: &mut Store) {
	store.terminal.open = !store.terminal.open;
}

/// Set the panel height from a drag, floored. The ceiling is the viewport's, so
/// it belongs to the view and is applied there.
pub fn set_terminal_height(store: &mut Store, height: f32, ceiling: f32) {
	store.terminal.height = height.clamp(TERMINAL_MIN, ceiling.max(TERMINAL_MIN));
	store.terminal.open = true;
}

/// Select a terminal tab.
pub fn select_terminal_tab(store: &mut Store, index: usize) {
	if index < store.terminal.tabs.len() {
		store.terminal.active = index;
	}
}

/// Close a terminal tab, keeping the selection on a neighbour.
pub fn close_terminal_tab(store: &mut Store, index: usize) {
	if index >= store.terminal.tabs.len() {
		return;
	}
	store.terminal.tabs.remove(index);
	if store.terminal.tabs.is_empty() {
		store.terminal.active = 0;
		store.terminal.open = false;
		return;
	}
	store.terminal.active = store.terminal.active.min(store.terminal.tabs.len() - 1);
}

/// Start a command in a new tab, open the panel, and select it.
///
/// Without an engine the command is one of the scripted ones; the tab, its
/// streaming output and its exit code are the same values a real command would
/// fill in.
pub fn run_command(store: &mut Store, command: &str) {
	let cwd = store
		.selected_session()
		.and_then(|session| store.project(&session.project))
		.map_or_else(|| "~".to_owned(), |project| project.path.clone());
	let id = store
		.terminal
		.tabs
		.iter()
		.map(|tab| tab.id)
		.max()
		.unwrap_or(0)
		+ 1;
	let (lines, exit) = agent::command_output(command);
	store.terminal.tabs.push(TerminalTab {
		id,
		title: command.to_owned(),
		cwd,
		lines: Vec::new(),
		exit: None,
		pending: lines,
		next_ms: store.now_ms + agent::LINE_MS,
	});
	store.terminal.exits.insert(id, exit);
	store.terminal.active = store.terminal.tabs.len() - 1;
	store.terminal.open = true;
}

/// Open a fresh session in the project of the current one, selected and empty.
pub fn new_session(store: &mut Store) -> SessionId {
	let project = store
		.selected_session()
		.map(|session| session.project.clone())
		.or_else(|| store.projects.first().map(|project| project.id.clone()))
		.unwrap_or_else(|| ProjectId::new("scratch"));
	let ordinal = store.sessions.len() + 1;
	let id = SessionId::new(format!("s{ordinal}"));
	let mut session = Session::new(id.as_str(), &project, SESSION_TITLE_UNTITLED);
	session.updated_ms = store.now_ms;
	session.model = store.models.first().cloned().unwrap_or_default();
	store.sessions.push(session);
	select(store, &id);
	id
}

/// Take a session out of the list without deleting it.
pub fn archive(store: &mut Store, id: &SessionId) {
	let archived = match store.session_mut(id) {
		None => return,
		Some(session) => {
			session.archived = !session.archived;
			session.archived
		},
	};
	if archived && store.selected.as_ref() == Some(id) {
		let next = store.visible_order().first().cloned();
		store.selected = next;
	}
}

/// Replace the selected session's draft and caret. The text element owns the
/// editing; the store owns the draft, so switching sessions and coming back
/// finds what was typed.
pub fn set_draft(store: &mut Store, text: String, caret: usize) {
	if let Some(session) = store.selected_session_mut() {
		session.caret = caret.min(text.len());
		session.draft = text;
	}
}

/// Send the draft.
///
/// Appends the user's message, appends an empty assistant message, and attaches
/// a run that fills it in over the following frames. Returns whether anything
/// was sent, so the caller knows whether to clear its input element.
pub fn send(store: &mut Store) -> bool {
	let now = store.now_ms;
	let Some(session) = store.selected_session_mut() else {
		return false;
	};
	let text = session.draft.trim().to_owned();
	if text.is_empty() || session.run.is_some() {
		return false;
	}
	let first_send = session.messages.is_empty();
	let id = session.next_message_id();
	session.messages.push(Message::user(id, now, text.clone()));
	session.draft.clear();
	session.caret = 0;
	if first_send {
		session.title = agent::title_for(&text);
	}
	let reply = agent::reply(&text);
	let message = id + 1;
	session.messages.push(Message {
		id:     message,
		role:   Role::Assistant,
		blocks: Vec::new(),
		at_ms:  now,
	});
	session.status = Activity::Working;
	session.updated_ms = now;
	session.run = Some(super::model::Run {
		message,
		pending: reply.blocks,
		revealed: 0,
		next_ms: now + agent::FIRST_TOKEN_MS,
		ends_as: reply.ends_as,
	});
	true
}

/// Stop the selected session's run where it is.
///
/// What is on screen stays on screen: an interrupted reply is a partial reply,
/// not a vanished one.
pub fn interrupt(store: &mut Store) {
	let Some(session) = store.selected_session_mut() else {
		return;
	};
	if session.run.take().is_some() {
		session.status = Activity::Idle;
	}
}

/// Advance every deadline in the store to `now_ms`.
///
/// Called once a frame with the window's clock. Runs reveal prose a slice at a
/// time and land whole blocks; terminal tabs print a line at a time and take
/// their exit code when the last one lands. Returns whether anything moved, so
/// the caller only asks for another frame when it has to.
pub fn tick(store: &mut Store, now_ms: u64) -> bool {
	store.now_ms = now_ms;
	let mut moved = false;

	if let Some(until) = store.notice_until
		&& now_ms >= until
	{
		store.notice = None;
		store.notice_until = None;
		moved = true;
	}

	for session in &mut store.sessions {
		let Some(run) = &mut session.run else {
			continue;
		};
		if now_ms < run.next_ms {
			continue;
		}
		moved = true;
		if run.pending.is_empty() {
			session.status = run.ends_as;
			session.unread = true;
			session.run = None;
			continue;
		}
		let landed = match &run.pending[0] {
			Block::Text(text) => {
				let step = agent::TEXT_STEP.min(text.len() - run.revealed);
				let mut end = run.revealed + step;
				while end < text.len() && !text.is_char_boundary(end) {
					end += 1;
				}
				run.revealed = end;
				let shown = text[..end].to_owned();
				let done = end == text.len();
				put(&mut session.messages, run.message, Block::Text(shown));
				run.next_ms = now_ms + agent::TEXT_MS;
				done
			},
			block => {
				put(&mut session.messages, run.message, block.clone());
				run.next_ms = now_ms + agent::BLOCK_MS;
				true
			},
		};
		if landed {
			run.pending.remove(0);
			run.revealed = 0;
			if run.pending.is_empty() {
				run.next_ms = now_ms + agent::BLOCK_MS;
			}
		}
		session.updated_ms = now_ms;
	}

	let exits = store.terminal.exits.clone();
	for tab in &mut store.terminal.tabs {
		if tab.pending.is_empty() || now_ms < tab.next_ms {
			continue;
		}
		moved = true;
		let line = tab.pending.remove(0);
		tab.lines.push(line);
		tab.next_ms = now_ms + agent::LINE_MS;
		if tab.pending.is_empty() {
			tab.exit = exits.get(&tab.id).copied().unwrap_or(Some(0));
		}
	}

	moved
}

/// Replace or append the block a run is writing.
///
/// A streaming block is the last one in the message, so a reveal overwrites it
/// and a new block appends. Anything already landed is never touched.
fn put(messages: &mut [Message], id: u64, block: Block) {
	let Some(message) = messages.iter_mut().find(|message| message.id == id) else {
		return;
	};
	let replace = match message.blocks.last() {
		// Prose is revealed in place.
		Some(Block::Text(_)) => matches!(block, Block::Text(_)),
		// A tool call that finishes replaces its own running form, so a call
		// appears once and changes state rather than twice.
		Some(last) => last.is_running_tool() && last.same_tool_as(&block),
		None => false,
	};
	if replace {
		let last = message.blocks.len() - 1;
		message.blocks[last] = block;
	} else {
		message.blocks.push(block);
	}
}

/// Answer the question a run is waiting on.
pub fn answer(store: &mut Store, text: &str) {
	if let Some(session) = store.selected_session_mut() {
		session.draft = text.to_owned();
		session.caret = session.draft.len();
	}
	send(store);
}

/// Say something under the composer for a few seconds.
pub fn notify(store: &mut Store, text: impl Into<String>) {
	store.notice = Some(text.into());
	store.notice_until = Some(store.now_ms + NOTICE_MS);
}

/// Open the palette over whatever is on screen.
pub fn open_palette(store: &mut Store, kind: PaletteKind) {
	store.overlay = Overlay::Palette(Palette { kind, query: String::new(), selected: 0 });
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
	let kind = palette.kind;
	let key = row.key.clone();
	store.overlay = Overlay::None;
	match kind {
		PaletteKind::Command => match key.strip_prefix("session:") {
			Some(id) => select(store, &SessionId::new(id)),
			None => run_action(store, &key),
		},
		PaletteKind::Model => set_model(store, &key),
		PaletteKind::Theme => set_theme(store, &key),
	}
}

/// Every command the palette can run, by key. One table, so the palette and the
/// keymap name the same set.
pub fn actions() -> Vec<(&'static str, &'static str)> {
	vec![
		("new-session", "New session"),
		("toggle-sidebar", "Toggle sidebar"),
		("toggle-terminal", "Toggle terminal panel"),
		("run-check", "Run cargo check"),
		("run-test", "Run bun test"),
		("pick-model", "Change model"),
		("pick-theme", "Change theme"),
		("settings", "Open settings"),
		("flip-appearance", "Flip light and dark"),
	]
}

/// Carry out a command by key.
pub fn run_action(store: &mut Store, key: &str) {
	match key {
		"new-session" => {
			new_session(store);
		},
		"toggle-sidebar" => toggle_sidebar(store),
		"toggle-terminal" => toggle_terminal(store),
		"run-check" => run_command(store, "cargo check"),
		"run-test" => run_command(store, "bun test"),
		"pick-model" => open_palette(store, PaletteKind::Model),
		"pick-theme" => open_palette(store, PaletteKind::Theme),
		"settings" => store.route = Route::Settings(SettingsPage::Appearance),
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
	match palette.kind {
		PaletteKind::Command => {
			let mut rows: Vec<PaletteRow> = store
				.sessions
				.iter()
				.filter(|session| !session.archived)
				.filter(|session| matches(&session.title))
				.map(|session| PaletteRow {
					key:     format!("session:{}", session.id.as_str()),
					label:   session.title.clone(),
					detail:  store
						.project(&session.project)
						.map(|project| project.name.clone())
						.unwrap_or_default(),
					current: store.selected.as_ref() == Some(&session.id),
				})
				.collect();
			rows.extend(
				actions()
					.into_iter()
					.filter(|(_, label)| matches(label))
					.map(|(key, label)| PaletteRow {
						key:     key.to_owned(),
						label:   label.to_owned(),
						detail:  "Command".to_owned(),
						current: false,
					}),
			);
			rows
		},
		PaletteKind::Model => {
			let current = store
				.selected_session()
				.map(|session| session.model.clone());
			store
				.models
				.iter()
				.filter(|model| matches(model))
				.map(|model| PaletteRow {
					key:     model.clone(),
					label:   model.clone(),
					detail:  String::new(),
					current: current.as_deref() == Some(model.as_str()),
				})
				.collect()
		},
		PaletteKind::Theme => store
			.themes
			.iter()
			.filter(|theme| matches(theme))
			.map(|theme| PaletteRow {
				key:     theme.clone(),
				label:   theme.clone(),
				detail:  String::new(),
				current: store.settings.theme == *theme,
			})
			.collect(),
	}
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

/// Point the selected session at a model.
///
/// One owner: the palette and the settings page both come through here, so a
/// model change looks the same however it was made and says so once.
pub fn set_model(store: &mut Store, model: &str) {
	if let Some(session) = store.selected_session_mut() {
		session.model = model.to_owned();
	}
	notify(store, format!("Model set to {model}"));
}

/// Choose the transcript's theme.
pub fn set_theme(store: &mut Store, theme: &str) {
	store.settings.theme = theme.to_owned();
	notify(store, format!("Theme set to {theme}"));
}

/// The size range the window's text is legible at. Outside it the layout stops
/// being a layout: below the floor a row's fixed heights swallow their text,
/// above the ceiling the reading column holds a handful of words.
pub const FONT_MIN: f32 = 11.0;
pub const FONT_MAX: f32 = 18.0;

/// Set the text size, clamped to what the window can draw.
pub fn set_font_size(store: &mut Store, size: f32) {
	store.settings.font_size = size.clamp(FONT_MIN, FONT_MAX);
}

/// Show sessions that finished and were read, or hide them.
pub fn toggle_show_settled(store: &mut Store) {
	store.settings.show_settled = !store.settings.show_settled;
}

/// Group the session list by checkout, or run it flat.
pub fn toggle_group_by_folder(store: &mut Store) {
	store.settings.group_by_folder = !store.settings.group_by_folder;
}

pub fn toggle_sounds(store: &mut Store) {
	store.settings.sounds = !store.settings.sounds;
}
