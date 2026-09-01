//! Contract test: ceiling definitions cover every surface class from §6.6
//! with exact numerical values and exhaustive variant coverage.

use veyyon_desktop_scene::metrics::{Ceilings, DENSEST_REGION_CEILING, SurfaceClass, ceilings};

#[test]
fn test_surface_class_all_matches_section_6_6_row_count() {
	// §6.6 defines exactly 8 surface classes
	assert_eq!(SurfaceClass::ALL.len(), 8);
}

#[test]
fn test_every_surface_class_has_authoritative_ceilings() {
	for surface in SurfaceClass::ALL {
		let c = ceilings(surface);
		assert!(c.edges > 0.0, "edges must be positive for {surface:?}");
		assert!(c.distinct_gaps > 0, "gaps must be positive for {surface:?}");
		assert!(c.text_sizes > 0, "text sizes must be positive for {surface:?}");
		assert!(c.interactive > 0, "interactive elements must be positive for {surface:?}");
	}
}

#[test]
fn test_exact_section_6_6_ceiling_numbers() {
	// Queue row (card)
	assert_eq!(ceilings(SurfaceClass::QueueRowCard), Ceilings {
		edges:         2.0,
		distinct_gaps: 3,
		text_sizes:    3,
		interactive:   3,
	});

	// Queue row (line)
	assert_eq!(ceilings(SurfaceClass::QueueRowLine), Ceilings {
		edges:         1.0,
		distinct_gaps: 2,
		text_sizes:    2,
		interactive:   2,
	});

	// Transcript turn
	assert_eq!(ceilings(SurfaceClass::TranscriptTurn), Ceilings {
		edges:         1.0,
		distinct_gaps: 3,
		text_sizes:    3,
		interactive:   4,
	});

	// Block chrome
	assert_eq!(ceilings(SurfaceClass::BlockChrome), Ceilings {
		edges:         1.0,
		distinct_gaps: 2,
		text_sizes:    2,
		interactive:   2,
	});

	// Composer
	assert_eq!(ceilings(SurfaceClass::Composer), Ceilings {
		edges:         3.0,
		distinct_gaps: 4,
		text_sizes:    3,
		interactive:   8,
	});

	// Right panel chrome
	assert_eq!(ceilings(SurfaceClass::RightPanelChrome), Ceilings {
		edges:         2.0,
		distinct_gaps: 3,
		text_sizes:    3,
		interactive:   6,
	});

	// Terminal drawer chrome
	assert_eq!(ceilings(SurfaceClass::TerminalDrawerChrome), Ceilings {
		edges:         2.0,
		distinct_gaps: 2,
		text_sizes:    2,
		interactive:   5,
	});

	// Whole window
	assert_eq!(ceilings(SurfaceClass::WholeWindow), Ceilings {
		edges:         16.0,
		distinct_gaps: 8,
		text_sizes:    6,
		interactive:   105,
	});

	// Densest region ceiling
	assert_eq!(DENSEST_REGION_CEILING, 20.8);
}

#[test]
fn test_exhaustive_variant_match_fails_on_new_member() {
	// Compile-time check: matching every variant without wildcard ensure no variant
	// is missed
	for surface in SurfaceClass::ALL {
		match surface {
			SurfaceClass::QueueRowCard => {},
			SurfaceClass::QueueRowLine => {},
			SurfaceClass::TranscriptTurn => {},
			SurfaceClass::BlockChrome => {},
			SurfaceClass::Composer => {},
			SurfaceClass::RightPanelChrome => {},
			SurfaceClass::TerminalDrawerChrome => {},
			SurfaceClass::WholeWindow => {},
		}
	}
}
