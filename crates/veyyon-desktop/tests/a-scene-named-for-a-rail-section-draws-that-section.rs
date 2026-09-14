//! WHY: `queue-section/unsent` seeded the draft into the session that was on
//! screen, and a draft in the session being typed in is never lifted (§0), so
//! the scene named for the section built a rail without it. The catalogue was
//! green throughout: the frame differed from every other scene's because it
//! held a second session, and nothing read which sections it drew.
//!
//! CLASS CLOSED: a required scene whose seeded store does not reach the state
//! the scene is named for, across every section the rail draws. The subjects
//! come from `required_states()` and `Section::all()` at run time, and the two
//! name sets are asserted equal, so a section added to the rail, a section
//! dropped from the catalogue, or a scene renamed on one side alone fails here
//! until someone records the decision. A multi-word section fails the name
//! comparison rather than passing quietly, because the catalogue kebab-cases
//! and this suite lower-cases: that is the intended stop, not a gap.
//!
//! NOT CAUGHT: whether the section's header and rows are inked, which the
//! surface crate's pixel suites own; and the fidelity of every required state
//! that is not named after a projected section.

use std::collections::BTreeSet;

use veyyon_desktop::scene::{SceneRoot, build};
use veyyon_desktop_scene::{
	FixtureSelection, RequiredState, Scene, StateDescriptor, required_states,
};
use veyyon_desktop_surface::Section;

/// The surface every rail-section scene is filed under.
const SURFACE: &str = "queue-section";

/// The scene the catalogue requires for `state`, as the registry builds it.
fn scene_of(state: RequiredState) -> Scene {
	Scene {
		name:              state.scene_name(),
		surface:           state.surface().to_string(),
		state:             StateDescriptor::Required(state),
		fixture_selection: FixtureSelection::Typical,
	}
}

/// Every rail-section state the catalogue requires, with the scene name it is
/// filed under.
fn required_sections() -> Vec<(String, RequiredState)> {
	required_states()
		.into_iter()
		.filter(|state| state.surface() == SURFACE)
		.map(|state| (state.scene_name(), state))
		.collect()
}

/// The scene name a section of the rail is filed under.
fn scene_name_of(section: Section) -> String {
	format!("{SURFACE}/{}", format!("{section:?}").to_lowercase())
}

#[test]
fn every_section_the_rail_draws_is_one_the_catalogue_requires_a_scene_of() {
	let required: BTreeSet<String> = required_sections()
		.into_iter()
		.map(|(name, _)| name)
		.collect();
	let drawn: BTreeSet<String> = Section::all().into_iter().map(scene_name_of).collect();
	assert_eq!(
		required, drawn,
		"every rail section needs a required scene and every rail-section scene needs a section"
	);
}

#[test]
fn a_scene_named_for_a_section_seeds_a_store_that_draws_it() {
	for (name, state) in required_sections() {
		let section = Section::all()
			.into_iter()
			.find(|section| scene_name_of(*section) == name)
			.unwrap_or_else(|| panic!("{name} names no section the rail draws"));
		let built = match build(&scene_of(state)) {
			Ok(SceneRoot::Shell(built)) => built,
			Ok(SceneRoot::Primitive(kind)) => panic!("{name} built a {kind:?} instead of a shell"),
			Err(error) => panic!("{name} failed to build: {error}"),
		};
		let drawn: Vec<Section> = built
			.state
			.sections
			.iter()
			.map(|(section, _)| *section)
			.collect();
		assert!(drawn.contains(&section), "{name} drew {drawn:?}, which does not hold {section:?}");
		let rows = built
			.state
			.sections
			.iter()
			.find(|(drawn, _)| *drawn == section)
			.map_or(0, |(_, rows)| rows.len());
		assert!(rows > 0, "{name} drew {section:?} with no rows in it");
	}
}
