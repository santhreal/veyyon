//! WHY: the dead-token sweep is split across suites, one per group of
//! measures, because a palette measure is invisible until the palette is open
//! and re-rendering the whole window once per key is not free. A split sweep
//! has a failure a single one does not: a measure that belongs to no suite is
//! swept by nothing, and the suites all pass while it is dead.
//!
//! THE CLASS THIS CLOSES: an authored measure outside every suite's reach. The
//! key list comes from serde over the loaded token value, so a new field, a
//! new table and a new token file all arrive here, and one that no registered
//! group claims fails by name. A group that claims nothing fails too, which is
//! what a renamed table leaves behind.
//!
//! WHAT IT DOES NOT CATCH: whether the suite that claims a group actually
//! renders a state that draws it. That is each group suite's own assertion.

mod dead_token_probe;

use dead_token_probe::{GROUPS, all_keys, group_of, keys_in};
use veyyon_desktop_tokens::load_bundled_tokens;

#[test]
fn every_authored_measure_is_claimed_by_one_group() {
	let tokens = load_bundled_tokens().expect("the bundled tokens must load");
	let unclaimed: Vec<String> = all_keys(&tokens)
		.into_iter()
		.filter(|key| group_of(key).is_none())
		.collect();
	assert!(
		unclaimed.is_empty(),
		"these measures belong to no sweep, so nothing would notice them going dead: {unclaimed:?}"
	);
}

#[test]
fn every_group_claims_a_measure() {
	let tokens = load_bundled_tokens().expect("the bundled tokens must load");
	let empty: Vec<&&str> = GROUPS
		.iter()
		.filter(|group| keys_in(group, &tokens).is_empty())
		.collect();
	assert!(
		empty.is_empty(),
		"these groups claim no measure, so their suites sweep nothing: {empty:?}"
	);
}
