//! Dual-ground resolution: what a cell actually looks like on the two terminal
//! backgrounds that matter, and which cells vanish on one of them.
//!
//! A terminal cell carries optional colours. `None` means "the terminal's
//! default", and the terminal's default is not a constant: the same output is
//! drawn on a dark grey ground in one terminal and on pure black in another. A
//! check that resolves defaults against one ground answers for one operator's
//! machine, which is how an explicit dark background fill can look invisible in
//! one place and ship as a black slab in another.
//!
//! So resolution takes the ground as a parameter and every finding is reported
//! per ground, and [`DualGround::ground_dependent`] is the interesting output:
//! the cells that are fine on one ground and broken on the other. Those are the
//! ones no single terminal can show you.
//!
//! This module is not visual evidence and does not produce an image. It reads a
//! parsed cell grid and reports colour relationships as numbers, which is the
//! one kind of rendering claim a test may make on its own; a picture of the
//! product comes from the capture configuration in
//! `docs/handbook/src/foundations/verification.md` and from nowhere else.

pub mod contrast;

#[cfg(test)]
mod tests;

use std::{collections::BTreeMap, fmt};

use crate::vpty::cell::{Cell, ColorRgb};

/// A terminal's default background.
///
/// Two members, deliberately. These are not "some themes": they are the two
/// grounds the product is actually drawn on, and a third would be a claim about
/// a terminal nobody here runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Ground {
	/// The dark grey a normal terminal profile uses, and the one the product's
	/// own theme assumes.
	Grey,
	/// Pure black, which is what a default profile and most capture tooling
	/// give you.
	Black,
}

impl Ground {
	pub const GREY_RGB: ColorRgb = ColorRgb::new(0x1e, 0x21, 0x27);

	#[must_use]
	pub const fn rgb(self) -> ColorRgb {
		match self {
			Self::Grey => Self::GREY_RGB,
			Self::Black => ColorRgb::BLACK,
		}
	}

	/// The default foreground a terminal pairs with this ground. Both grounds
	/// are dark, so both default to near-white; it is named rather than assumed
	/// because a cell with no explicit foreground still has to be judged.
	#[must_use]
	pub const fn default_fg(self) -> ColorRgb {
		ColorRgb::new(0xd0, 0xd4, 0xda)
	}

	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Grey => "grey",
			Self::Black => "black",
		}
	}

	/// Both grounds, so a sweep cannot check one and claim the pair.
	#[must_use]
	pub const fn all() -> [Self; 2] {
		[Self::Grey, Self::Black]
	}
}

impl fmt::Display for Ground {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

/// How much of the foreground the dim attribute takes away.
///
/// A 0-255 fraction toward the background, at 60%: enough that dim-on-dark
/// stops meeting the text ratio, which is the behaviour a theme has to account
/// for.
pub const DIM_WEIGHT: u8 = 153;

/// A cell's colours, with defaults, inverse and dim already applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolved {
	pub fg:          ColorRgb,
	pub bg:          ColorRgb,
	/// True when the cell carried an explicit background, so a fill can be told
	/// apart from a cell that simply inherited the ground.
	pub explicit_bg: bool,
}

impl Resolved {
	/// The contrast between the glyph and the surface it sits on.
	#[must_use]
	pub fn glyph_ratio(&self) -> f64 {
		contrast::ratio(self.fg, self.bg)
	}
}

/// What one cell looks like on `ground`.
///
/// Order matters and is the part a hand-rolled version gets wrong: inverse
/// swaps the colours the cell declared, and dim applies to the foreground that
/// results, not to the one before the swap. A dim inverse cell is dimmed toward
/// its new background.
#[must_use]
pub fn resolve(cell: &Cell, ground: Ground) -> Resolved {
	let declared_fg = cell.fg.unwrap_or_else(|| ground.default_fg());
	let declared_bg = cell.bg.unwrap_or_else(|| ground.rgb());
	let (mut fg, bg) = if cell.attrs.inverse {
		(declared_bg, declared_fg)
	} else {
		(declared_fg, declared_bg)
	};
	if cell.attrs.dim {
		fg = contrast::blend(fg, bg, DIM_WEIGHT);
	}
	// An inverse cell's background is the foreground it declared, which is a
	// surface the reader sees whether or not the cell named a background.
	let explicit_bg = cell.bg.is_some() || cell.attrs.inverse;
	Resolved { fg, bg, explicit_bg }
}

/// Something a reader cannot see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finding {
	/// A glyph against its own background, below the text ratio.
	Illegible { row: usize, column: usize, ratio_hundredths: u32 },
	/// A cell that painted a background, and that background is
	/// indistinguishable from the ground it was painted on. The block is there
	/// and nobody can see it — which is the same defect as painting nothing,
	/// except that it looks deliberate in the code.
	InvisibleFill { row: usize, column: usize, ratio_hundredths: u32 },
}

impl Finding {
	#[must_use]
	pub const fn position(self) -> (usize, usize) {
		match self {
			Self::Illegible { row, column, .. } | Self::InvisibleFill { row, column, .. } => {
				(row, column)
			},
		}
	}

	#[must_use]
	pub const fn kind(self) -> &'static str {
		match self {
			Self::Illegible { .. } => "illegible",
			Self::InvisibleFill { .. } => "invisible-fill",
		}
	}
}

impl fmt::Display for Finding {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let (row, column) = self.position();
		let hundredths = match self {
			Self::Illegible { ratio_hundredths, .. }
			| Self::InvisibleFill { ratio_hundredths, .. } => *ratio_hundredths,
		};
		write!(
			f,
			"{} at {row},{column} (ratio {}.{:02})",
			self.kind(),
			hundredths / 100,
			hundredths % 100
		)
	}
}

/// A contrast ratio as hundredths, so a finding compares and prints exactly.
///
/// Findings are put in sets, diffed between grounds and rendered into reports.
/// A float in that position makes two runs of the same grid produce findings
/// that are equal in every way a reader can see and unequal to the program.
fn hundredths(ratio: f64) -> u32 {
	// Ratios live in 1.0..=21.0, so this cannot overflow; the saturating
	// conversion is here so a NaN from a future change becomes 0 rather than
	// undefined behaviour.
	let scaled = (ratio * 100.0).round();
	if scaled.is_finite() && scaled >= 0.0 {
		scaled.min(f64::from(u32::MAX)) as u32
	} else {
		0
	}
}

/// Findings for one grid on one ground.
#[must_use]
pub fn inspect(grid: &[Vec<Cell>], ground: Ground) -> Vec<Finding> {
	let mut findings = Vec::new();
	for (row, cells) in grid.iter().enumerate() {
		for (column, cell) in cells.iter().enumerate() {
			let resolved = resolve(cell, ground);
			if resolved.explicit_bg {
				let against_ground = contrast::ratio(resolved.bg, ground.rgb());
				if against_ground < contrast::FILL_RATIO {
					findings.push(Finding::InvisibleFill {
						row,
						column,
						ratio_hundredths: hundredths(against_ground),
					});
				}
			}
			// A blank cell has no glyph to read, and a continuation cell's
			// glyph belongs to the column before it.
			if cell.is_continuation || cell.content.is_empty() {
				continue;
			}
			let glyph = resolved.glyph_ratio();
			if glyph < contrast::TEXT_RATIO {
				findings.push(Finding::Illegible { row, column, ratio_hundredths: hundredths(glyph) });
			}
		}
	}
	findings
}

/// One grid, inspected on both grounds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DualGround {
	pub per_ground: BTreeMap<&'static str, Vec<Finding>>,
}

impl DualGround {
	#[must_use]
	pub fn inspect(grid: &[Vec<Cell>]) -> Self {
		let per_ground = Ground::all()
			.into_iter()
			.map(|ground| (ground.as_str(), inspect(grid, ground)))
			.collect();
		Self { per_ground }
	}

	#[must_use]
	pub fn findings(&self, ground: Ground) -> &[Finding] {
		self
			.per_ground
			.get(ground.as_str())
			.map_or(&[], Vec::as_slice)
	}

	/// Findings that appear on one ground and not the other, with the ground
	/// they appear on.
	///
	/// This is the output that justifies the module. A defect present on both
	/// grounds is one any operator can see; a defect present on one is the one
	/// that survives review, ships, and is then reported by somebody whose
	/// terminal is configured differently.
	#[must_use]
	pub fn ground_dependent(&self) -> Vec<(Ground, Finding)> {
		let mut only = Vec::new();
		for ground in Ground::all() {
			let other = match ground {
				Ground::Grey => Ground::Black,
				Ground::Black => Ground::Grey,
			};
			let elsewhere = self.findings(other);
			for finding in self.findings(ground) {
				// Position and kind, not ratio: the same defect has different
				// ratios on two different grounds, which is the whole reason it
				// is ground-dependent.
				let shared = elsewhere
					.iter()
					.any(|seen| seen.position() == finding.position() && seen.kind() == finding.kind());
				if !shared {
					only.push((ground, *finding));
				}
			}
		}
		only
	}

	/// True when neither ground has a finding.
	#[must_use]
	pub fn is_clean(&self) -> bool {
		self.per_ground.values().all(Vec::is_empty)
	}
}
