//! WHY: the section 6 ceilings are the only thing standing between a scale and
//! the reference product's 61 spacing steps, and for two sections they were not
//! standing at all: `type.mono` and `stroke` read their known keys and ignored
//! every other entry, so a fourth stroke width loaded in silence. The earlier
//! suite could not see it, because it asserted `Enum::all().len() <= N` over
//! fixed-size arrays and never reached the loader.
//!
//! The class this closes is a scale section that grows without a decision. The
//! sweep enumerates the tables of the shipped `scale.toml` at run time, hands
//! each one a surplus of entries, and pins what stopped it: a section 6 ceiling
//! naming its spec section, or a closed key set. A new table with neither
//! arrives as `Unguarded` and turns the suite red, and so does deleting a
//! guard from `load_scale`.
//!
//! It does not catch a ceiling raised in both `load_scale` and the expected
//! table in one edit, which is the reviewable diff the ceiling exists to force.

use std::{fs, path::Path};

use toml::{Value, map::Map};
use veyyon_desktop_tokens::{
	ColorRole, MonoSizeStep, MotionRole, RadiusStep, SpacingStep, StrokeStep, TokenError,
	TypeSizeStep, TypeWeightStep, loader_scale::load_scale,
};
use veyyon_test_scratch::scratch_dir;

/// Entries added to a section, over every ceiling section 6 declares.
const SURPLUS: usize = 64;

/// What stopped a section from taking entries the loader does not read.
#[derive(Debug, PartialEq, Eq)]
enum Guard {
	/// A section 6 ceiling, reported with the section it is defined in.
	Ceiling { what: String, ceiling: usize, spec_section: String },
	/// A closed key set: an unread entry is rejected by name.
	ClosedKeys,
	/// Nothing: the surplus loaded. This is the defect the suite closes.
	Unguarded,
}

fn ceiling(what: &str, ceiling: usize, spec_section: &str) -> Guard {
	Guard::Ceiling { what: what.to_string(), ceiling, spec_section: spec_section.to_string() }
}

fn shipped_text() -> String {
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens/scale.toml");
	fs::read_to_string(&path).expect("read shipped scale.toml")
}

/// Table headers in file order, so a section added to `scale.toml` is swept
/// without anyone listing it here.
fn section_headers(text: &str) -> Vec<String> {
	text
		.lines()
		.filter_map(|line| line.strip_prefix('['))
		.filter_map(|line| line.strip_suffix(']'))
		.map(str::to_string)
		.collect()
}

/// Writes `text` with `extra` entries appended to `section`.
fn with_surplus(text: &str, section: &str, extra: usize) -> String {
	let header = format!("[{section}]");
	let mut out = String::with_capacity(text.len() + extra * 16);
	for line in text.lines() {
		out.push_str(line);
		out.push('\n');
		if line == header {
			for index in 0..extra {
				out.push_str(&format!("zz_surplus_{index} = 1\n"));
			}
		}
	}
	out
}

fn guard_of(dir: &Path, text: &str, section: &str) -> Guard {
	let path = dir.join(format!("{}.toml", section.replace('.', "-")));
	fs::write(&path, with_surplus(text, section, SURPLUS)).expect("write probe scale");
	let Err(err) = load_scale(&path) else {
		return Guard::Unguarded;
	};
	match err {
		TokenError::CeilingExceeded {
			section: what, count, ceiling: limit, spec_section, ..
		} => {
			assert!(count > limit, "{section}: reported count {count} is not over {limit}");
			ceiling(&what, limit, spec_section)
		},
		TokenError::UnknownKey { .. } => Guard::ClosedKeys,
		other => panic!("{section}: expected a ceiling or a closed key set, got {other:?}"),
	}
}

fn table_at<'a>(value: &'a Value, section: &str) -> &'a Map<String, Value> {
	let mut current = value;
	for part in section.split('.') {
		current = current
			.get(part)
			.unwrap_or_else(|| panic!("{section} is missing"));
	}
	current
		.as_table()
		.unwrap_or_else(|| panic!("{section} is not a table"))
}

#[test]
fn every_scale_section_stops_a_surplus_entry() {
	let text = shipped_text();
	let tree = scratch_dir("desktop-tokens-scale-ceilings");

	let mut observed: Vec<(String, Guard)> = Vec::new();
	let mut skipped: Vec<String> = Vec::new();
	for section in section_headers(&text) {
		if section == "meta" {
			skipped.push(section);
			continue;
		}
		let guard = guard_of(tree.path(), &text, &section);
		observed.push((section, guard));
	}

	assert_eq!(skipped, ["meta".to_string()], "only the meta block carries no scale");

	let expected: Vec<(String, Guard)> = [
		("spacing", ceiling("spacing scale", 16, "6.1")),
		("radius", ceiling("corner radii", 8, "6.2")),
		("type.size", ceiling("typographic sizes", 6, "6.3")),
		("type.weight", ceiling("typographic weights", 3, "6.3")),
		("type.mono", ceiling("mono sizes", 2, "6.3")),
		("type.family", Guard::ClosedKeys),
		("stroke", ceiling("stroke widths", 3, "6.8")),
	]
	.into_iter()
	.map(|(section, guard)| (section.to_string(), guard))
	.collect();

	assert_eq!(observed, expected);
}

#[test]
fn a_section_over_its_ceiling_names_the_file_and_the_spec_section() {
	let text = shipped_text();
	let tree = scratch_dir("desktop-tokens-scale-ceiling-message");
	let path = tree.path().join("scale.toml");
	fs::write(&path, with_surplus(&text, "stroke", 1)).expect("write probe scale");

	let err = load_scale(&path).expect_err("a fourth stroke width is over the ceiling of 3");

	assert_eq!(
		err.to_string(),
		format!("[{}] stroke widths count 4 exceeds ceiling of 3 (defined in §6.8)", path.display())
	);
}

#[test]
fn the_shipped_scale_holds_one_entry_per_declared_step() {
	let value: Value = shipped_text().parse().expect("parse shipped scale.toml");
	let sections = [
		("spacing", SpacingStep::all().len()),
		("radius", RadiusStep::all().len()),
		("type.size", TypeSizeStep::all().len()),
		("type.weight", TypeWeightStep::all().len()),
		("type.mono", MonoSizeStep::all().len()),
		("stroke", StrokeStep::all().len()),
	];

	let mismatched: Vec<(&str, usize, usize)> = sections
		.into_iter()
		.map(|(section, declared)| (section, table_at(&value, section).len(), declared))
		.filter(|(_, in_file, declared)| in_file != declared)
		.collect();

	let none: Vec<(&str, usize, usize)> = Vec::new();
	assert_eq!(mismatched, none, "(section, entries in file, steps in enum)");
}

#[test]
fn every_declared_scale_sits_under_its_ceiling() {
	let declared = [
		("spacing (§6.1)", SpacingStep::all().len(), 16),
		("radius (§6.2)", RadiusStep::all().len(), 8),
		("type sizes (§6.3)", TypeSizeStep::all().len(), 6),
		("type weights (§6.3)", TypeWeightStep::all().len(), 3),
		("mono sizes (§6.3)", MonoSizeStep::all().len(), 2),
		("colour roles (§6.4)", ColorRole::all().len(), 40),
		("stroke widths (§6.8)", StrokeStep::all().len(), 3),
		("motion roles (§7.1)", MotionRole::all().len(), 7),
	];

	let over: Vec<(&str, usize, usize)> = declared
		.into_iter()
		.filter(|(_, declared, ceiling)| declared > ceiling)
		.collect();

	let none: Vec<(&str, usize, usize)> = Vec::new();
	assert_eq!(over, none, "(scale, steps declared, ceiling)");
}
