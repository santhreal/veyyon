//! WHY: a token file states the product's measures, and the loader already
//! rejects an entry nobody parses. Nothing rejected the next failure along: an
//! entry the loader parses, the struct carries and no renderer ever draws.
//! Measures in surface/panels.toml control the right panel, terminal drawer,
//! process list, tabs, tree view and diff view, but without rendering their
//! specific states, an inert measure could ship unnoticed.
//!
//! THE CLASS THIS CLOSES: a panel or drawer measure that is authored, loaded,
//! and never reaches the raster. Every numeric measure of `surface.panels` is
//! enumerated from the loaded tokens at run time through serde and bumped one
//! at a time against states exercising the panel and drawer surfaces. A measure
//! that changes no rasterized observation fails by name.
//!
//! WHAT IT DOES NOT CATCH: a measure whose only observable effect is a colour,
//! since the probe reads geometry; the colour roles are swept by
//! `a-colour-role-no-frame-inks-is-a-dead-role.rs`.

mod dead_token_probe;
mod panels_probe;

use dead_token_probe::assert_every_measure_is_drawn_except;

const EXEMPT: &[(&str, &str)] = &[];

#[test]
fn every_panel_measure_reaches_the_raster() {
	assert_every_measure_is_drawn_except("surface.panels", panels_probe::observations, EXEMPT);
}
