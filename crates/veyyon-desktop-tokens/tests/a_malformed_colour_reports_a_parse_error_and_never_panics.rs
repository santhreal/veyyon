//! WHY THIS TEST EXISTS:
//! `RgbColor::from_hex` sliced its input by byte index (`&hex_str[0..2]`) after
//! testing `len()`, which is a byte count. A value whose byte length is 6, 8 or
//! 3 but whose bytes do not fall on character boundaries panicked with "byte
//! index N is not a char boundary" instead of returning an error.
//!
//! A colour value arrives from a theme file that an operator edits by hand, and
//! the token system's stated contract is that a malformed file reports a parse
//! error and the last good set stays. A panic in the parser breaks that
//! contract at its root: the process ends, so there is no error surface and no
//! previous set to keep.
//!
//! THE CLASS THIS CLOSES: any colour value reaching a byte-indexed slice.
//! Every branch of the length test is swept, at every byte offset a multi-byte
//! character can straddle, so a fix that repairs only the six-digit branch
//! fails here.
//!
//! WHAT IT DOES NOT CATCH: whether the parsed components are numerically
//! correct for a well-formed value; the round-trip test covers that. It also
//! does not prove the loader maps the error onto a `TokenError` with a path and
//! a role, which is the loader's own contract.

use veyyon_desktop_tokens::RgbColor;

/// Every input here has a byte length the parser accepts (3, 6 or 8) while
/// holding at least one multi-byte character, so a byte-indexed slice lands
/// inside a character. Built from characters of known UTF-8 width rather than
/// written as literals, so the intent survives a file re-encoding.
fn boundary_straddling_values() -> Vec<String> {
	// 'À' is 2 bytes, '€' is 3 bytes, '𝄞' is 4 bytes.
	let multi = ['À', '€', '𝄞'];
	let mut values = Vec::new();

	for wide in multi {
		let wide_len = wide.len_utf8();
		for target in [3_usize, 6, 8] {
			// Place the wide character at every offset where it still fits, and
			// pad with ASCII hex digits so the total byte length is exactly the
			// one the parser tests for.
			for offset in 0..target {
				if offset + wide_len > target {
					continue;
				}
				let mut value = String::new();
				for _ in 0..offset {
					value.push('a');
				}
				value.push(wide);
				while value.len() < target {
					value.push('a');
				}
				if value.len() == target {
					values.push(value);
				}
			}
		}
	}

	values
}

#[test]
fn a_colour_value_holding_a_multi_byte_character_returns_an_error() {
	let values = boundary_straddling_values();
	assert!(
		!values.is_empty(),
		"the generator produced no cases, so this test would pass without exercising the parser",
	);

	for value in &values {
		// The call must return, not unwind. A panic here is the defect.
		let parsed = RgbColor::from_hex(value);
		assert!(
			parsed.is_err(),
			"'{value}' ({} bytes) parsed as a colour; it is not a hex value",
			value.len(),
		);
	}
}

#[test]
fn a_leading_hash_does_not_change_the_boundary_behaviour() {
	// The parser trims '#' before measuring, so the same class reaches the
	// slice through the spelling an operator actually writes in a theme file.
	for value in boundary_straddling_values() {
		let hashed = format!("#{value}");
		assert!(
			RgbColor::from_hex(&hashed).is_err(),
			"'{hashed}' parsed as a colour; it is not a hex value",
		);
	}
}

#[test]
fn every_rejected_length_reports_rather_than_panicking() {
	// The lengths outside the accepted set take the final branch. Swept
	// alongside the accepted lengths so a rewrite that reorders the branches
	// cannot drop the report.
	for length in 0_usize..=12 {
		let value = "a".repeat(length);
		let parsed = RgbColor::from_hex(&value);
		if matches!(length, 3 | 6 | 8) {
			// 'a' is a hex digit, so these are well-formed and must parse.
			assert!(parsed.is_ok(), "'{value}' is a valid hex value of length {length}");
		} else {
			assert!(parsed.is_err(), "'{value}' is not a hex value but parsed");
		}
	}
}

#[test]
fn a_non_hex_ascii_character_is_rejected_at_every_offset() {
	// 'z' is single-byte, so this never reaches a boundary issue: it separates
	// "rejects non-hex digits" from "survives multi-byte input", which a fix
	// that merely validates ASCII-ness would otherwise conflate.
	for target in [3_usize, 6, 8] {
		for offset in 0..target {
			let mut value = "a".repeat(target);
			value.replace_range(offset..=offset, "z");
			assert!(
				RgbColor::from_hex(&value).is_err(),
				"'{value}' holds a non-hex digit at offset {offset} but parsed",
			);
		}
	}
}

/// A theme declares every role, so an absent role is a malformed theme. The
/// contrast check previously substituted white for a missing foreground and
/// black for a missing background, which scores the maximum 21:1: the one check
/// that guards legibility passed exactly when the theme could not be rendered.
#[test]
fn a_missing_role_fails_the_contrast_check_instead_of_scoring_the_maximum() {
	use std::{collections::HashMap, path::Path};

	use veyyon_desktop_tokens::{ColorRole, Theme};

	let empty = Theme {
		name:       "probe".to_string(),
		appearance: "dark".to_string(),
		version:    1,
		roles:      HashMap::new(),
	};

	let outcome = empty.assert_contrast(
		Path::new("probe.toml"),
		ColorRole::Foreground,
		ColorRole::Ground,
		4.5,
		1,
		1,
	);
	assert!(
		outcome.is_err(),
		"a theme declaring no roles passed a 4.5:1 contrast check, so the substituted defaults were \
		 scored instead of the theme",
	);

	// Every role is swept, so a fix that special-cases the foreground alone
	// still fails here.
	for role in ColorRole::all() {
		let mut roles = HashMap::new();
		for other in ColorRole::all() {
			if other != role {
				roles.insert(other, veyyon_desktop_tokens::RgbColor::new(0.5, 0.5, 0.5, 1.0));
			}
		}
		let partial =
			Theme { name: "probe".to_string(), appearance: "dark".to_string(), version: 1, roles };
		assert!(
			partial.role(Path::new("probe.toml"), role).is_err(),
			"role '{}' was absent from the theme but was reported as present",
			role.as_str(),
		);
	}
}
