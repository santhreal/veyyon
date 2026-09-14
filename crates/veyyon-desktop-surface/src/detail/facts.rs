//! What a detail popover states, derived from the state the frame draws from.
//!
//! Every value here is already in the window's state and is already cut
//! somewhere: a path the panel ellipsises, a catalog row the footer reduces to
//! a display name, a file header the diff pane has scrolled past. Nothing is
//! computed that a surface could have drawn, and nothing is invented for a
//! payload the state no longer holds -- a tree row that left the snapshot, a
//! model the host withdrew and a row index that is not a hunk header each
//! yield no facts, which is what closes the popover rather than drawing an
//! empty card.

use veyyon_desktop_model::InputModality;

use super::DetailKind;
use crate::{
	ShellState,
	right_panel::content::{DiffFile, DiffRow, TreeRowItem},
};

/// One line of a detail popover: what the value is, and the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailRow {
	pub label: &'static str,
	pub value: String,
}

impl DetailRow {
	fn new(label: &'static str, value: impl Into<String>) -> Self {
		Self { label, value: value.into() }
	}
}

/// What one detail popover says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailFacts {
	pub heading: String,
	pub rows:    Vec<DetailRow>,
}

/// The facts a detail popover states, or `None` when the state no longer
/// holds what it was opened on.
#[must_use]
pub fn detail_facts(kind: &DetailKind, state: &ShellState) -> Option<DetailFacts> {
	match kind {
		DetailKind::TreeRow(path) => {
			let row = state.panel.tree.rows.iter().find(|row| row.path == *path)?;
			Some(tree_row_facts(row))
		},
		DetailKind::Model => model_facts(state),
		DetailKind::DiffHunk { path, row } => {
			let file = state.panel.diff.iter().find(|file| file.path == *path)?;
			hunk_facts(file, *row)
		},
	}
}

fn tree_row_facts(row: &TreeRowItem) -> DetailFacts {
	let mut rows = vec![
		DetailRow::new("Path", row.path.clone()),
		DetailRow::new("Kind", if row.is_dir { "Directory" } else { "File" }),
	];
	rows.push(match row.changed {
		Some((added, removed)) => DetailRow::new("Changed", format!("+{added} -{removed}")),
		None => DetailRow::new("Changed", "Unchanged"),
	});
	DetailFacts { heading: row.name.clone(), rows }
}

fn model_facts(state: &ShellState) -> Option<DetailFacts> {
	let model = state.composer.model.as_ref()?;
	let current = model.current.as_ref()?;
	let option = model.active();
	let heading = option.map_or_else(|| current.model.clone(), |option| option.name.clone());
	let mut rows = vec![
		DetailRow::new("Provider", current.provider.clone()),
		DetailRow::new("Identifier", current.model.clone()),
	];
	match option {
		// A model the host is sending turns to that the catalog does not list
		// is the one state where the footer's name is all there is, so the
		// popover says that rather than reporting a capability it never read.
		None => rows.push(DetailRow::new("Catalog", "Not listed")),
		Some(option) => {
			rows.push(DetailRow::new(
				"Reasoning",
				if option.reasoning {
					"Supported"
				} else {
					"Not supported"
				},
			));
			rows.push(DetailRow::new("Accepts", accepted_inputs(&option.input)));
		},
	}
	Some(DetailFacts { heading, rows })
}

/// The inputs a catalog row declares, in the order it declared them. An empty
/// list is the catalog saying nothing, which is not the same as a model that
/// takes nothing.
fn accepted_inputs(input: &[InputModality]) -> String {
	if input.is_empty() {
		return "Not stated".to_owned();
	}
	let mut names: Vec<&str> = Vec::with_capacity(input.len());
	for modality in input {
		let name = match modality {
			InputModality::Text => "Text",
			InputModality::Image => "Image",
			InputModality::Video => "Video",
			InputModality::Other => "Other",
		};
		if !names.contains(&name) {
			names.push(name);
		}
	}
	names.join(", ")
}

fn hunk_facts(file: &DiffFile, row: usize) -> Option<DetailFacts> {
	let DiffRow::HunkHeader { old_start, old_count, new_start, new_count, symbol } =
		file.rows.get(row)?
	else {
		return None;
	};
	let (added, removed) = hunk_counts(&file.rows, row);
	let mut rows = vec![
		DetailRow::new("File", file.path.clone()),
		DetailRow::new("Before", span_label(*old_start, *old_count)),
		DetailRow::new("After", span_label(*new_start, *new_count)),
		DetailRow::new("Changed", format!("+{added} -{removed}")),
	];
	if let Some(symbol) = symbol {
		rows.push(DetailRow::new("Symbol", symbol.clone()));
	}
	Some(DetailFacts { heading: hunk_heading(*new_start, *new_count), rows })
}

/// The lines one side of a hunk covers. A count of zero is a side the hunk
/// only inserts into or only deletes from, which has a position and no lines,
/// so it is stated as the position rather than as a range ending before it
/// starts.
fn span_label(start: usize, count: usize) -> String {
	match count {
		0 => format!("at line {start}"),
		1 => format!("line {start}"),
		_ => format!("lines {start}-{}", start + count - 1),
	}
}

fn hunk_heading(new_start: usize, new_count: usize) -> String {
	format!("Hunk {}", span_label(new_start, new_count))
}

/// The added and removed lines of one hunk: the rows after its header, up to
/// the next header or the end of the file's rows. The file's own totals cover
/// every hunk in it, so a file with four hunks would report the same figure
/// four times.
fn hunk_counts(rows: &[DiffRow], header: usize) -> (usize, usize) {
	let mut added = 0;
	let mut removed = 0;
	for row in rows.iter().skip(header + 1) {
		match row {
			DiffRow::HunkHeader { .. } => break,
			DiffRow::Added { .. } => added += 1,
			DiffRow::Removed { .. } => removed += 1,
			DiffRow::Context { .. }
			| DiffRow::Collapsed { .. }
			| DiffRow::Binary { .. }
			| DiffRow::Unavailable { .. }
			| DiffRow::Truncated { .. } => {},
		}
	}
	(added, removed)
}
