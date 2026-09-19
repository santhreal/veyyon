//! WHY: Measures in `surface.transcript` were defined in toml tokens but left
//! unwired or unrendered in transcript blocks and clamps, allowing dead tokens
//! to accumulate silently.
//!
//! THE CLASS THIS CLOSES: Token measures defined in surface toml files that
//! are never read or whose variation does not produce raster changes in any
//! rendered frame. The sweep enumerates all numeric measures in the group at
//! run time and ensures mutating each one produces an observable visual delta.
//!
//! WHAT IT DOES NOT CATCH: Non-numeric token values such as colors and fonts,
//! and dynamic runtime layout adjustments caused by external window resizes.

mod dead_token_probe;
mod transcript_probe;

use dead_token_probe::assert_every_measure_is_drawn;

#[test]
fn a_transcript_measure_reaches_the_raster() {
	assert_every_measure_is_drawn("surface.transcript", transcript_probe::observations);
}
