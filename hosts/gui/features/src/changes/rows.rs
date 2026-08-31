//! Retained row projection for the virtualized diff viewport.
//!
//! Parsing stays in core. This module only flattens canonical `FileDiff`
//! values when a snapshot or presentation preference changes. Rendering reads
//! one `Copy` row at a time and never allocates a second projection per frame.

use std::ops::Range;

use veyyon_gui_core::text::diff::{DiffLine, FileDiff, LineKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
	Unified,
	Split,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
	Added,
	Deleted,
	Renamed,
	Binary,
	Truncated,
	Malformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
	File { file: u32 },
	Notice { file: u32, notice: Notice },
	Hunk { file: u32, hunk: u32 },
	Unified { file: u32, hunk: u32, line: u32 },
	Split { file: u32, hunk: u32, left: Option<u32>, right: Option<u32> },
	Pad { file: u32 },
}

#[derive(Debug, Default)]
pub struct Rows {
	items: Vec<Row>,
	files: Vec<Range<usize>>,
}

impl Rows {
	pub fn as_slice(&self) -> &[Row] {
		&self.items
	}

	pub fn len(&self) -> usize {
		self.items.len()
	}

	pub fn file_range(&self, file: usize) -> Option<&Range<usize>> {
		self.files.get(file)
	}

	pub fn file_at(&self, row: usize) -> Option<usize> {
		self.files.iter().position(|range| range.contains(&row))
	}

	pub fn hunk_row(&self, file: usize, hunk: usize) -> Option<usize> {
		let range = self.files.get(file)?;
		self.items[range.clone()]
			.iter()
			.position(|row| {
				matches!(
					row,
					Row::Hunk { file: row_file, hunk: row_hunk }
						if *row_file as usize == file && *row_hunk as usize == hunk
				)
			})
			.map(|offset| range.start + offset)
	}

	pub fn next_hunk(&self, current: Option<usize>, forward: bool) -> Option<usize> {
		if forward {
			let start = current.map_or(0, |row| row.saturating_add(1));
			self.items[start.min(self.items.len())..]
				.iter()
				.position(|row| matches!(row, Row::Hunk { .. }))
				.map(|offset| start + offset)
		} else {
			let end = current.unwrap_or(self.items.len()).min(self.items.len());
			self.items[..end]
				.iter()
				.rposition(|row| matches!(row, Row::Hunk { .. }))
		}
	}

	pub fn rebuild(
		&mut self,
		files: &[FileDiff],
		layout: Layout,
		mut collapsed: impl FnMut(usize, &FileDiff) -> bool,
		truncated: bool,
		malformed_hunks: u32,
	) {
		self.items.clear();
		self.files.clear();
		self.files.reserve(files.len());

		let estimated = files
			.iter()
			.map(|file| {
				file
					.hunks
					.iter()
					.map(|hunk| hunk.lines.len() + 1)
					.sum::<usize>()
					+ 2
			})
			.sum();
		self.items.reserve(estimated);

		for (file_index, file) in files.iter().enumerate() {
			let file_index = file_index as u32;
			let start = self.items.len();
			self.items.push(Row::File { file: file_index });
			if !collapsed(file_index as usize, file) {
				self.push_notices(
					file_index,
					file,
					file_index == 0 && truncated,
					if file_index == 0 { malformed_hunks } else { 0 },
				);
				for (hunk_index, hunk) in file.hunks.iter().enumerate() {
					self
						.items
						.push(Row::Hunk { file: file_index, hunk: hunk_index as u32 });
					match layout {
						Layout::Unified => {
							for line in 0..hunk.lines.len() {
								self.items.push(Row::Unified {
									file: file_index,
									hunk: hunk_index as u32,
									line: line as u32,
								});
							}
						},
						Layout::Split => {
							push_split(&mut self.items, file_index, hunk_index as u32, &hunk.lines)
						},
					}
				}
				self.items.push(Row::Pad { file: file_index });
			}
			self.files.push(start..self.items.len());
		}
	}

	fn push_notices(
		&mut self,
		file_index: u32,
		file: &FileDiff,
		truncated: bool,
		malformed_hunks: u32,
	) {
		use veyyon_gui_core::text::diff::Change;
		let notice = match file.change {
			Change::Added => Some(Notice::Added),
			Change::Removed => Some(Notice::Deleted),
			Change::Renamed => Some(Notice::Renamed),
			Change::Modified => None,
		};
		if let Some(notice) = notice {
			self.items.push(Row::Notice { file: file_index, notice });
		}
		if file.binary {
			self
				.items
				.push(Row::Notice { file: file_index, notice: Notice::Binary });
		}
		if truncated {
			self
				.items
				.push(Row::Notice { file: file_index, notice: Notice::Truncated });
		}
		if malformed_hunks > 0 {
			self
				.items
				.push(Row::Notice { file: file_index, notice: Notice::Malformed });
		}
	}
}

fn push_split(rows: &mut Vec<Row>, file: u32, hunk: u32, lines: &[DiffLine]) {
	let mut index = 0usize;
	while index < lines.len() {
		if lines[index].kind == LineKind::Context {
			rows.push(Row::Split { file, hunk, left: Some(index as u32), right: Some(index as u32) });
			index += 1;
			continue;
		}

		let removed_start = index;
		while index < lines.len() && lines[index].kind == LineKind::Removed {
			index += 1;
		}
		let removed_end = index;
		let added_start = index;
		while index < lines.len() && lines[index].kind == LineKind::Added {
			index += 1;
		}
		let added_end = index;

		if removed_start == removed_end {
			rows.push(Row::Split { file, hunk, left: None, right: Some(added_start as u32) });
			index = added_start.saturating_add(1);
			continue;
		}

		let count = (removed_end - removed_start).max(added_end - added_start);
		for offset in 0..count {
			rows.push(Row::Split {
				file,
				hunk,
				left: (removed_start + offset < removed_end).then_some((removed_start + offset) as u32),
				right: (added_start + offset < added_end).then_some((added_start + offset) as u32),
			});
		}
	}
}
