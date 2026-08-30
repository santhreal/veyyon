//! Delta debugging: turning a failing case into the smallest one that still
//! fails.
//!
//! A generated failure arrives as a sequence of a few hundred stimuli against a
//! filesystem tree of a few hundred files, and none of that is a bug report.
//! The reduction below is the classic `ddmin`: remove a chunk, ask whether the
//! failure survives, keep the reduction if it does, and halve the chunk size
//! when nothing can be removed at the current granularity. What comes out is
//! 1-minimal — no single element can be dropped without the failure going away.
//!
//! Three properties matter more than the size of the result, and each is
//! asserted rather than assumed:
//!
//! - **It terminates, within a stated budget.** Every reduction is a strict
//!   shrink and every candidate costs one execution, so the work is bounded;
//!   the budget makes that bound explicit and reports exhaustion instead of
//!   quietly returning a half-reduced input.
//! - **It never hands back something that passes.** A reduction that loses the
//!   failure is a reproduction nobody can use, and it is worse than no
//!   reduction, because it looks like a fixed bug.
//! - **It says when the input never failed at all.** A flaky case reduces to
//!   nothing and would otherwise be reported as a one-element reproduction of a
//!   failure that was never there.
//!
//! `Hierarchical` in the design document means the layers are reduced in turn —
//! the stimulus sequence, then the environment sizes, then the filesystem tree
//! — and each layer is this same function over a different element type.

#[cfg(test)]
mod tests;

/// How much execution a reduction may spend.
///
/// A candidate is one execution of the case under test, which for a
/// compiled-product case is a process launch. Reduction that costs more than
/// the engineer's patience is reduction nobody runs, so the ceiling is explicit
/// and the report says when it was hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
	pub max_candidates: usize,
}

impl Budget {
	/// The default ceiling. `ddmin` over a sequence of length `n` costs
	/// `O(n^2)` candidates in the worst case, so this is roughly a 60-element
	/// sequence reduced exhaustively, or a much longer one that reduces early.
	pub const DEFAULT: Self = Self { max_candidates: 4_000 };
}

impl Default for Budget {
	fn default() -> Self {
		Self::DEFAULT
	}
}

/// How a reduction ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
	/// No single element can be removed without losing the failure.
	Minimal,
	/// The budget ran out first. The result still fails, and it is not known to
	/// be minimal.
	BudgetExhausted,
	/// The input handed in did not fail, so there was nothing to reduce. Never
	/// reported as a reduction: the input comes back exactly as it arrived.
	NotReproducible,
}

/// One accepted reduction, for the trace a failure bundle carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
	/// The chunk count the reduction was found at: 2 halves the input, and a
	/// granularity equal to the remaining length is single-element removal.
	pub granularity: usize,
	pub removed:     usize,
	pub remaining:   usize,
}

/// What a reduction did, in enough detail to answer why it stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trace {
	pub outcome:    Outcome,
	/// Executions spent, including the first one that confirms the failure.
	pub candidates: usize,
	pub original:   usize,
	pub minimized:  usize,
	pub steps:      Vec<Step>,
}

impl Trace {
	/// Elements removed. Zero is a legitimate answer: some failures need every
	/// element they arrived with.
	#[must_use]
	pub const fn removed(&self) -> usize {
		self.original - self.minimized
	}
}

/// A reduced input and the trace that produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shrunk<T> {
	pub items: Vec<T>,
	pub trace: Trace,
}

/// Reduce `input` to a 1-minimal subsequence that still fails.
///
/// `still_fails` executes the case for a candidate subsequence and answers
/// whether the original failure is still there. It is called with the full
/// input first: a predicate that does not fail on its own input has nothing to
/// reduce, and reducing anyway would invent a reproduction.
pub fn ddmin<T, F>(input: &[T], budget: Budget, mut still_fails: F) -> Shrunk<T>
where
	T: Clone,
	F: FnMut(&[T]) -> bool,
{
	let mut spent = 0;
	let mut steps = Vec::new();
	let original = input.len();

	if !spend(&mut spent, budget) || !still_fails(input) {
		return Shrunk {
			items: input.to_vec(),
			trace: Trace {
				outcome: Outcome::NotReproducible,
				candidates: spent,
				original,
				minimized: original,
				steps,
			},
		};
	}

	let mut current = input.to_vec();
	let mut granularity = 2;
	// Every iteration either shrinks `current` or increases `granularity`
	// toward `current.len()`, and the loop leaves once granularity reaches the
	// length with nothing removed. Both quantities are monotone, so this ends.
	// A single remaining element is still reducible: the failure may need none
	// of them, and stopping at one would report a reproduction that is one
	// element larger than the truth.
	while !current.is_empty() {
		let chunks = granularity.min(current.len());
		let mut reduced = false;
		for index in 0..chunks {
			let candidate = without_chunk(&current, index, chunks);
			if candidate.len() == current.len() {
				continue;
			}
			if !spend(&mut spent, budget) {
				return Shrunk {
					items: current.clone(),
					trace: Trace {
						outcome: Outcome::BudgetExhausted,
						candidates: spent,
						original,
						minimized: current.len(),
						steps,
					},
				};
			}
			if still_fails(&candidate) {
				steps.push(Step {
					granularity: chunks,
					removed:     current.len() - candidate.len(),
					remaining:   candidate.len(),
				});
				current = candidate;
				// Back off the granularity: the chunks are recomputed over a
				// shorter input, and starting coarse again is what makes the
				// common case cheap.
				granularity = 2.max(chunks.saturating_sub(1));
				reduced = true;
				break;
			}
		}
		if reduced {
			continue;
		}
		if chunks >= current.len() {
			// Nothing can be removed one element at a time, which is what
			// 1-minimal means.
			break;
		}
		granularity = (chunks * 2).min(current.len());
	}

	let minimized = current.len();
	Shrunk {
		items: current,
		trace: Trace { outcome: Outcome::Minimal, candidates: spent, original, minimized, steps },
	}
}

/// The smallest size the halving search can confirm still fails.
///
/// Sizes are their own layer because a failing case usually needs a big
/// something — a 64 KiB payload, a thousand-row board — and reducing the
/// sequence around it leaves the size untouched. The search halves while the
/// failure survives, then walks back up to the boundary.
///
/// It assumes nothing about monotonicity and claims nothing it did not observe:
/// the answer is a size that fails whose predecessor in the search did not. A
/// predicate that fails at 10 and at 1000 but not at 100 can hide a smaller
/// failing size from this, and that is a property of non-monotone predicates
/// rather than a defect here.
pub fn shrink_size<F>(failing: u64, budget: Budget, mut still_fails: F) -> (u64, Trace)
where
	F: FnMut(u64) -> bool,
{
	let mut spent = 0;
	let mut steps = Vec::new();
	let original = usize::try_from(failing).unwrap_or(usize::MAX);

	if !spend(&mut spent, budget) || !still_fails(failing) {
		return (failing, Trace {
			outcome: Outcome::NotReproducible,
			candidates: spent,
			original,
			minimized: original,
			steps,
		});
	}

	let mut smallest = failing;
	let mut outcome = Outcome::Minimal;
	while smallest > 0 {
		let candidate = smallest / 2;
		if !spend(&mut spent, budget) {
			outcome = Outcome::BudgetExhausted;
			break;
		}
		if !still_fails(candidate) {
			break;
		}
		steps.push(Step {
			granularity: 2,
			removed:     usize::try_from(smallest - candidate).unwrap_or(usize::MAX),
			remaining:   usize::try_from(candidate).unwrap_or(usize::MAX),
		});
		smallest = candidate;
	}

	let minimized = usize::try_from(smallest).unwrap_or(usize::MAX);
	(smallest, Trace { outcome, candidates: spent, original, minimized, steps })
}

/// `input` without the `index`-th of `chunks` roughly equal chunks.
fn without_chunk<T: Clone>(input: &[T], index: usize, chunks: usize) -> Vec<T> {
	let length = input.len();
	// Chunk boundaries by multiplication rather than by a running size, so the
	// remainder is spread instead of landing entirely in the last chunk.
	let start = index * length / chunks;
	let end = (index + 1) * length / chunks;
	let mut kept = Vec::with_capacity(length - (end - start));
	kept.extend_from_slice(&input[..start]);
	kept.extend_from_slice(&input[end..]);
	kept
}

/// Charge one execution, or report that the budget is gone.
const fn spend(spent: &mut usize, budget: Budget) -> bool {
	if *spent >= budget.max_candidates {
		return false;
	}
	*spent += 1;
	true
}
