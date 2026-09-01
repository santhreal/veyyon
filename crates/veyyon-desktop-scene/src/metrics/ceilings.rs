//! Surface class clutter ceiling definitions and compliance checking.
//!
//! WHY CEILINGS ARE PER-SURFACE: §6.6 and §9.6 define clutter as the
//! accumulation of small per-surface chrome additions. A whole-window ceiling
//! alone would allow forty surfaces to each add one unnecessary border or gap
//! before failing. Asserting tight per-surface ceilings at the scene gate
//! prevents drift.

use std::fmt;

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
}

/// Hard ceilings defined per surface class.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Ceilings {
	pub edges:         f32,
	pub distinct_gaps: usize,
	pub text_sizes:    usize,
	pub interactive:   usize,
}

/// Authoritative §6.6 ceiling limits for each surface class.
pub const fn ceilings(surface: SurfaceClass) -> Ceilings {
	match surface {
		SurfaceClass::QueueRowCard => {
			Ceilings { edges: 2.0, distinct_gaps: 3, text_sizes: 3, interactive: 3 }
		},
		SurfaceClass::QueueRowLine => {
			Ceilings { edges: 1.0, distinct_gaps: 2, text_sizes: 2, interactive: 2 }
		},
		SurfaceClass::TranscriptTurn => {
			Ceilings { edges: 1.0, distinct_gaps: 3, text_sizes: 3, interactive: 4 }
		},
		SurfaceClass::BlockChrome => {
			Ceilings { edges: 1.0, distinct_gaps: 2, text_sizes: 2, interactive: 2 }
		},
		SurfaceClass::Composer => {
			Ceilings { edges: 3.0, distinct_gaps: 4, text_sizes: 3, interactive: 8 }
		},
		SurfaceClass::RightPanelChrome => {
			Ceilings { edges: 2.0, distinct_gaps: 3, text_sizes: 3, interactive: 6 }
		},
		SurfaceClass::TerminalDrawerChrome => {
			Ceilings { edges: 2.0, distinct_gaps: 2, text_sizes: 2, interactive: 5 }
		},
		SurfaceClass::WholeWindow => {
			Ceilings { edges: 16.0, distinct_gaps: 8, text_sizes: 6, interactive: 105 }
		},
	}
}

/// Maximum interactive element density across any 100x100px region (§6.6 /
/// §8.31).
///
/// Restated from 2.08 interactive elements per 1000px² into elements per
/// 100x100px window (10,000px² = 10 × 1000px²), which is the exact unit
/// `compute_element_density` returns (2.08 × 10 = 20.8).
pub const DENSEST_REGION_CEILING: f32 = 20.8;

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

/// Check metrics against the authoritative ceilings for a surface class.
pub fn check(metrics: &super::ClutterMetrics, surface: SurfaceClass) -> Verdict {
	let c = ceilings(surface);
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

	if metrics.element_density > DENSEST_REGION_CEILING {
		breaches.push(MetricBreach {
			metric:  "element_density",
			ceiling: DENSEST_REGION_CEILING as f64,
			actual:  metrics.element_density as f64,
		});
	}

	Verdict { surface, breaches }
}
