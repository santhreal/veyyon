//! The window's regions, and where each one is.
//!
//! ```text
//! ┌──────────────────────────────────────────────────────┐
//! │ title bar        thread · project        model  mode │
//! ├───────────────┬──────────────────────────────────────┤
//! │ sidebar       │ transcript                           │
//! │  threads by   │                                      │
//! │  project      ├──────────────────────────────────────┤
//! │               │ composer                             │
//! │               ├──────────────────────────────────────┤
//! │               │ terminal panel                       │
//! ├───────────────┴──────────────────────────────────────┤
//! │ status bar                                           │
//! └──────────────────────────────────────────────────────┘
//! ```
//!
//! Two regions collapse: the sidebar to nothing, the terminal panel to its tab
//! strip. Both animate with a spring rather than a duration token, because a
//! toggle is a keypress an operator repeats faster than the motion finishes,
//! and a spring reversed halfway travels back from where it was instead of
//! jumping to the far end and starting again.
//!
//! The sidebar is full height and the panel sits beside it rather than under
//! it. A panel spanning the whole window would push the sidebar up, which makes
//! the thread list shorter every time a build is watched.

use gpui::{AnyElement, App, Div, IntoElement, ParentElement, Styled, div};
use veyyon_gui_contract::{
	screen::Route,
	session::{Frame, Hud, HudAgent, StatusNotice, transcript::Level as Weight},
};
use veyyon_gui_kit::{
	ActiveTypography, Level,
	chrome::{chip, column, duration, edge, row},
	surface,
	text::{caption, text_in},
	theme::ActiveTheme,
	tokens::{layout, space, stroke, text},
};
use veyyon_gui_motion::{reveal_height, reveal_width};
use veyyon_gui_theme::Role;

use crate::{composer::composer, sidebar::sidebar, status::status_bar, terminal};

/// Which regions are revealed.
///
/// The window owns this, not the session: whether a panel is open is a fact
/// about this window, and a second window on the same session opens its own
/// panels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chrome {
	pub sidebar:  bool,
	pub terminal: bool,
}

impl Chrome {
	/// What a window opens with: the thread list, and no panel.
	///
	/// The sidebar is open because a window that starts with it closed starts by
	/// hiding the reason it has one. The panel is closed because nothing is
	/// running yet, and its strip still reports when something is.
	pub fn new() -> Chrome {
		Chrome { sidebar: true, terminal: false }
	}

	pub fn toggle_sidebar(self) -> Chrome {
		Chrome { sidebar: !self.sidebar, ..self }
	}

	pub fn toggle_terminal(self) -> Chrome {
		Chrome { terminal: !self.terminal, ..self }
	}
}

impl Default for Chrome {
	fn default() -> Chrome {
		Chrome::new()
	}
}

/// The whole window at one instant.
///
/// `page` is the routed screen, already drawn, or `None` on the transcript
/// route. It arrives as an element rather than as a route because the page
/// layer owns that match, and the frame's job is where it goes: over the
/// transcript, so switching routes does not resize the sidebar or the panel.
pub fn frame(
	value: &Frame,
	route: &Route,
	chrome: Chrome,
	page: Option<AnyElement>,
	cx: &App,
) -> Div {
	let content = row(gpui::px(0.0))
		.flex_1()
		.min_h_0()
		.w_full()
		.items_stretch()
		.child(reveal_width(
			"sidebar",
			chrome.sidebar,
			f32::from(layout::SIDEBAR_CLOSED),
			f32::from(layout::PANEL),
			div()
				.h_full()
				.flex_none()
				.child(sidebar(&value.workspace, cx)),
		))
		.child(center(value, route, page, chrome, cx));

	surface(Level::Window, cx)
		.size_full()
		.flex()
		.flex_col()
		.text_color(cx.color(Role::TextPrimary))
		.font_family(cx.ui_family())
		.child(title_bar(value, chrome, cx))
		.child(content)
		.child(status_bar(&value.status, cx))
}

/// The title bar: the sidebar toggle, what is open, and what is answering.
///
/// The bar names the checkout and the thread, and never the product. A window
/// carries the product name in its own title, and repeating it here spends the
/// one line that says which of several checkouts this window is looking at.
fn title_bar(value: &Frame, chrome: Chrome, cx: &App) -> Div {
	let workspace = &value.workspace;
	let mut bar = row(space::SNUG)
		.w_full()
		.h(layout::TITLE_BAR)
		.flex_none()
		.pl(space::LOOSE)
		.pr(space::BASE)
		.border_b(stroke::HAIRLINE)
		.border_color(edge(cx.color(Role::StrokeSubtle)))
		.child(text_in(toggle_marker(chrome.sidebar), Role::TextSecondary, text::BODY, cx));

	if let Some(project) = workspace.active_project() {
		bar = bar.child(chip(project.name.clone(), Role::TextAccent, cx));
	}
	if let Some(thread) = workspace.active_thread() {
		bar = bar.child(caption("·", cx)).child(text_in(
			thread.title.clone(),
			Role::TextPrimary,
			text::SMALL,
			cx,
		));
	}

	bar.child(div().flex_1())
		.child(caption(value.status.model.clone(), cx))
}

/// The marker on the sidebar toggle.
///
/// It states what the sidebar is, not what pressing it does. A toggle labelled
/// with its own action reverses meaning the moment it is pressed, and an
/// operator reading the bar sees a claim about the sidebar that contradicts the
/// sidebar beside it.
pub fn toggle_marker(open: bool) -> &'static str {
	if open { "◧" } else { "▢" }
}

/// The transcript, the composer, and the panel under them.
fn center(value: &Frame, route: &Route, page: Option<AnyElement>, chrome: Chrome, cx: &App) -> Div {
	let mut dock = surface(Level::Panel, cx)
		.w_full()
		.flex_none()
		.flex()
		.flex_col()
		.border_t(stroke::HAIRLINE)
		.border_color(edge(cx.color(Role::StrokeSubtle)))
		.pt(space::BASE);

	if let Some(hud) = &value.hud {
		dock = dock.child(centred(hud_row(hud, cx), cx));
	}
	if !value.notices.is_empty() {
		dock = dock.child(centred(
			column(space::HAIR)
				.w(layout::READING)
				.children(value.notices.iter().map(|notice| self::notice(notice, cx))),
			cx,
		));
	}
	dock = dock.child(centred(composer(&value.composer, cx), cx));

	let reading = surface(Level::Canvas, cx)
		.flex_1()
		.min_h_0()
		.w_full()
		.flex()
		.flex_col()
		.child(crate::transcript::region(&value.blocks, cx))
		.child(dock);

	let body = match page {
		None => reading.into_any_element(),
		Some(page) => over(reading, page, route, cx).into_any_element(),
	};

	column(gpui::px(0.0))
		.flex_1()
		.min_w_0()
		.min_h_0()
		.child(body)
		.child(reveal_height(
			"terminal",
			chrome.terminal,
			f32::from(layout::TERMINAL_CLOSED),
			f32::from(layout::TERMINAL),
			div().w_full().flex_none().child(terminal::terminal(
				&value.terminal,
				chrome.terminal,
				terminal::height(chrome.terminal),
				cx,
			)),
		))
}

/// A region held to the reading column and centred in whatever room it has.
fn centred(child: impl IntoElement, _cx: &App) -> Div {
	div()
		.w_full()
		.flex_none()
		.px(space::WIDE)
		.pb(space::BASE)
		.flex()
		.flex_col()
		.items_center()
		.child(child)
}

/// One notice above the composer: a rate limit, a failed hook, an update.
fn notice(value: &StatusNotice, cx: &App) -> Div {
	row(space::SNUG)
		.w_full()
		.child(chip(level_label(value.level), level_role(value.level), cx))
		.child(text_in(value.text.clone(), Role::TextSecondary, text::SMALL, cx))
}

/// What a notice's level is called.
pub fn level_label(level: Weight) -> &'static str {
	match level {
		Weight::Info => "info",
		Weight::Warning => "warning",
		Weight::Error => "error",
	}
}

/// The role a notice's level reads in.
pub fn level_role(level: Weight) -> Role {
	match level {
		Weight::Info => Role::StateInfo,
		Weight::Warning => Role::StateWarning,
		Weight::Error => Role::StateError,
	}
}

/// The running sub-agents, as one line above the composer.
///
/// A row rather than a panel. The fan-out is read while a turn is streaming,
/// and a panel that grew with the number of agents would push the transcript up
/// every time one spawned.
fn hud_row(value: &Hud, cx: &App) -> Div {
	let mut line = row(space::SNUG)
		.w(layout::READING)
		.children(value.agents.iter().map(|agent| self::agent(agent, cx)));
	if value.omitted > 0 {
		line = line.child(caption(omitted_label(value.omitted), cx));
	}
	line
}

/// What the HUD says about agents beyond the ones it lists.
pub fn omitted_label(omitted: usize) -> String {
	match omitted {
		1 => "1 more".to_owned(),
		omitted => format!("{omitted} more"),
	}
}

/// One running sub-agent: its name, its lane, and how long it has been running.
fn agent(value: &HudAgent, cx: &App) -> Div {
	let mut entry = row(space::TIGHT)
		.child(text_in(value.name.clone(), Role::TextAccent, text::SMALL, cx))
		.child(caption(duration(value.elapsed_ms), cx));
	if let Some(kind) = &value.kind {
		entry = entry.child(chip(kind.clone(), Role::TextMuted, cx));
	}
	entry
}

/// A routed page over the transcript.
///
/// The transcript stays mounted underneath. Replacing it would drop its scroll
/// position, so opening a picker and closing it again would land the operator
/// somewhere else in the conversation than where they left.
///
/// An overlay route keeps the transcript visible through a scrim, because it is
/// answering a question about what is on screen. A route that is not an overlay
/// is a screen in its own right and covers it.
fn over(reading: Div, page: AnyElement, route: &Route, cx: &App) -> Div {
	let ground = if route.is_overlay() {
		surface(Level::Window, cx)
			.absolute()
			.inset_0()
			.opacity(SCRIM)
	} else {
		surface(Level::Window, cx).absolute().inset_0()
	};
	div().relative().flex_1().min_h_0().child(reading).child(
		div()
			.absolute()
			.inset_0()
			.flex()
			.items_center()
			.justify_center()
			.child(ground)
			.child(veyyon_gui_motion::dialog_in("page", div().flex().child(page))),
	)
}

/// How opaque a sheet's scrim is over the transcript, leaving the rest of it
/// showing through.
///
/// The window ground at partial alpha rather than black: black over a light
/// theme goes grey, and grey is not a colour either theme has.
const SCRIM: f32 = 0.72;

/// What a keystroke asks the frame to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
	ToggleSidebar,
	ToggleTerminal,
}

/// The command a keystroke names, or `None` for every other key.
///
/// A pure function over the key and the two modifiers that matter, so the
/// bindings are asserted without a window. Both `ctrl` and the platform key are
/// accepted for the sidebar: the same window runs on a machine where the habit
/// is `cmd-b` and on one where it is `ctrl-b`, and a binding that took only one
/// is a binding half the operators cannot find.
///
/// An unmodified key is never a command. The composer takes text, and a bare
/// `b` that collapsed the sidebar would make the window unusable for typing.
pub fn command(key: &str, control: bool, platform: bool) -> Option<Command> {
	if !control && !platform {
		return None;
	}
	match key {
		"b" => Some(Command::ToggleSidebar),
		"`" => Some(Command::ToggleTerminal),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The frame's own decisions are which regions are revealed and what the
	//! toggle says about them. Two failures here are invisible in a screenshot
	//! of the default state: a window that opens with the thread list closed,
	//! which hides the reason the list exists, and a toggle labelled with its
	//! action rather than its state, which contradicts the sidebar beside it
	//! the moment it is pressed.
	//!
	//! WHAT IT DOES NOT CATCH. The animation. A spring needs a window and a
	//! clock, and the capture of the collapsed and expanded states covers where
	//! it ends up.

	use super::*;

	#[test]
	fn a_window_opens_showing_the_thread_list_and_no_panel() {
		let chrome = Chrome::new();
		assert!(chrome.sidebar, "the window opened with the thread list hidden");
		assert!(!chrome.terminal, "the window opened with the panel taking a third of it");
	}

	#[test]
	fn each_toggle_moves_one_region_and_leaves_the_other_alone() {
		let open = Chrome::new();
		let closed = open.toggle_sidebar();
		assert!(!closed.sidebar);
		assert_eq!(closed.terminal, open.terminal, "the sidebar toggle moved the panel");

		let with_panel = open.toggle_terminal();
		assert!(with_panel.terminal);
		assert_eq!(with_panel.sidebar, open.sidebar, "the panel toggle moved the sidebar");
	}

	#[test]
	fn toggling_twice_returns_to_where_it_started() {
		let start = Chrome::new();
		assert_eq!(start.toggle_sidebar().toggle_sidebar(), start);
		assert_eq!(start.toggle_terminal().toggle_terminal(), start);
	}

	#[test]
	fn the_toggle_says_what_the_sidebar_is_rather_than_what_pressing_it_does() {
		assert_ne!(toggle_marker(true), toggle_marker(false));
		let chrome = Chrome::new();
		assert_eq!(
			toggle_marker(chrome.sidebar),
			toggle_marker(true),
			"the marker disagrees with the sidebar it sits beside"
		);
	}

	#[test]
	fn a_collapsed_sidebar_takes_no_width_and_a_collapsed_panel_keeps_its_strip() {
		assert_eq!(f32::from(layout::SIDEBAR_CLOSED), 0.0);
		assert!(
			f32::from(layout::TERMINAL_CLOSED) > 0.0,
			"the panel disappeared, so a running command has nowhere to be reported"
		);
		assert!(f32::from(layout::TERMINAL) > f32::from(layout::TERMINAL_CLOSED));
	}
}

#[cfg(test)]
mod binding_tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The composer takes text, and the frame takes keys from the same stream. A
	//! binding that fires without a modifier collapses the sidebar the first
	//! time the operator types the letter, which reads as the window breaking
	//! rather than as a binding being wrong.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the key reaches the handler. That needs a
	//! window and a focused element.

	use super::*;

	#[test]
	fn a_bare_letter_is_never_a_command() {
		assert_eq!(command("b", false, false), None);
		assert_eq!(command("`", false, false), None);
	}

	#[test]
	fn either_modifier_reaches_the_same_command() {
		assert_eq!(command("b", true, false), Some(Command::ToggleSidebar));
		assert_eq!(command("b", false, true), Some(Command::ToggleSidebar));
		assert_eq!(command("`", true, false), Some(Command::ToggleTerminal));
	}

	#[test]
	fn no_two_commands_share_a_key() {
		assert_ne!(command("b", true, false), command("`", true, false));
	}

	#[test]
	fn an_unbound_modified_key_is_left_alone() {
		for key in ["a", "enter", "escape", "tab", "1"] {
			assert_eq!(command(key, true, false), None, "{key} was taken");
		}
	}
}
