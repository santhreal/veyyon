//! Dimension sweeps: the two ways a family chooses which combinations to emit.
//!
//! A case occupies a point in a space of normalized dimensions. Two axes that
//! interact — a terminal signal and an output completeness, a transport fault
//! and a retry policy — have to be multiplied out, because the bug lives in the
//! combination. Axes that do not interact would multiply the corpus by their
//! product for no coverage, so those get a pairwise covering array: every pair
//! of values from every pair of axes appears in at least one row, at a fraction
//! of the rows.
//!
//! Both functions are deterministic. [`exhaustive`] has nothing to choose;
//! [`pairwise`] resolves its ties from a seeded [`Rng`], so a seed names one
//! array forever and a committed corpus does not move when someone runs the
//! generator again.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail};

use crate::rng::Rng;

/// One dimension and the normalized values it takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Axis {
	name:   String,
	values: Vec<String>,
}

impl Axis {
	/// An axis, or a refusal.
	///
	/// An axis with no values is refused rather than skipped: a sweep that
	/// quietly drops an axis produces a smaller corpus that still passes every
	/// count check, which is the drift the manifest exists to catch.
	pub fn new<N, V>(name: N, values: V) -> Result<Self>
	where
		N: Into<String>,
		V: IntoIterator,
		V::Item: Into<String>,
	{
		let name = name.into();
		let values: Vec<String> = values.into_iter().map(Into::into).collect();
		if values.is_empty() {
			bail!("axis {name} has no values");
		}
		let unique: BTreeSet<&String> = values.iter().collect();
		if unique.len() != values.len() {
			bail!("axis {name} repeats a value");
		}
		Ok(Self { name, values })
	}

	#[must_use]
	pub fn name(&self) -> &str {
		&self.name
	}

	#[must_use]
	pub fn values(&self) -> &[String] {
		&self.values
	}
}

/// One point in the dimension space, keyed by axis name.
///
/// A `BTreeMap` because it becomes `ConformanceCase::dimensions`, whose
/// serialized form is part of the case id: an insertion-ordered map would give
/// one case two ids depending on which axis a family filled first.
pub type Row = BTreeMap<String, String>;

/// Every combination, in axis order.
pub fn exhaustive(axes: &[Axis]) -> Result<Vec<Row>> {
	if axes.is_empty() {
		bail!("a sweep over no axes has no combinations");
	}
	let mut rows = vec![Row::new()];
	for axis in axes {
		let mut grown = Vec::with_capacity(rows.len() * axis.values.len());
		for row in &rows {
			for value in &axis.values {
				let mut next = row.clone();
				next.insert(axis.name.clone(), value.clone());
				grown.push(next);
			}
		}
		rows = grown;
	}
	Ok(rows)
}

/// A pairwise covering array over `axes`.
///
/// The contract is coverage, not size: every value pair from every axis pair
/// appears at least once. The greedy construction below is not minimal, and a
/// minimal array is not what the corpus needs — a reproducible one is.
///
/// With fewer than two axes there are no pairs, so this is [`exhaustive`]: one
/// row per value, which is what "cover everything" means for a single axis.
pub fn pairwise(axes: &[Axis], rng: &mut Rng) -> Result<Vec<Row>> {
	if axes.len() < 2 {
		return exhaustive(axes);
	}
	// (axis a, value index a, axis b, value index b) for a < b. A set, so the
	// loop below can remove what a row covers and terminate on empty.
	let mut uncovered: BTreeSet<(usize, usize, usize, usize)> = BTreeSet::new();
	for a in 0..axes.len() {
		for b in a + 1..axes.len() {
			for va in 0..axes[a].values.len() {
				for vb in 0..axes[b].values.len() {
					uncovered.insert((a, va, b, vb));
				}
			}
		}
	}

	let mut rows = Vec::new();
	while let Some(&(seed_a, seed_va, seed_b, seed_vb)) = uncovered.iter().next() {
		// Seed the row with one uncovered pair, so every iteration covers at
		// least that pair and the loop cannot spin.
		let mut chosen: Vec<Option<usize>> = vec![None; axes.len()];
		chosen[seed_a] = Some(seed_va);
		chosen[seed_b] = Some(seed_vb);

		for (index, axis) in axes.iter().enumerate() {
			if chosen[index].is_some() {
				continue;
			}
			chosen[index] = Some(best_value(index, axis, &chosen, &uncovered, rng));
		}

		let picked: Vec<usize> = chosen
			.iter()
			.map(|value| value.expect("every axis was filled above"))
			.collect();
		for a in 0..axes.len() {
			for b in a + 1..axes.len() {
				uncovered.remove(&(a, picked[a], b, picked[b]));
			}
		}
		rows.push(
			axes
				.iter()
				.zip(&picked)
				.map(|(axis, &value)| (axis.name.clone(), axis.values[value].clone()))
				.collect(),
		);
	}
	Ok(rows)
}

/// The value of `axis` covering the most still-uncovered pairs against the axes
/// already fixed in this row. Ties are broken from the seeded stream rather
/// than by taking the first, so the array does not depend on axis declaration
/// order alone.
fn best_value(
	index: usize,
	axis: &Axis,
	chosen: &[Option<usize>],
	uncovered: &BTreeSet<(usize, usize, usize, usize)>,
	rng: &mut Rng,
) -> usize {
	let mut best_gain: Option<usize> = None;
	let mut best: Vec<usize> = Vec::new();
	for candidate in 0..axis.values.len() {
		let mut gain = 0;
		for (other, fixed) in chosen.iter().enumerate() {
			let Some(other_value) = *fixed else { continue };
			// The pair key is ordered by axis index, so a pair is stored once
			// and `contains` cannot miss it by looking under the mirror.
			let key = if other < index {
				(other, other_value, index, candidate)
			} else {
				(index, candidate, other, other_value)
			};
			if uncovered.contains(&key) {
				gain += 1;
			}
		}
		match best_gain {
			Some(current) if gain < current => {},
			Some(current) if gain == current => best.push(candidate),
			_ => {
				best_gain = Some(gain);
				best.clear();
				best.push(candidate);
			},
		}
	}
	rng.pick(&best).copied().unwrap_or(0)
}
