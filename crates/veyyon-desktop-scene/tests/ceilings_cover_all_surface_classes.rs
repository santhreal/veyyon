//! WHY THIS SUITE EXISTS: §6.6 gives each surface class one row of ceilings,
//! and the crate used to carry a second copy of that table as a `const fn`.
//! Two owners of one number means the gate can pass against the copy while the
//! app loads the other, and §9.3 compiles no visual value in at all.
//!
//! THE CLASS THIS CLOSES: a surface class that reaches no block of
//! `ceilings.toml`, two classes sharing one block, and a class added to the
//! enum without a decision about which row caps it.
//!
//! WHAT IT DOES NOT CATCH: whether the authored numbers are the right ones.
//! M7 retunes them, so this suite pins the wiring and not the values.

use veyyon_desktop_scene::metrics::{SurfaceClass, ceilings};
use veyyon_desktop_tokens::load_bundled_tokens;

#[test]
fn the_eight_classes_of_section_6_6_are_the_enum() {
	assert_eq!(SurfaceClass::ALL.len(), 8);
	let mut names: Vec<&str> = SurfaceClass::ALL.iter().map(|s| s.name()).collect();
	names.sort_unstable();
	names.dedup();
	assert_eq!(names.len(), 8, "each class states its own name");
}

#[test]
fn every_class_is_capped_by_a_block_of_its_own() {
	let tokens = load_bundled_tokens().expect("the bundled token set loads");
	let blocks: Vec<*const veyyon_desktop_tokens::SurfaceCeilings> = SurfaceClass::ALL
		.iter()
		.map(|surface| std::ptr::from_ref(surface.of(&tokens.ceilings)))
		.collect();

	for (index, block) in blocks.iter().enumerate() {
		for (other, second) in blocks.iter().enumerate().skip(index + 1) {
			assert!(
				!std::ptr::eq(*block, *second),
				"{} and {} are capped by the same block, so one of them is uncapped",
				SurfaceClass::ALL[index].name(),
				SurfaceClass::ALL[other].name()
			);
		}
	}
}

#[test]
fn every_class_resolves_the_numbers_its_own_block_authors() {
	let tokens = load_bundled_tokens().expect("the bundled token set loads");
	for surface in SurfaceClass::ALL {
		let authored = surface.of(&tokens.ceilings);
		let resolved = ceilings(surface, &tokens.ceilings);
		assert_eq!(resolved.distinct_gaps, authored.distinct_gaps, "{}", surface.name());
		assert_eq!(resolved.text_sizes, authored.text_sizes, "{}", surface.name());
		assert_eq!(resolved.interactive, authored.interactive_elements, "{}", surface.name());
		assert!((resolved.edges - authored.edges as f32).abs() < f32::EPSILON, "{}", surface.name());
		assert!(authored.edges > 0, "{} caps at least one edge", surface.name());
		assert!(authored.distinct_gaps > 0, "{} allows at least one gap", surface.name());
		assert!(authored.text_sizes > 0, "{} allows at least one size", surface.name());
	}
}

#[test]
fn a_class_added_to_the_enum_fails_to_compile_here_until_it_is_capped() {
	for surface in SurfaceClass::ALL {
		match surface {
			SurfaceClass::QueueRowCard
			| SurfaceClass::QueueRowLine
			| SurfaceClass::TranscriptTurn
			| SurfaceClass::BlockChrome
			| SurfaceClass::Composer
			| SurfaceClass::RightPanelChrome
			| SurfaceClass::TerminalDrawerChrome
			| SurfaceClass::WholeWindow => {},
		}
	}
}
