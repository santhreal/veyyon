//! Assertion and inspection helpers for test cases.
//!
//! Provides stable rectangular snapshots, row text extraction,
//! style set analysis, and snapshot diffing suitable for deterministic test
//! oracles.

use std::{collections::HashSet, fmt::Write as _};

use crate::vpty::{
	cell::{Attributes, ColorRgb},
	grid::Grid,
};

/// A rectangular region of terminal cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
	/// 0-indexed starting column (inclusive).
	pub start_col: usize,
	/// 0-indexed ending column (inclusive).
	pub end_col:   usize,
	/// 0-indexed starting row (inclusive).
	pub start_row: usize,
	/// 0-indexed ending row (inclusive).
	pub end_row:   usize,
}

impl Region {
	/// Creates a new region bounding the given coordinates inclusive.
	#[must_use]
	pub const fn new(start_col: usize, start_row: usize, end_col: usize, end_row: usize) -> Self {
		Self { start_col, end_col, start_row, end_row }
	}

	/// Region covering the whole grid.
	#[must_use]
	pub const fn full_grid(grid: &Grid) -> Self {
		Self {
			start_col: 0,
			end_col:   grid.cols().saturating_sub(1),
			start_row: 0,
			end_row:   grid.rows().saturating_sub(1),
		}
	}
}

/// Distinct style combination found in cells.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StyleInfo {
	/// Foreground color.
	pub fg:    Option<ColorRgb>,
	/// Background color.
	pub bg:    Option<ColorRgb>,
	/// Text attributes.
	pub attrs: Attributes,
}

/// Inspection and assertion helpers.
pub struct Assert;

impl Assert {
	/// Extracts the displayed text of a single row, trimmed of trailing
	/// whitespace.
	#[must_use]
	pub fn row_text(grid: &Grid, row: usize) -> String {
		let mut text = String::with_capacity(grid.cols());
		for col in 0..grid.cols() {
			if let Some(cell) = grid.cell(col, row) {
				text.push_str(cell.display_str());
			}
		}
		text.trim_end().to_string()
	}

	/// Extracts the displayed text of a single row including trailing spaces.
	#[must_use]
	pub fn row_text_exact(grid: &Grid, row: usize) -> String {
		let mut text = String::with_capacity(grid.cols());
		for col in 0..grid.cols() {
			if let Some(cell) = grid.cell(col, row) {
				text.push_str(cell.display_str());
			}
		}
		text
	}

	/// Extracts lines of text from a rectangular region.
	#[must_use]
	pub fn region_text(grid: &Grid, region: Region) -> Vec<String> {
		let mut lines = Vec::new();
		for row in region.start_row..=region.end_row.min(grid.rows().saturating_sub(1)) {
			let mut line = String::new();
			for col in region.start_col..=region.end_col.min(grid.cols().saturating_sub(1)) {
				if let Some(cell) = grid.cell(col, row) {
					line.push_str(cell.display_str());
				}
			}
			lines.push(line.trim_end().to_string());
		}
		lines
	}

	/// Collects all distinct styles present in a region.
	#[must_use]
	pub fn styles_in_region(grid: &Grid, region: Region) -> HashSet<StyleInfo> {
		let mut styles = HashSet::new();
		for row in region.start_row..=region.end_row.min(grid.rows().saturating_sub(1)) {
			for col in region.start_col..=region.end_col.min(grid.cols().saturating_sub(1)) {
				if let Some(cell) = grid.cell(col, row) {
					// Don't record blank cells with default styles unless specifically styled
					if !cell.content.is_empty()
						|| cell.fg.is_some()
						|| cell.bg.is_some()
						|| !cell.attrs.is_empty()
					{
						styles.insert(StyleInfo { fg: cell.fg, bg: cell.bg, attrs: cell.attrs });
					}
				}
			}
		}
		styles
	}

	/// Produces a deterministic text snapshot of the full grid for diffing.
	/// Each line is represented with its row number, followed by the row text,
	/// and any styled spans recorded below.
	#[must_use]
	pub fn grid_snapshot(grid: &Grid) -> String {
		let mut output = String::new();
		for row in 0..grid.rows() {
			let line_text = Self::row_text_exact(grid, row);
			let _ = writeln!(output, "{row:03}: |{line_text}|");
		}
		output
	}

	/// Verifies whether a sub-rectangle of text matches an expected multi-line
	/// template.
	#[must_use]
	pub fn region_matches(grid: &Grid, region: Region, expected_lines: &[&str]) -> bool {
		let actual = Self::region_text(grid, region);
		if actual.len() != expected_lines.len() {
			return false;
		}
		for (act, exp) in actual.iter().zip(expected_lines.iter()) {
			if act != exp {
				return false;
			}
		}
		true
	}
}
