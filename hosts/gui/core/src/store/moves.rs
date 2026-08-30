//! Every move over the store.
//!
//! One function per thing the operator can do, each taking `&mut Store` and
//! returning nothing or the one value the caller needs. No toolkit, no clock,
//! no IO: the time a move happens is passed in, so a move is called from a test
//! the same way the window calls it.

use super::model::{
	Answer, Appearance, FONT_MAX, FONT_MIN, Message, Overlay, ProjectId, Route,
	SESSION_TITLE_UNTITLED, Session, SessionId, SettingsPage, Store,
};

/// How long a notice stays under the composer.
const NOTICE_MS: u64 = 4_000;

/// How long a session title may be before it is cut at a word. A title is one
/// stored string that several surfaces show at different widths, so this is the
/// bound on what is kept, not on what any row displays: the sidebar row and the
/// header both shorten it again to the space they have.
pub const TITLE_MAX: usize = 120;

/// How much of a conversation's name a notice quotes back.
///
/// A notice is one line beside the composer, read at a glance and gone in four
/// seconds. A name taken from a first message runs to a paragraph, and quoting
/// all of it makes the line wrap over the field.
const NOTICE_NAME: usize = 40;

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
	// The name, cut and marked: a notice is read at a glance beside the composer,
	// a conversation named by its own first message can be a paragraph long, and
	// nothing else shortens this line, so the cut is marked here or not at all.
	notify(store, format!("Deleted {}", crate::text::elided(&title, NOTICE_NAME)));
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
/// takes its name from the first one.
///
/// Returns the conversation the turn landed in, so the caller knows to clear
/// its input element and knows which conversation an answer to it belongs to.
/// The selection is read once, here, and never again on the way to an engine:
/// by the time an answer arrives the reader may be somewhere else.
///
/// Nothing answers. No engine is attached, and the window says so under the
/// last message rather than inventing a reply.
pub fn send(store: &mut Store) -> Option<SessionId> {
	let now = store.now_ms;
	let session = store.selected_session_mut()?;
	let text = session.draft.trim().to_owned();
	if text.is_empty() {
		return None;
	}
	let id = session.next_message_id();
	let message = Message::written(id, now, &text);
	if session.messages.is_empty() {
		// From the parsed prose, not the raw text: a message that opens with a
		// heading, a bullet or a fence would otherwise name the conversation
		// with the markers, and a list of conversations is where those are least
		// readable.
		session.title = title_from(&message.text());
	}
	session.messages.push(message);
	session.draft.clear();
	session.caret = 0;
	session.updated_ms = now;
	Some(session.id.clone())
}

/// An engine has begun answering in a conversation. Returns the message the
/// answer is being written into.
///
/// THIS IS THE SEAM AN ENGINE WRITES THROUGH, and nothing calls it yet: no
/// engine is attached, and the window says so under the last message rather
/// than inventing a reply. Addressed by conversation, not by what is on screen,
/// because an answer belongs to the conversation it was asked in and the
/// operator is free to be reading another one when it arrives.
///
/// A conversation already being answered keeps the answer it has: two answers
/// in one conversation is a transport that sent the same question twice, and
/// the second one would otherwise silently take over the message.
pub fn begin_answer(store: &mut Store, id: &SessionId, now_ms: u64) -> Option<u64> {
	let session = store.session_mut(id)?;
	if session.answering.is_some() {
		return None;
	}
	let message = session.next_message_id();
	session
		.messages
		.push(Message::answered(message, now_ms, "", true));
	session.answering = Some(Answer { message, text: String::new() });
	session.updated_ms = now_ms;
	Some(message)
}

/// More of an answer arrived. Returns whether it was taken.
///
/// The message is reparsed from the whole answer rather than the delta, because
/// a delta arrives inside a fence, a table or a list that has not closed: the
/// only text that parses to the right blocks is all of it. The cost of a delta
/// is one parse of one message, and the parse is what the transcript draws.
pub fn extend_answer(store: &mut Store, id: &SessionId, delta: &str, now_ms: u64) -> bool {
	let Some(session) = store.session_mut(id) else {
		return false;
	};
	let Some(answer) = session.answering.as_mut() else {
		return false;
	};
	answer.text.push_str(delta);
	let at = answer.message;
	let text = answer.text.clone();
	let Some(message) = session.messages.iter_mut().find(|message| message.id == at) else {
		// The message the answer names is gone, which is a conversation cleared
		// under a live answer: the answer goes with it rather than reappearing.
		session.answering = None;
		return false;
	};
	*message = Message::answered(at, message.at_ms, &text, true);
	session.updated_ms = now_ms;
	true
}

/// The answer is finished: the spinner stops and the text stands as written.
///
/// Returns whether there was an answer to finish, so a transport that sends two
/// ends for one answer is visible to its caller rather than silently accepted.
pub fn finish_answer(store: &mut Store, id: &SessionId) -> bool {
	let Some(session) = store.session_mut(id) else {
		return false;
	};
	let Some(answer) = session.answering.take() else {
		return false;
	};
	if let Some(message) = session
		.messages
		.iter_mut()
		.find(|message| message.id == answer.message)
	{
		message.streaming = false;
	}
	true
}

/// The answer ended badly. What is written stays, the spinner stops, and the
/// reason is said once beside the composer.
///
/// The reason does not become a message: a transcript is what was said, and a
/// transport failure was not said by anyone.
pub fn fail_answer(store: &mut Store, id: &SessionId, why: impl Into<String>) -> bool {
	let finished = finish_answer(store, id);
	notify(store, why.into());
	finished
}

/// What a conversation is called once its first message names it: the first
/// line, cut at a word.
pub fn title_from(text: &str) -> String {
	let line = text
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.unwrap_or(SESSION_TITLE_UNTITLED);
	crate::text::clip(line, TITLE_MAX)
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

/// Open a settings page.
pub fn open_settings(store: &mut Store, page: SettingsPage) {
	store.route = Route::Settings(page);
	store.overlay = Overlay::None;
}

/// The settings page one step before or after the one on screen, and nothing at
/// either end.
///
/// It stops rather than wrapping, because a list of pages is a list: a reader
/// holding the down key expects to arrive at the last page, not to return to
/// the first. Nothing outside settings has a page beside it.
pub fn settings_page_beside(store: &Store, down: bool) -> Option<SettingsPage> {
	let Route::Settings(page) = store.route else {
		return None;
	};
	let pages = SettingsPage::ALL;
	let at = pages.iter().position(|candidate| *candidate == page)?;
	let next = if down {
		at.checked_add(1)?
	} else {
		at.checked_sub(1)?
	};
	pages.get(next).copied()
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
