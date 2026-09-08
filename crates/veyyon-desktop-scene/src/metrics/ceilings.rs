//! Surface class clutter ceiling definitions and compliance checking.
//!
//! WHY CEILINGS ARE PER-SURFACE: §6.6 and §9.6 define clutter as the
//! accumulation of small per-surface chrome additions. A whole-window ceiling
//! alone would allow forty surfaces to each add one unnecessary border or gap
//! before failing. Asserting tight per-surface ceilings at the scene gate
//! prevents drift.
//!
//! WHERE THE NUMBERS COME FROM: `ceilings.toml`, through the strict loader,
//! and nowhere else. §9.3 compiles no visual value in, and a second copy of
//! the table here would pass its own test while the running app checked the
//! other one. `SurfaceClass::of` is the whole mapping from a §6.6 row to the
//! block the loader parsed, so a class added to the table without a block
//! fails to compile.

use std::fmt;

use veyyon_desktop_tokens::{CeilingTokens, SurfaceCeilings};

/// The eight surface classes defined in §6.6 with authoritative ink ceilings.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum SurfaceClass {
	QueueRowCard,
	QueueRowLine,
	TranscriptTurn,
	BlockChrome,
	Composer,
	RightPanelChrome,
	TerminalDrawerChrome,
	WholeWindow,
}

impl SurfaceClass {
	/// All surface class variants in §6.6 table order.
	pub const ALL: [Self; 8] = [
		Self::QueueRowCard,
		Self::QueueRowLine,
		Self::TranscriptTurn,
		Self::BlockChrome,
		Self::Composer,
		Self::RightPanelChrome,
		Self::TerminalDrawerChrome,
		Self::WholeWindow,
	];

	pub const fn name(&self) -> &'static str {
		match self {
			Self::QueueRowCard => "queue row (card)",
			Self::QueueRowLine => "queue row (line)",
			Self::TranscriptTurn => "transcript turn",
			Self::BlockChrome => "block chrome",
			Self::Composer => "composer",
			Self::RightPanelChrome => "right panel chrome",
			Self::TerminalDrawerChrome => "terminal drawer chrome",
			Self::WholeWindow => "whole window",
		}
	}

	/// The block of `ceilings.toml` this class is judged against.
	///
	/// Total over the enum on purpose: a §6.6 row added here without a block
	/// in the token file fails to compile, rather than borrowing another
	/// row's numbers.
	pub const fn of(self, tokens: &CeilingTokens) -> &SurfaceCeilings {
		match self {
			Self::QueueRowCard => &tokens.queue_card,
			Self::QueueRowLine => &tokens.queue_line,
			Self::TranscriptTurn => &tokens.transcript_turn,
			Self::BlockChrome => &tokens.block_chrome,
			Self::Composer => &tokens.composer,
			Self::RightPanelChrome => &tokens.right_panel_chrome,
			Self::TerminalDrawerChrome => &tokens.terminal_drawer_chrome,
			Self::WholeWindow => &tokens.whole_window,
		}
	}
}

/// Hard ceilings defined per surface class.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Ceilings {
	pub edges:         f32,
	pub distinct_gaps: usize,
	pub text_sizes:    usize,
	pub interactive:   usize,
}

/// The ceilings `tokens` authors for this surface class.
#[must_use]
pub const fn ceilings(surface: SurfaceClass, tokens: &CeilingTokens) -> Ceilings {
	let authored = surface.of(tokens);
	Ceilings {
		edges:         authored.edges as f32,
		distinct_gaps: authored.distinct_gaps,
		text_sizes:    authored.text_sizes,
		interactive:   authored.interactive_elements,
	}
}

/// The interactive elements a sample box may hold, in the unit
/// [`element_density_of_centers`] returns: controls per sample box, not per
/// 1000px².
///
/// `ceilings.toml` authors the rate and the box edge separately, because the
/// rate is the judgement and the box is the window it is judged over. A
/// 100px box at 2.08 per 1000px² is 20.8 controls.
///
/// [`element_density_of_centers`]: super::element_density_of_centers
#[must_use]
pub fn density_ceiling(tokens: &CeilingTokens) -> f32 {
	let box_area = tokens.density_region.sample_box_px * tokens.density_region.sample_box_px;
	tokens.density_region.max_interactive_per_1000px2 * box_area / 1000.0
}

/// A single metric ceiling breach.
#[derive(Clone, Debug, PartialEq)]
pub struct MetricBreach {
	pub metric:  &'static str,
	pub ceiling: f64,
	pub actual:  f64,
}

/// Gate verdict comparing computed clutter metrics against surface ceilings.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
	pub surface:  SurfaceClass,
	pub breaches: Vec<MetricBreach>,
}

impl Verdict {
	/// True when all metrics are within their respective ceilings.
	pub const fn passed(&self) -> bool {
		self.breaches.is_empty()
	}

	/// List of ceiling breaches.
	pub const fn breaches(&self) -> &[MetricBreach] {
		self.breaches.as_slice()
	}
}

impl fmt::Display for Verdict {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		if self.breaches.is_empty() {
			write!(f, "{}: passed", self.surface.name())
		} else {
			for (i, b) in self.breaches.iter().enumerate() {
				if i > 0 {
					writeln!(f)?;
				}
				write!(
					f,
					"{}: breach on {}: measured {} exceeds ceiling {}",
					self.surface.name(),
					b.metric,
					b.actual,
					b.ceiling
				)?;
			}
			Ok(())
		}
	}
}

/// Checks a measurement against the ceilings `tokens` authors for `surface`.
///
/// Every column of the §6.6 row is checked. The interactive count is one of
/// them: a ceiling nothing consults is a number in a file, and the row that
/// caps the whole window at 105 controls was exactly that until this read it.
#[must_use]
pub fn check(measured: &super::Measured, surface: SurfaceClass, tokens: &CeilingTokens) -> Verdict {
	let c = ceilings(surface, tokens);
	let metrics = &measured.metrics;
	let mut breaches = Vec::new();

	if metrics.distinct_gaps > c.distinct_gaps {
		breaches.push(MetricBreach {
			metric:  "distinct_gaps",
			ceiling: c.distinct_gaps as f64,
			actual:  metrics.distinct_gaps as f64,
		});
	}

	if metrics.distinct_text_sizes > c.text_sizes {
		breaches.push(MetricBreach {
			metric:  "distinct_text_sizes",
			ceiling: c.text_sizes as f64,
			actual:  metrics.distinct_text_sizes as f64,
		});
	}

	if metrics.edge_count > c.edges {
		breaches.push(MetricBreach {
			metric:  "edge_count",
			ceiling: c.edges as f64,
			actual:  metrics.edge_count as f64,
		});
	}

	if measured.interactive > c.interactive {
		breaches.push(MetricBreach {
			metric:  "interactive_elements",
			ceiling: c.interactive as f64,
			actual:  measured.interactive as f64,
		});
	}

	let density = density_ceiling(tokens);
	if metrics.element_density > density {
		breaches.push(MetricBreach {
			metric:  "element_density",
			ceiling: f64::from(density),
			actual:  f64::from(metrics.element_density),
		});
	}

	Verdict { surface, breaches }
}
