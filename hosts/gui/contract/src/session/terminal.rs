//! The bottom panel's data: terminals the session is running.
//!
//! A coding agent runs commands, and an operator watches them. The transcript
//! shows what a tool reported after it finished; this is what is on a terminal
//! now, including the one the operator typed into themselves.
//!
//! Lines rather than a cell grid. A full terminal emulator is a screen buffer
//! with a cursor, scroll regions and alternate screens, and none of that
//! reaches this contract yet: the panel shows the tail of what was written,
//! which is what a build log, a test run and a dev server are. Stated here
//! rather than found out by an operator running `vim` in it.

/// Every terminal the session is holding.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalPanel {
	pub tabs:   Vec<TerminalTab>,
	/// Which tab is on screen.
	pub active: usize,
}

impl TerminalPanel {
	pub fn new(tabs: Vec<TerminalTab>) -> TerminalPanel {
		TerminalPanel { tabs, active: 0 }
	}

	pub fn active(mut self, active: usize) -> TerminalPanel {
		self.active = active;
		self
	}

	/// The tab on screen, or `None` when there are none or the index is stale.
	pub fn active_tab(&self) -> Option<&TerminalTab> {
		self.tabs.get(self.active)
	}

	/// How many terminals are still running.
	///
	/// What the collapsed panel's own label reports: a closed panel hiding three
	/// running commands is the state where an operator waits on a build they
	/// cannot see.
	pub fn running(&self) -> usize {
		self.tabs.iter().filter(|tab| tab.is_running()).count()
	}

	/// Whether any terminal ended in a failure nobody has read.
	pub fn has_failure(&self) -> bool {
		self.tabs.iter().any(|tab| tab.failed())
	}
}

/// One terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalTab {
	pub title: String,
	/// The working directory, as the session knows it. Shortened by the
	/// renderer.
	pub cwd:   String,
	/// What has been written, oldest first, already stripped of escapes.
	pub lines: Vec<String>,
	/// The exit status, or `None` while it is still running.
	pub exit:  Option<i32>,
}

impl TerminalTab {
	/// A running terminal.
	pub fn running(title: impl Into<String>, cwd: impl Into<String>) -> TerminalTab {
		TerminalTab { title: title.into(), cwd: cwd.into(), lines: Vec::new(), exit: None }
	}

	/// A terminal that ended.
	pub fn exited(title: impl Into<String>, cwd: impl Into<String>, exit: i32) -> TerminalTab {
		TerminalTab { title: title.into(), cwd: cwd.into(), lines: Vec::new(), exit: Some(exit) }
	}

	pub fn line(mut self, line: impl Into<String>) -> TerminalTab {
		self.lines.push(line.into());
		self
	}

	pub fn lines(mut self, lines: impl IntoIterator<Item: Into<String>>) -> TerminalTab {
		self.lines.extend(lines.into_iter().map(Into::into));
		self
	}

	pub fn is_running(&self) -> bool {
		self.exit.is_none()
	}

	/// Whether it ended in a failure.
	pub fn failed(&self) -> bool {
		self.exit.is_some_and(|code| code != 0)
	}

	/// The last `rows` lines, and how many are above them.
	///
	/// The tail rather than the head: a terminal is read at the bottom, and a
	/// panel that showed the first twenty lines of a build would show the
	/// compiler banner forever. Same shape as the transcript's own truncation,
	/// so both report what they dropped instead of dropping it silently.
	pub fn visible(&self, rows: usize) -> (Vec<&str>, usize) {
		if rows == 0 {
			return (Vec::new(), self.lines.len());
		}
		let omitted = self.lines.len().saturating_sub(rows);
		(self.lines[omitted..].iter().map(String::as_str).collect(), omitted)
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! Two failures here are invisible on screen. A tail computed from the head
	//! shows a build's banner while the error scrolls past, and it looks like a
	//! terminal with nothing wrong in it. A stale active index either panics or
	//! draws another terminal's output under this terminal's title, which is
	//! worse than drawing nothing.
	//!
	//! WHAT IT DOES NOT CATCH. Anything a real emulator does: cursor movement,
	//! clearing, colour, alternate screens. The module states that it carries
	//! lines and not a grid.

	use super::*;

	fn tab() -> TerminalTab {
		TerminalTab::running("bun test", "/repo/veyyon")
			.lines(["one", "two", "three", "four", "five"])
	}

	#[test]
	fn the_visible_rows_are_the_last_ones_and_the_rest_are_counted() {
		let tab = tab();
		let (lines, omitted) = tab.visible(2);
		assert_eq!(lines, ["four", "five"]);
		assert_eq!(omitted, 3);
	}

	#[test]
	fn a_terminal_shorter_than_the_panel_omits_nothing() {
		let tab = tab();
		let (lines, omitted) = tab.visible(50);
		assert_eq!(lines.len(), 5);
		assert_eq!(omitted, 0);
	}

	#[test]
	fn a_panel_with_no_room_reports_every_line_as_omitted() {
		let tab = tab();
		let (lines, omitted) = tab.visible(0);
		assert!(lines.is_empty());
		assert_eq!(omitted, 5);
	}

	#[test]
	fn a_stale_active_index_reads_as_no_tab_rather_than_another_tabs_output() {
		let panel = TerminalPanel::new(vec![tab()]).active(4);
		assert_eq!(panel.active_tab(), None);
	}

	#[test]
	fn a_running_terminal_is_counted_and_a_finished_one_is_not() {
		let panel = TerminalPanel::new(vec![
			tab(),
			TerminalTab::exited("cargo check", "/repo/veyyon", 0),
			TerminalTab::exited("gate", "/repo/veyyon", 101),
		]);
		assert_eq!(panel.running(), 1);
		assert!(panel.has_failure());
	}

	#[test]
	fn a_zero_exit_is_not_a_failure_and_a_running_one_is_not_either() {
		assert!(!TerminalTab::exited("t", "/repo", 0).failed());
		assert!(!TerminalTab::running("t", "/repo").failed());
		assert!(TerminalTab::exited("t", "/repo", 1).failed());
		assert!(TerminalTab::exited("t", "/repo", -1).failed());
	}
}
