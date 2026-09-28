//! Every screen the drawer draws holds the columns and rows the window
//! measured for its box, before the host answers the resize it was sent.
//!
//! WHY: the window measures how many cells the grid's box holds, and that
//! measure has to reach the text the drawer draws, not only the host. The
//! retired window built a grid at a constant 80 by 24 wherever it replayed
//! output itself and resized only the terminal that was open, so a wide window
//! drew a narrow column of text beside blank space, and a tab switched to
//! after a resize kept the breaks of the width it was first drawn at. The
//! class closed here: a measure that reaches no screen, one that reaches only
//! the shown screen and leaves the others to draw stale, output fed in before
//! the measure and never broken again, a running terminal told its size more
//! than once per measure or never, an ended one told at all, and a terminal
//! told the size of the shorter box a process tab draws in when it is shown
//! after one. The sweep takes every screen tab from the strip the window
//! lists at run time, so a terminal or a process added to the fixture is
//! swept.
//!
//! Gap: whether the host applies the size is the host's; whether the re-break
//! is right is the model's reflow suite. The rebuilt drawer draws no blank
//! grid for an empty drawer (it states why it is empty), so the retired
//! blank-grid case has no member here.

use gpui::TestAppContext;
use veyyon_desktop_app::drawer::DrawerTab;
use veyyon_desktop_model::{HostAction, TerminalStatus};

use super::harness::{
	Win, both, logs, opened, output, process, processes, terminal, terminals, window,
};

/// A line longer than `cols` columns by a few, which a grid `cols` wide
/// breaks and a wider one draws whole.
fn line_past(cols: u16) -> String {
	"0123456789"
		.chars()
		.cycle()
		.take(usize::from(cols) + 6)
		.collect()
}

fn show(w: &mut Win<'_>, tab: &DrawerTab) {
	w.click(&format!("drawer.tab:{}", tab.slug()));
	assert_eq!(w.shown().as_ref(), Some(tab));
}

/// The cells the last frame measured for the shown tab's box; a process tab's
/// box is shorter than a terminal's by the input line under it.
fn measured(w: &Win<'_>) -> (u16, u16) {
	w.cells().expect("a frame measured the grid's box")
}

/// The terminals `sent` resized, with the size each was told.
fn resized(sent: &[HostAction]) -> Vec<(String, u16, u16)> {
	sent
		.iter()
		.filter_map(|action| match action {
			HostAction::ResizeTerminal { terminal_id, cols, rows } => {
				Some((terminal_id.clone(), *cols, *rows))
			},
			_ => None,
		})
		.collect()
}

#[gpui::test]
fn every_screen_is_drawn_at_the_measured_cells_and_each_running_terminal_told_once(
	app: &mut TestAppContext,
) {
	let mut events = opened(both());
	events.extend([
		terminals(vec![
			terminal("t1", TerminalStatus::Running),
			terminal("t2", TerminalStatus::Running),
			terminal("t3", TerminalStatus::Exited { code: 2 }),
		]),
		processes(vec![process("dev", "running", None)]),
	]);
	let mut w = window(app, events);
	w.toggle();
	let before = measured(&w);
	let cells = |(cols, rows): (u16, u16)| Some((usize::from(cols), usize::from(rows)));
	let screens: Vec<DrawerTab> = w.strip().into_iter().filter(DrawerTab::is_screen).collect();
	let running = |tab: &DrawerTab| matches!(tab, DrawerTab::Terminal(id) if id != "t3");
	assert_eq!(screens.len(), 4, "three terminals and a process: {screens:?}");

	let mut told = Vec::new();
	for tab in &screens {
		show(&mut w, tab);
		let measure = measured(&w);
		assert_eq!(measure.0, before.0, "{tab:?}'s box is as wide as the drawer");
		assert_eq!(w.grid(tab), cells(measure), "{tab:?} is built at the cells its box holds");
		if running(tab) {
			told.push((tab.slug().replace("terminal:", ""), measure.0, measure.1));
		}
	}
	let mut sent = resized(&w.sent());
	sent.sort();
	assert_eq!(sent, told, "each running terminal is told the measure once, an ended one never");

	let line = line_past(before.0);
	w.apply(vec![
		output("t1", 1, &format!("{line}\r\n")),
		output("t2", 1, &format!("{line}\r\n")),
		output("t3", 1, &format!("{line}\r\n")),
		logs("dev", &[&line]),
	]);
	for tab in &screens {
		show(&mut w, tab);
		assert!(!w.draws(&line), "{tab:?} breaks a line wider than its {before:?} cells");
	}
	let first = screens[0].clone();
	show(&mut w, &first);
	w.requests();

	w.resize(1800.0, 800.0);
	let after = measured(&w);
	assert!(
		after.0 > before.0 + 6,
		"the wider window holds the whole line: {before:?} -> {after:?}"
	);
	assert_eq!(
		w.grid(&first),
		cells(after),
		"the shown screen is re-broken by the frame that measured"
	);
	assert!(w.draws(&line), "and draws the line whole before the host answers");
	assert_eq!(resized(&w.sent()), vec![("t1".to_owned(), after.0, after.1)]);

	for tab in &screens {
		show(&mut w, tab);
		let measure = measured(&w);
		assert_eq!(measure.0, after.0, "{tab:?} shown after the resize is as wide as the drawer");
		assert_eq!(w.grid(tab), cells(measure), "{tab:?} shown after the resize holds its cells");
		assert!(w.draws(&line), "{tab:?} draws the line whole at the new width");
	}
	assert_eq!(
		resized(&w.sent()),
		vec![("t2".to_owned(), after.0, after.1)],
		"the other running terminal is told once it is shown, the ended one and the process never"
	);

	for tab in &screens {
		show(&mut w, tab);
	}
	show(&mut w, &first);
	w.toggle();
	w.toggle();
	assert_eq!(resized(&w.sent()), Vec::new(), "a settled measure is told to no terminal again");
	assert_eq!(w.cells(), Some(after), "and the drawer reopens at it");
}
