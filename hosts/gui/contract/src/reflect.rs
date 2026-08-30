//! Reading a tagged enum's variant space out of the type itself.
//!
//! Every union in this crate is an internally tagged enum, and the drift test
//! has to compare its members against the TypeScript table they mirror. A
//! hand-written list of member names on the Rust side would go stale the moment
//! someone adds a variant and forgets it, which is the same failure as having
//! no test.
//!
//! So the list comes from serde. Deserializing a tag no variant claims produces
//! `unknown variant \`x\`, expected one of \`a\`, \`b\`, ...`, and that list is
//! generated from the variants at compile time. Adding a variant adds it here
//! with nothing to remember.
//!
//! The cost is a dependency on the wording of one serde error. [`variants`]
//! fails rather than returning an empty list when the wording changes, so that
//! shows up as a red test naming the message it could not read.

use serde::de::DeserializeOwned;

/// Every tag an internally tagged enum accepts, in declaration order.
///
/// `tag` is the field name the enum is tagged by: `"kind"`, `"type"`,
/// `"outcome"`.
///
/// # Panics
///
/// When the probe tag is accepted, or when serde's error does not name the
/// variants. Both mean this technique stopped working and the caller's variant
/// space is unknown, which must not read as "no variants".
pub fn variants<T: DeserializeOwned>(tag: &str) -> Vec<String> {
	/// A tag no variant can plausibly claim.
	const PROBE: &str = "__veyyon_probe__";

	let probe = format!(r#"{{"{tag}":"{PROBE}"}}"#);
	let error = serde_json::from_str::<T>(&probe)
		.err()
		.unwrap_or_else(|| panic!("a variant accepted the probe tag `{PROBE}`"));
	let message = error.to_string();

	let listed = parse_expected(&message).unwrap_or_else(|| {
		panic!(
			"could not read the variant list out of serde's error, so the variant space is \
			 unknown.\nTagged by `{tag}`, message was: {message}"
		)
	});
	assert!(
		listed.len() > 1,
		"serde named only {} variant(s), which is not a union: {message}",
		listed.len()
	);
	listed
}

/// Pull the backtick-quoted names out of serde's message.
///
/// Two shapes reach here: `expected one of \`a\`, \`b\`` for a union, and
/// `expected \`a\`` when the enum has a single variant. Both are handled, and
/// the message carries a trailing ` at line N column M` that is not part of any
/// name — so names are taken from the backtick pairs rather than by splitting
/// on commas.
fn parse_expected(message: &str) -> Option<Vec<String>> {
	let tail = message.split(", expected ").nth(1)?;
	let names: Vec<String> = tail
		.split('`')
		.skip(1)
		.step_by(2)
		.map(str::to_owned)
		.filter(|name| !name.is_empty())
		.collect();
	if names.is_empty() { None } else { Some(names) }
}

#[cfg(test)]
mod tests {
	use serde::Deserialize;

	use super::*;

	// The fields exist so the variants are struct-shaped like the real contract's
	// are; nothing reads them, because the point is the tag list.
	#[expect(dead_code, reason = "field shape matters, the value does not")]
	#[derive(Debug, Deserialize)]
	#[serde(tag = "kind", rename_all = "kebab-case")]
	enum Sample {
		One { value: u8 },
		TwoWords { value: u8 },
		Three,
	}

	/// The variant space comes back complete and in declaration order, with the
	/// renamed spelling rather than the Rust identifier.
	#[test]
	fn variants_come_from_the_type() {
		assert_eq!(variants::<Sample>("kind"), vec!["one", "two-words", "three"]);
	}

	/// A single-variant enum is not a union, and a caller comparing it against a
	/// table would be comparing against something this cannot enumerate
	/// reliably. Reported, not returned.
	#[test]
	#[should_panic(expected = "which is not a union")]
	fn a_single_variant_enum_is_reported() {
		#[expect(dead_code, reason = "field shape matters, the value does not")]
		#[derive(Debug, Deserialize)]
		#[serde(tag = "kind", rename_all = "kebab-case")]
		enum Lonely {
			Only { value: u8 },
		}
		let _ = variants::<Lonely>("kind");
	}

	/// A message that does not name the variants is reported rather than read as
	/// an empty variant space. This is the failure mode a serde upgrade would
	/// cause, and it has to be loud.
	#[test]
	fn a_message_without_a_variant_list_is_not_read_as_empty() {
		assert_eq!(parse_expected("something else entirely"), None);
		assert_eq!(parse_expected("unknown variant `x`, expected one of "), None);
	}

	/// The parser reads the messages serde actually emits, both union and
	/// single-variant, with the trailing position clause that is not part of any
	/// name.
	#[test]
	fn the_parser_reads_serdes_shapes() {
		assert_eq!(
			parse_expected("unknown variant `q`, expected one of `a`, `b-c`, `d` at line 1 column 26"),
			Some(vec!["a".to_owned(), "b-c".to_owned(), "d".to_owned()])
		);
		// A single-variant enum drops the "one of".
		assert_eq!(
			parse_expected("unknown variant `q`, expected `only` at line 1 column 26"),
			Some(vec!["only".to_owned()])
		);
		// The position clause never leaks into the last name.
		let names =
			parse_expected("unknown variant `q`, expected one of `a`, `b` at line 1 column 9")
				.expect("parses");
		assert_eq!(names.last().map(String::as_str), Some("b"));
	}
}
