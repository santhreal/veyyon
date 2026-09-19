//! WHY: a token file states the product's measures, and the loader rejects
//! an entry nobody parses. Nothing rejected the next failure along: an entry
//! the loader parses, the struct carries and no renderer ever draws. Seventeen
//! measures in `surface.composer` and six in `surface.attached_cards` were dead
//! because nothing rendered the states that drew them, or because a renderer
//! drew compiled-in defaults beside the token.
//!
//! THE CLASS THIS CLOSES: a measure that is authored, loaded and never reaches
//! the raster. This suite sweeps `surface.composer` and
//! `surface.attached_cards`, enumerated from the loaded token value at run time
//! through serde, doubled one at a time against a probe rendering the states
//! that draw them. A field that moves no pixel fails by name, and a field added
//! to either struct arrives in the sweep with no edit here.
//!
//! WHAT IT DOES NOT CATCH: a measure drawn in the wrong place. A frame that
//! differs proves the value reached the raster, not that it landed where the
//! design system puts it, which is what the proof frames on the pull request
//! are read for. Other surface groups are swept by their own suites.

mod composer_probe;
mod dead_token_probe;

use dead_token_probe::assert_every_measure_is_drawn;

#[test]
fn every_composer_measure_reaches_the_raster() {
	assert_every_measure_is_drawn("surface.composer", composer_probe::observations);
}

#[test]
fn every_attached_card_measure_reaches_the_raster() {
	assert_every_measure_is_drawn("surface.attached_cards", composer_probe::observations);
}
