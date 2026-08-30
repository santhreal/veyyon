//! The panel across the bottom.
//!
//! A coding agent runs commands, and the operator watches them. The transcript
//! shows what a tool reported once it finished; this shows what is on a
//! terminal now, and it is where the operator's own shell lives.
//!
//! Collapsed it keeps its tab strip rather than disappearing. A closed panel
//! hiding three running commands is the state where an operator waits on a
//! build they cannot see, so the strip stays and reports what is running.

use gpui::{App, Div, ParentElement, Pixels, Styled};
use veyyon_gui_contract::session::{TerminalPanel, TerminalTab};
use veyyon_gui_kit::{
	Level,
	chrome::{chip, column, edge, row, rule},
	surface,
	text::{caption, mono, text_in},
	theme::ActiveTheme,
	tokens::{layout, space, stroke, text},
};
use veyyon_gui_theme::Role;

/// How many path segments a tab's working directory keeps.
const CWD_BUDGET: usize = 2;

pub fn terminal(value: &TerminalPanel, open: bool, height: Pixels, cx: &App) -> Div {
	let mut stack = surface(Level::Sunken, cx)
		.w_full()
		.h_full()
		.border_t(stroke::HAIRLINE)
		.border_color(edge(cx.color(Role::StrokeSubtle)))
		.flex()
		.flex_col()
		.child(tabs(value, open, cx));

	if open {
		stack = stack
			.child(rule(Role::StrokeSubtle, cx))
			.child(body(value, height, cx));
	}
	stack
}

/// The tab strip. Present whether the panel is open or closed.
fn tabs(value: &TerminalPanel, open: bool, cx: &App) -> Div {
	let mut strip = row(space::SNUG)
		.h(layout::TERMINAL_CLOSED)
		.w_full()
		.flex_none()
		.px(space::SNUG)
		.children(
			value
				.tabs
				.iter()
				.enumerate()
				.map(|(index, tab)| self::tab(tab, index == value.active, cx)),
		);

	strip = strip.child(gpui::div().flex_1());
	if let Some(summary) = strip_summary(value, open) {
		strip = strip.child(chip(summary, summary_role(value), cx));
	}
	strip.child(caption(hint(open), cx))
}

/// What the strip reports about the whole panel, or `None` when it has nothing
/// to add to what the tabs already show.
///
/// Only while closed. Open, every tab's own state is on screen, and a second
/// count of it is a number that can disagree with what is under it.
pub fn strip_summary(value: &TerminalPanel, open: bool) -> Option<String> {
	if open {
		return None;
	}
	match (value.running(), value.has_failure()) {
		(0, false) => None,
		(0, true) => Some("failed".to_owned()),
		(1, _) => Some("1 running".to_owned()),
		(count, _) => Some(format!("{count} running")),
	}
}

/// The role the strip's own summary reads in. A failure outranks a count: a
/// panel reporting "2 running" while one has already failed reads as fine.
pub fn summary_role(value: &TerminalPanel) -> Role {
	if value.has_failure() {
		Role::StateError
	} else {
		Role::TextAccent
	}
}

/// What the strip says the keys do.
pub fn hint(open: bool) -> &'static str {
	if open {
		"ctrl-` to close"
	} else {
		"ctrl-` to open"
	}
}

/// One tab: its state, its title, and where it is running.
fn tab(value: &TerminalTab, active: bool, cx: &App) -> Div {
	let role = tab_role(value, active);
	let mut entry = row(space::TIGHT)
		.h_full()
		.items_center()
		.child(text_in(state_marker(value), role, text::MICRO, cx))
		.child(text_in(value.title.clone(), role, text::SMALL, cx))
		.child(caption(short_cwd(&value.cwd), cx));
	if active {
		entry = entry
			.border_b(stroke::HAIRLINE)
			.border_color(cx.color(Role::TextAccent));
	}
	entry
}

/// The marker beside a tab's title.
///
/// A finished terminal says how it finished. A tab that drew the same marker
/// for exit 0 and exit 101 makes a failed gate look like a passing one, which
/// is the one thing the panel exists to report.
pub fn state_marker(value: &TerminalTab) -> &'static str {
	match value.exit {
		None => "◐",
		Some(0) => "✓",
		Some(_) => "✗",
	}
}

/// The role a tab's title reads in.
pub fn tab_role(value: &TerminalTab, active: bool) -> Role {
	if value.failed() {
		return Role::StateError;
	}
	if active {
		return Role::TextPrimary;
	}
	if value.is_running() {
		Role::TextAccent
	} else {
		Role::TextSecondary
	}
}

/// The active tab's output.
fn body(value: &TerminalPanel, height: Pixels, cx: &App) -> Div {
	let Some(tab) = value.active_tab() else {
		return column(space::SNUG)
			.flex_1()
			.p(space::SNUG)
			.child(caption(EMPTY, cx));
	};

	let (lines, omitted) = tab.visible(rows(height));
	let mut stack = column(space::HAIR)
		.flex_1()
		.min_h_0()
		.overflow_hidden()
		.p(space::SNUG);
	if omitted > 0 {
		stack = stack.child(caption(omitted_line(omitted), cx));
	}
	stack = stack.children(
		lines
			.into_iter()
			.map(|line| mono(line.to_owned(), line_role(line), cx)),
	);
	if let Some(exit) = tab.exit {
		stack = stack.child(caption(exit_line(exit), cx));
	}
	stack
}

/// What the panel says when no tab resolves.
const EMPTY: &str = "no terminal open";

/// How many lines of output fit in `height`.
///
/// Derived from the panel's own height rather than a constant, so a resized
/// panel shows what it has room for. Floor, not round: a partial line at the
/// bottom is a line the operator reads half of and believes.
pub fn rows(height: Pixels) -> usize {
	let usable =
		f32::from(height) - f32::from(layout::TERMINAL_CLOSED) - f32::from(space::SNUG) * 2.0;
	if usable <= 0.0 {
		return 0;
	}
	(usable / f32::from(layout::TERMINAL_LINE)) as usize
}

/// What the panel says about the lines above the ones it is showing.
pub fn omitted_line(omitted: usize) -> String {
	match omitted {
		1 => "1 earlier line".to_owned(),
		omitted => format!("{omitted} earlier lines"),
	}
}

/// What the panel says about how a terminal ended.
pub fn exit_line(exit: i32) -> String {
	match exit {
		0 => "exited 0".to_owned(),
		exit => format!("exited {exit}"),
	}
}

/// The role one line of output reads in.
///
/// Compiler and runner output announces a failure in its own text, and the
/// panel is the surface that is read at a glance. A line that starts with
/// `error` reads as an error; everything else reads as output, including a line
/// that merely contains the word.
pub fn line_role(line: &str) -> Role {
	let trimmed = line.trim_start();
	if trimmed.starts_with("error") || trimmed.starts_with("Error") {
		return Role::StateError;
	}
	if trimmed.starts_with("warning") || trimmed.starts_with("Warning") {
		return Role::StateWarning;
	}
	Role::ToolOutput
}

/// A working directory, shortened to its last [`CWD_BUDGET`] segments.
pub fn short_cwd(cwd: &str) -> String {
	let segments: Vec<&str> = cwd.split('/').filter(|part| !part.is_empty()).collect();
	if segments.len() <= CWD_BUDGET {
		return cwd.to_owned();
	}
	format!("…/{}", segments[segments.len() - CWD_BUDGET..].join("/"))
}

/// The height the panel occupies, open or closed.
pub fn height(open: bool) -> Pixels {
	if open {
		layout::TERMINAL
	} else {
		layout::TERMINAL_CLOSED
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The panel is read at a glance while something else is being done, so its
	//! failures are all the same failure: a wrong state that looks like a
	//! correct one. A tab whose exit 101 draws like exit 0. A line count taken
	//! from a constant rather than from the panel's height, which shows nine
	//! lines in room for four and clips the newest. A "2 running" badge on a
	//! panel where one has already failed.
	//!
	//! WHAT IT DOES NOT CATCH. Anything a real emulator does. The contract
	//! carries lines, not a cell grid, and typing into the panel is not wired.

	use gpui::px;
	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn a_failed_terminal_never_draws_like_one_that_succeeded() {
		let failed = TerminalTab::exited("gate", "/repo/veyyon", 101);
		let passed = TerminalTab::exited("gate", "/repo/veyyon", 0);
		let running = TerminalTab::running("gate", "/repo/veyyon");

		assert_ne!(state_marker(&failed), state_marker(&passed));
		assert_ne!(state_marker(&running), state_marker(&passed));
		assert_ne!(state_marker(&running), state_marker(&failed));
		assert_eq!(tab_role(&failed, false), Role::StateError);
		assert_eq!(
			tab_role(&failed, true),
			Role::StateError,
			"an active failed tab lost its verdict"
		);
	}

	#[test]
	fn how_many_lines_fit_comes_from_the_panels_own_height() {
		let open = rows(layout::TERMINAL);
		let taller = rows(px(f32::from(layout::TERMINAL) + f32::from(layout::TERMINAL_LINE) * 3.0));
		assert!(open > 0, "an open panel has room for no lines");
		assert_eq!(taller, open + 3, "a taller panel did not show more lines");
		assert_eq!(rows(layout::TERMINAL_CLOSED), 0, "a closed panel claimed room for output");
		assert_eq!(rows(px(0.0)), 0);
	}

	#[test]
	fn the_visible_lines_are_the_newest_and_the_rest_are_counted() {
		let panel = fixtures::terminal_panel();
		let tab = panel.active_tab().expect("the fixture has an active tab");
		let (lines, omitted) = tab.visible(2);
		assert_eq!(lines.len(), 2);
		assert_eq!(omitted, tab.lines.len() - 2);
		assert_eq!(lines.last(), tab.lines.last().map(String::as_str).as_ref());
		assert_eq!(omitted_line(omitted), format!("{omitted} earlier lines"));
	}

	#[test]
	fn one_omitted_line_is_singular() {
		assert_eq!(omitted_line(1), "1 earlier line");
		assert_eq!(omitted_line(4), "4 earlier lines");
	}

	#[test]
	fn a_closed_panel_reports_what_is_running_and_an_open_one_does_not() {
		let panel = fixtures::terminal_panel();
		assert_eq!(strip_summary(&panel, false).as_deref(), Some("1 running"));
		assert_eq!(strip_summary(&panel, true), None, "the open panel counted itself twice");
	}

	#[test]
	fn a_failure_outranks_a_running_count_in_the_strip() {
		let panel = fixtures::terminal_panel();
		assert!(panel.has_failure(), "the fixture carries no failure");
		assert_eq!(summary_role(&panel), Role::StateError);

		let clean = TerminalPanel::new(vec![TerminalTab::running("cargo", "/repo")]);
		assert_eq!(summary_role(&clean), Role::TextAccent);
	}

	#[test]
	fn a_quiet_closed_panel_carries_no_summary_at_all() {
		let quiet = TerminalPanel::new(vec![TerminalTab::exited("cargo", "/repo", 0)]);
		assert_eq!(strip_summary(&quiet, false), None);
	}

	#[test]
	fn an_error_line_reads_as_an_error_and_a_line_merely_mentioning_one_does_not() {
		assert_eq!(line_role("error[E0433]: failed to resolve"), Role::StateError);
		assert_eq!(line_role("   error: could not compile"), Role::StateError);
		assert_eq!(line_role("warning: unused import"), Role::StateWarning);
		assert_eq!(line_role("0 errors, 0 warnings"), Role::ToolOutput);
		assert_eq!(line_role("    Checking veyyon-gui-kit v0.1.0"), Role::ToolOutput);
	}

	#[test]
	fn the_panel_says_which_key_changes_its_state() {
		assert_ne!(hint(true), hint(false));
		assert!(hint(true).contains("close"));
		assert!(hint(false).contains("open"));
	}

	#[test]
	fn a_closed_panel_still_occupies_its_strip() {
		assert_eq!(height(false), layout::TERMINAL_CLOSED);
		assert_eq!(height(true), layout::TERMINAL);
		assert!(f32::from(height(false)) > 0.0, "a closed panel disappeared with its tabs");
	}

	#[test]
	fn a_deep_working_directory_keeps_its_last_segments() {
		assert_eq!(short_cwd("/repo/veyyon"), "/repo/veyyon");
		assert_eq!(short_cwd("/repo/veyyon/hosts/gui"), "…/hosts/gui");
	}

	#[test]
	fn an_exit_status_is_reported_with_its_code() {
		assert_eq!(exit_line(0), "exited 0");
		assert_eq!(exit_line(101), "exited 101");
	}
}
