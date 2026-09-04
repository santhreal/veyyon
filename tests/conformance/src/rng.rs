//! Deterministic pseudorandom source for case generation.
//!
//! A generator's output is part of a committed corpus, so the sequence a seed
//! produces has to be identical on every platform and in every future build.
//! That rules out `rand`'s thread and OS sources, and it also rules out
//! depending on `rand`'s default algorithm, which is free to change between
//! versions. `SplitMix64` is fully specified in eight lines, has no state
//! beyond a `u64`, and is the algorithm `rand` itself uses to seed other
//! generators.

/// A `SplitMix64` stream. Cloning it forks the stream at the current position,
/// which is what lets a generator hand a child dimension its own sub-stream
/// without the two interleaving.
#[derive(Debug, Clone)]
pub struct Rng {
	state: u64,
}

impl Rng {
	/// A stream from a seed. Seed 0 is fine: `SplitMix64` has no weak seeds.
	#[must_use]
	pub const fn new(seed: u64) -> Self {
		Self { state: seed }
	}

	/// The seed a named sub-stream starts from, so `Rng::for_label(seed,
	/// "framing")` is reproducible without threading a counter through every
	/// caller.
	#[must_use]
	pub fn for_label(seed: u64, label: &str) -> Self {
		let mut hasher = blake3::Hasher::new();
		hasher.update(&seed.to_le_bytes());
		hasher.update(label.as_bytes());
		let digest = hasher.finalize();
		let mut bytes = [0u8; 8];
		bytes.copy_from_slice(&digest.as_bytes()[..8]);
		Self::new(u64::from_le_bytes(bytes))
	}

	/// The next value in the stream.
	pub const fn next_u64(&mut self) -> u64 {
		self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
		let mut z = self.state;
		z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
		z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
		z ^ (z >> 31)
	}

	/// A value in `0..bound`, without modulo bias. `bound` of 0 answers 0.
	pub const fn below(&mut self, bound: u64) -> u64 {
		if bound == 0 {
			return 0;
		}
		// Lemire's rejection bound: discard the tail of the u64 range that would
		// make some residues more likely than others.
		let zone = u64::MAX - (u64::MAX % bound) - 1;
		loop {
			let value = self.next_u64();
			if value <= zone {
				return value % bound;
			}
		}
	}

	/// One element of `choices`, or `None` when it is empty.
	pub fn pick<'a, T>(&mut self, choices: &'a [T]) -> Option<&'a T> {
		if choices.is_empty() {
			return None;
		}
		let bound = u64::try_from(choices.len()).unwrap_or(u64::MAX);
		let index = usize::try_from(self.below(bound)).unwrap_or(0);
		choices.get(index)
	}
}

#[cfg(test)]
mod tests {
	use super::Rng;

	/// WHY: the corpus is committed, so a seed must name the same sequence
	/// forever. These are the first four values of `SplitMix64` from seed 0,
	/// which is the published reference vector for the algorithm.
	#[test]
	fn splitmix64_matches_its_reference_vector() {
		let mut rng = Rng::new(0);
		assert_eq!(rng.next_u64(), 0xe220_a839_7b1d_cdaf);
		assert_eq!(rng.next_u64(), 0x6e78_9e6a_a1b9_65f4);
		assert_eq!(rng.next_u64(), 0x06c4_5d18_8009_454f);
		assert_eq!(rng.next_u64(), 0xf88b_b8a8_724c_81ec);
	}

	#[test]
	fn a_labelled_substream_is_reproducible_and_distinct() {
		let a = Rng::for_label(7, "framing").next_u64();
		let again = Rng::for_label(7, "framing").next_u64();
		let other = Rng::for_label(7, "fault").next_u64();
		let other_seed = Rng::for_label(8, "framing").next_u64();
		assert_eq!(a, again);
		assert_ne!(a, other);
		assert_ne!(a, other_seed);
	}

	#[test]
	fn below_stays_in_range_and_zero_is_not_a_panic() {
		let mut rng = Rng::new(42);
		for _ in 0..1_000 {
			assert!(rng.below(7) < 7);
		}
		assert_eq!(rng.below(0), 0);
		assert_eq!(rng.below(1), 0);
	}

	#[test]
	fn pick_answers_none_for_an_empty_slice() {
		let mut rng = Rng::new(1);
		let empty: [u8; 0] = [];
		assert_eq!(rng.pick(&empty), None);
		assert!(rng.pick(&[9u8]).is_some_and(|value| *value == 9));
	}
}
