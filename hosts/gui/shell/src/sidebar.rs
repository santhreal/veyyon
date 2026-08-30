//! The thread list down the left side.
//!
//! Not navigation furniture. An operator running several agents at once has one
//! question the window has to answer without being asked: which of these has
//! stopped and is waiting for me. So the list is ordered by state before time,
//! grouped by checkout, and the count in the header is of threads waiting
//! rather than of threads running.
//!
//! A settled thread is one that has been read and put away. Settled threads
//! sort below everything else and are folded into their own group, which is
//! what keeps a week of history from burying the four threads that matter
//! today.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::session::{Project, Thread, ThreadState, Workspace};
use veyyon_gui_kit::{
	Level,
	chrome::{chip, column, edge, row, rule},
	surface,
	text::{caption, label, text_in},
	theme::ActiveTheme,
	tokens::{layout, radius, space, stroke, text},
};
use veyyon_gui_theme::Role;

/// How many path segments a project's path keeps.
const PATH_BUDGET: usize = 3;

pub fn sidebar(value: &Workspace, cx: &App) -> Div {
	surface(Level::Panel, cx)
		.h_full()
		.w(layout::PANEL)
		.flex_none()
		.border_r(stroke::HAIRLINE)
		.border_color(edge(cx.color(Role::StrokeSubtle)))
		.flex()
		.flex_col()
		.child(header(value, cx))
		.child(rule(Role::StrokeSubtle, cx))
		.child(
			column(space::BASE)
				.flex_1()
				.min_h_0()
				.overflow_hidden()
				.p(space::SNUG)
				.children(
					value
						.projects
						.iter()
						.map(|project| group(project, value, cx)),
				),
		)
}

/// The header: what the list is, and how much of it is waiting.
fn header(value: &Workspace, cx: &App) -> Div {
	let mut line = row(space::SNUG)
		.h(layout::TITLE_BAR)
		.px(space::BASE)
		.child(label("Threads", cx).flex_1());
	if let Some(count) = waiting_label(value) {
		line = line.child(chip(count, Role::StateWarning, cx));
	}
	if value.working() > 0 {
		line = line.child(chip(format!("{} running", value.working()), Role::TextAccent, cx));
	}
	line
}

/// What the header says about threads waiting on an answer, or `None` when none
/// are.
///
/// A zero here is worse than nothing: a badge that is always present stops
/// being read, and the state it is there to announce arrives without anything
/// visibly changing.
pub fn waiting_label(value: &Workspace) -> Option<String> {
	match value.waiting() {
		0 => None,
		1 => Some("1 waiting".to_owned()),
		count => Some(format!("{count} waiting")),
	}
}

/// One project group: its name and path, then its threads in reading order.
fn group(value: &Project, workspace: &Workspace, cx: &App) -> Div {
	let mut stack = column(space::HAIR).child(
		row(space::TIGHT)
			.px(space::TIGHT)
			.child(text_in(marker(value.collapsed), Role::TextMuted, text::MICRO, cx))
			.child(label(value.name.clone(), cx))
			.child(caption(short_path(&value.path), cx).flex_1())
			.children(group_badge(value, cx)),
	);
	if value.collapsed {
		return stack;
	}
	let active = workspace.active.as_deref();
	stack = stack.children(
		ordered(value)
			.into_iter()
			.map(|thread| self::thread(thread, Some(thread.id.as_str()) == active, cx)),
	);
	stack
}

/// The badge a folded group carries, so what is hidden is still counted.
fn group_badge(value: &Project, cx: &App) -> Option<Div> {
	if !value.collapsed {
		return None;
	}
	Some(match value.waiting() {
		0 => chip(value.threads.len().to_string(), Role::TextMuted, cx),
		waiting => chip(format!("{waiting} waiting"), Role::StateWarning, cx),
	})
}

/// The disclosure marker beside a group's name.
pub fn marker(collapsed: bool) -> &'static str {
	if collapsed { "▸" } else { "▾" }
}

/// A project's threads in the order the sidebar reads them.
///
/// State first, then the most recent change inside a state. Sorting by time
/// alone is the failure this exists to prevent: a thread that stopped for an
/// answer an hour ago sinks under every thread that has moved since, which is
/// every thread that does not need anything.
pub fn ordered(value: &Project) -> Vec<&Thread> {
	let mut threads: Vec<&Thread> = value.threads.iter().collect();
	threads.sort_by(|left, right| {
		left
			.state
			.rank()
			.cmp(&right.state.rank())
			.then(right.updated_ms.cmp(&left.updated_ms))
	});
	threads
}

/// One thread row.
fn thread(value: &Thread, open: bool, cx: &App) -> Div {
	let mut line = row(space::SNUG)
		.w_full()
		.p(space::TIGHT)
		.rounded(radius::SMALL)
		.child(text_in(state_marker(value.state), state_role(value.state), text::SMALL, cx))
		.child(
			column(space::HAIR)
				.flex_1()
				.min_w_0()
				.child(text_in(value.title.clone(), title_role(value.state, open), text::SMALL, cx))
				.child(caption(state_label(value.state), cx)),
		);
	if value.unread > 0 {
		line = line.child(chip(value.unread.to_string(), unread_role(value.state), cx));
	}
	line = line.children(
		value
			.badges
			.iter()
			.map(|badge| chip(badge.text.clone(), veyyon_gui_views::tone::role(badge.tone), cx)),
	);
	if open {
		line = line.bg(cx.color(Role::InteractionSelected));
	}
	line
}

/// The marker beside a thread's title.
///
/// Every state is distinct. Three of these mean "not running" for different
/// reasons, and drawing two of them the same way is the whole defect: a thread
/// waiting for an answer that reads as one that finished is a thread nobody
/// answers.
pub fn state_marker(state: ThreadState) -> &'static str {
	match state {
		ThreadState::Working => "◐",
		ThreadState::Waiting => "◆",
		ThreadState::Idle => "○",
		ThreadState::Failed => "✗",
		ThreadState::Settled => "·",
	}
}

/// The role a thread's marker reads in.
pub fn state_role(state: ThreadState) -> Role {
	match state {
		ThreadState::Working => Role::TextAccent,
		ThreadState::Waiting => Role::StateWarning,
		ThreadState::Idle => Role::TextSecondary,
		ThreadState::Failed => Role::StateError,
		ThreadState::Settled => Role::TextMuted,
	}
}

/// What a thread's state says under its title.
pub fn state_label(state: ThreadState) -> &'static str {
	match state {
		ThreadState::Working => "working",
		ThreadState::Waiting => "waiting for you",
		ThreadState::Idle => "idle",
		ThreadState::Failed => "failed",
		ThreadState::Settled => "settled",
	}
}

/// The role a thread's title reads in.
///
/// A settled thread reads set back even when it is the one on screen: it is
/// there to be read, not to be answered.
pub fn title_role(state: ThreadState, open: bool) -> Role {
	match (state, open) {
		(ThreadState::Settled, _) => Role::TextMuted,
		(_, true) => Role::TextPrimary,
		(_, false) => Role::TextSecondary,
	}
}

/// The role an unread count reads in.
///
/// A count on a thread that needs an answer carries the state's own colour; on
/// one that is merely running it does not, because two colours competing for
/// urgency leaves neither meaning anything.
pub fn unread_role(state: ThreadState) -> Role {
	if state.needs_attention() {
		state_role(state)
	} else {
		Role::TextMuted
	}
}

/// A project's path, shortened to its last [`PATH_BUDGET`] segments.
pub fn short_path(path: &str) -> String {
	let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
	if segments.len() <= PATH_BUDGET {
		return path.to_owned();
	}
	format!("…/{}", segments[segments.len() - PATH_BUDGET..].join("/"))
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The sidebar answers one question: which thread has stopped and is waiting
	//! on the operator. Three changes break that answer and none of them looks
	//! wrong on screen. A sort by recency buries the blocked thread under every
	//! thread that has moved since. Two states drawn with the same marker make a
	//! blocked thread read as a finished one. A "0 waiting" badge that is always
	//! present stops being read, so the state it announces arrives invisibly.
	//!
	//! WHAT IT DOES NOT CATCH. Clicking a row. Nothing switches threads yet, and
	//! the width animation needs a window, which the capture covers.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn a_thread_waiting_on_an_answer_is_first_even_when_it_is_the_oldest() {
		let workspace = fixtures::workspace();
		let project = workspace
			.projects
			.first()
			.expect("the fixture carries a project");
		let order = ordered(project);

		let waiting = order.first().expect("the group has threads");
		assert_eq!(waiting.state, ThreadState::Waiting, "the blocked thread is not at the top");
		assert!(
			project
				.threads
				.iter()
				.any(|thread| thread.updated_ms > waiting.updated_ms),
			"the fixture cannot tell a state sort from a recency sort"
		);
	}

	#[test]
	fn the_order_is_state_first_and_recency_only_inside_a_state() {
		let workspace = fixtures::workspace();
		let project = workspace.projects.first().expect("a project");
		let ranks: Vec<u8> = ordered(project)
			.iter()
			.map(|thread| thread.state.rank())
			.collect();
		let mut sorted = ranks.clone();
		sorted.sort_unstable();
		assert_eq!(ranks, sorted, "the states are out of order");
	}

	#[test]
	fn recency_decides_between_two_threads_in_the_same_state() {
		let project = Project::new("p", "/repo/p", vec![
			Thread::new("old", "Older", ThreadState::Working).updated_ms(10),
			Thread::new("new", "Newer", ThreadState::Working).updated_ms(90),
		]);
		let order = ordered(&project);
		assert_eq!(order[0].id, "new", "the newer thread of the same state sank");
	}

	#[test]
	fn no_two_thread_states_draw_the_same_marker_or_read_in_the_same_role() {
		let mut markers: Vec<&str> = ThreadState::ALL.iter().copied().map(state_marker).collect();
		let count = markers.len();
		markers.sort_unstable();
		markers.dedup();
		assert_eq!(markers.len(), count, "two thread states share a marker");

		let mut labels: Vec<&str> = ThreadState::ALL.iter().copied().map(state_label).collect();
		labels.sort_unstable();
		labels.dedup();
		assert_eq!(labels.len(), count, "two thread states share a label");

		assert_ne!(state_role(ThreadState::Waiting), state_role(ThreadState::Idle));
		assert_ne!(state_role(ThreadState::Failed), state_role(ThreadState::Waiting));
	}

	#[test]
	fn a_header_with_nothing_waiting_carries_no_badge() {
		let quiet = Workspace::new(vec![Project::new("p", "/repo/p", vec![Thread::new(
			"a",
			"Done",
			ThreadState::Idle,
		)])]);
		assert_eq!(waiting_label(&quiet), None);
	}

	#[test]
	fn the_header_counts_threads_waiting_rather_than_threads_running() {
		let workspace = fixtures::workspace();
		assert_eq!(waiting_label(&workspace).as_deref(), Some("1 waiting"));
		assert!(workspace.working() > 0, "the fixture has nothing running to be confused with");
	}

	#[test]
	fn one_waiting_thread_is_singular() {
		let one = Workspace::new(vec![Project::new("p", "/repo/p", vec![Thread::new(
			"a",
			"Blocked",
			ThreadState::Waiting,
		)])]);
		assert_eq!(waiting_label(&one).as_deref(), Some("1 waiting"));

		let two = Workspace::new(vec![Project::new("p", "/repo/p", vec![
			Thread::new("a", "Blocked", ThreadState::Waiting),
			Thread::new("b", "Also blocked", ThreadState::Waiting),
		])]);
		assert_eq!(waiting_label(&two).as_deref(), Some("2 waiting"));
	}

	#[test]
	fn a_folded_group_says_it_is_folded_and_says_what_is_inside() {
		let workspace = fixtures::workspace();
		let folded = workspace
			.projects
			.iter()
			.find(|project| project.collapsed)
			.expect("the fixture carries a folded group");
		assert_eq!(marker(true), "▸");
		assert_ne!(marker(true), marker(false));
		assert!(!folded.threads.is_empty(), "the folded group hides nothing");
	}

	#[test]
	fn an_unread_count_only_carries_urgency_when_the_state_does() {
		assert_eq!(unread_role(ThreadState::Waiting), state_role(ThreadState::Waiting));
		assert_eq!(unread_role(ThreadState::Failed), state_role(ThreadState::Failed));
		assert_eq!(unread_role(ThreadState::Working), Role::TextMuted);
		assert_eq!(unread_role(ThreadState::Idle), Role::TextMuted);
	}

	#[test]
	fn a_long_checkout_path_keeps_its_last_segments() {
		assert_eq!(short_path("/repo/veyyon"), "/repo/veyyon");
		assert_eq!(short_path("/a/b/c/d/e"), "…/c/d/e");
		assert_eq!(short_path("/a/b/c"), "/a/b/c");
	}
}
