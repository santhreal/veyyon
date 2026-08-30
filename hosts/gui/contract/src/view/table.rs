//! Columns and rows.
//!
//! One owner for tabular data. The usage report, the model catalog, the release
//! list and a tool that returns rows all carry this, so a change to how a table
//! reads — a column that right-aligns, a total row that stands out — is one
//! change in each host rather than one per surface.

use super::{Badge, Tone};

/// A table.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Table {
	/// Column headers. Empty for a table drawn without a header row.
	pub columns: Vec<String>,
	pub rows:    Vec<TableRow>,
	/// What to say instead when there are no rows.
	pub empty:   Option<String>,
}

impl Table {
	pub fn new(columns: Vec<String>, rows: Vec<TableRow>) -> Table {
		Table { columns, rows, empty: None }
	}

	pub fn empty_text(mut self, empty: impl Into<String>) -> Table {
		self.empty = Some(empty.into());
		self
	}

	/// Whether every row has a cell for every column.
	///
	/// A short row renders as a shifted table: every cell after the gap reads
	/// under the wrong column, and nothing about it looks like an error. A
	/// renderer pads rather than dropping the row, and the fixtures assert this
	/// so a fixture cannot ship a shifted table.
	pub fn is_aligned(&self) -> bool {
		self.columns.is_empty()
			|| self
				.rows
				.iter()
				.all(|row| row.cells.len() == self.columns.len())
	}
}

/// One row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableRow {
	pub cells:    Vec<String>,
	pub badges:   Vec<Badge>,
	pub tone:     Option<Tone>,
	/// True for a total, a current version, or whatever the rest is being
	/// compared against.
	pub emphasis: bool,
}

impl TableRow {
	pub fn new(cells: Vec<String>) -> TableRow {
		TableRow { cells, badges: Vec::new(), tone: None, emphasis: false }
	}

	pub fn tone(mut self, tone: Tone) -> TableRow {
		self.tone = Some(tone);
		self
	}

	pub fn emphasis(mut self) -> TableRow {
		self.emphasis = true;
		self
	}

	pub fn badge(mut self, badge: Badge) -> TableRow {
		self.badges.push(badge);
		self
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A table whose rows are shorter than its header renders as a shifted
	//! table, and it looks like data rather than a defect. [`Table::is_aligned`]
	//! is what a renderer and the fixtures check, so it has to be right about
	//! the headerless case too, where there is nothing to align against.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the renderer pads or drops. That is the
	//! renderer's own test.

	use super::*;

	#[test]
	fn a_short_row_is_not_aligned() {
		let table =
			Table::new(vec!["version".to_owned(), "date".to_owned(), "size".to_owned()], vec![
				TableRow::new(vec!["1.3.0".to_owned(), "2026-04-27".to_owned(), "48 MB".to_owned()]),
				TableRow::new(vec!["1.2.9".to_owned(), "2026-04-20".to_owned()]),
			]);
		assert!(!table.is_aligned());
	}

	#[test]
	fn a_long_row_is_not_aligned_either() {
		let table = Table::new(vec!["name".to_owned()], vec![TableRow::new(vec![
			"model".to_owned(),
			"stray".to_owned(),
		])]);
		assert!(!table.is_aligned());
	}

	#[test]
	fn a_headerless_table_is_aligned_by_definition() {
		let table = Table::new(Vec::new(), vec![TableRow::new(vec![
			"the plan replaces the transport".to_owned(),
		])]);
		assert!(table.is_aligned());
	}
}
