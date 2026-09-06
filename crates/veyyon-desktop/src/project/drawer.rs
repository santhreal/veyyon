//! The terminal drawer projection: tabs, process list, and visible terminal
//! grid.

use std::collections::HashMap;

use veyyon_desktop_model::{Domains, TerminalStatus};
use veyyon_desktop_surface::{
	Cell, DrawerContent, DrawerTab, ProcessRow, terminal::TerminalEmulator,
};

use super::{PANE_LINE_CEILING, elapsed_label};

/// Projects domain terminals and processes into the shell state's drawer
/// content.
pub fn project_drawer<S: std::hash::BuildHasher>(
	domains: &Domains,
	emulators: &HashMap<String, TerminalEmulator, S>,
	now_ms: u64,
	drawer: &mut DrawerContent,
) {
	let mut tabs = Vec::new();
	for term in &domains.terminals {
		let title = emulators
			.get(&term.id)
			.map(|e| e.grid().title.clone())
			.filter(|t| !t.is_empty())
			.unwrap_or_else(|| {
				if term.shell.is_empty() {
					"Terminal".to_string()
				} else {
					term.shell.clone()
				}
			});
		tabs.push(DrawerTab::Terminal { id: term.id.clone(), title });
	}

	if !domains.processes.is_empty() {
		tabs.push(DrawerTab::Processes);
	}

	// The active tab follows its identity, not its index: a terminal that
	// exited and left the list moves every tab after it. A tab nobody chose,
	// or one that is gone, gives way to the last running terminal, which is
	// the one a turn is most likely writing to, then to the last one opened.
	drawer.active_tab = drawer
		.tabs
		.get(drawer.active_tab)
		.and_then(|previous| tabs.iter().position(|tab| same_tab(tab, previous)))
		.unwrap_or_else(|| default_tab(domains));
	drawer.tabs = tabs;

	drawer.processes = domains
		.processes
		.iter()
		.map(|p| ProcessRow {
			name:          p.name.clone(),
			pid:           p.pid,
			status:        p.status.clone(),
			elapsed_label: elapsed_label(now_ms.saturating_sub(p.started_at_ms)),
			terminated_by: p.terminated_by.clone(),
			exit_code:     p.exit_code,
		})
		.collect();

	if let Some(DrawerTab::Terminal { id, .. }) = drawer.tabs.get(drawer.active_tab) {
		if let Some(emu) = emulators.get(id) {
			copy_grid(emu, drawer);
			drawer.selection = emu.grid().selection;
		} else if let Some(output) = domains.terminal_output.get(id) {
			let mut emu = TerminalEmulator::new(80, 24);
			emu.feed(&output.data);
			copy_grid(&emu, drawer);
		}
	} else if drawer.grid_rows.is_empty() {
		for _ in 0..11 {
			drawer.grid_rows.push(vec![Cell::blank(); 80]);
		}
	}
}

/// Whether two tabs stand for the same terminal or the process list. A
/// terminal's title changes with every OSC it prints, so identity is its id.
fn same_tab(a: &DrawerTab, b: &DrawerTab) -> bool {
	match (a, b) {
		(DrawerTab::Terminal { id: a, .. }, DrawerTab::Terminal { id: b, .. }) => a == b,
		(DrawerTab::Processes, DrawerTab::Processes) => true,
		(DrawerTab::Terminal { .. }, DrawerTab::Processes)
		| (DrawerTab::Processes, DrawerTab::Terminal { .. }) => false,
	}
}

/// The tab the drawer opens on when nothing chose one: the last running
/// terminal, else the last terminal, else the process list at index zero.
/// Terminal tabs sit at their domain index, since they are pushed in order.
fn default_tab(domains: &Domains) -> usize {
	domains
		.terminals
		.iter()
		.rposition(|terminal| terminal.status == TerminalStatus::Running)
		.unwrap_or_else(|| domains.terminals.len().saturating_sub(1))
}

/// Copies the emulator's visible grid, cursor and title onto the drawer.
fn copy_grid(emu: &TerminalEmulator, drawer: &mut DrawerContent) {
	let grid = emu.grid();
	drawer.grid_rows.clear();
	for r in 0..grid.rows {
		if let Some(row) = grid.visible_row(r) {
			drawer.grid_rows.push(row.to_vec());
		}
	}
	drawer.cursor_col = grid.cursor_col;
	drawer.cursor_row = grid.cursor_row;
	drawer.cursor_visible = grid.cursor_visible;
	drawer.title.clone_from(&grid.title);
}

/// The drawer's lines as plain strings, extracted from the active or last
/// running terminal.
#[must_use]
pub fn drawer_lines(domains: &Domains) -> Vec<String> {
	let shown = domains
		.terminals
		.iter()
		.rev()
		.find(|terminal| terminal.status == TerminalStatus::Running)
		.or_else(|| domains.terminals.last());
	let Some(terminal) = shown else {
		return Vec::new();
	};
	let Some(scrollback) = domains.terminal_output.get(&terminal.id) else {
		return Vec::new();
	};
	let text = String::from_utf8_lossy(&scrollback.data);
	let plain = strip_control_sequences(&text);
	let mut lines: Vec<&str> = plain.lines().collect();
	if lines.len() > PANE_LINE_CEILING {
		lines.drain(..lines.len() - PANE_LINE_CEILING);
	}
	lines.into_iter().map(str::to_string).collect()
}

/// Text with its ANSI control sequences removed.
#[must_use]
pub fn strip_control_sequences(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut chars = text.chars();
	while let Some(c) = chars.next() {
		match c {
			'\u{1b}' => match chars.next() {
				Some('[') => {
					for next in chars.by_ref() {
						if ('\u{40}'..='\u{7e}').contains(&next) {
							break;
						}
					}
				},
				Some(']') => {
					let mut previous = '\0';
					for next in chars.by_ref() {
						if next == '\u{07}' || (previous == '\u{1b}' && next == '\\') {
							break;
						}
						previous = next;
					}
				},
				_ => {},
			},
			'\r' => {},
			_ => out.push(c),
		}
	}
	out
}
