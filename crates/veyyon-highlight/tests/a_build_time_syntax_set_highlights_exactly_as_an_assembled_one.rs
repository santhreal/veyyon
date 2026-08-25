//! WHY: the syntax set used to be assembled in every process —
//! `load_defaults_newlines()`, then `into_builder()` to fold three vendored
//! syntaxes in, then `build()` to relink — which cost 12.5MB of resident heap
//! for a set that is 1.4MB when merely deserialised. `build.rs` now assembles
//! it once and embeds the dump.
//!
//! The class this closes is "the embedded set is not the set that was
//! assembled". A syntax dropped by the dump round-trip, a vendored syntax that
//! stopped being reachable, or an embedded language whose include closure broke
//! would all show up as *plausible* output rather than as an error, because
//! syntect resolves a cross-syntax `ContextReference` with `with_escape: true`
//! by silently falling back to Plain Text. Uncoloured CSS inside an HTML block
//! is not a crash and no smaller test would notice it.
//!
//! So the assertion is byte equality of highlighter output between the
//! assembled set and the embedded one, swept over every token the assembled set
//! can name, against a corpus chosen to reach embedded languages, diff markup
//! and non-ASCII text.
//!
//! What this does NOT catch: it compares the embedded set against an assembled
//! set built the same way in this process, so a change that makes `build.rs`
//! and this test wrong in the same direction passes. It also cannot see a
//! regression in a language syntect does not bundle and this crate does not
//! vendor, because no token names one.

use std::collections::BTreeSet;

use syntect::parsing::{SyntaxDefinition, SyntaxSet};
use veyyon_highlight::{Palette, highlight_with, syntax_set};

const VENDORED: &[(&str, &str)] = &[
	("Julia", include_str!("../src/syntaxes/Julia.sublime-syntax")),
	("Nix", include_str!("../src/syntaxes/Nix.sublime-syntax")),
	("Mermaid", include_str!("../src/syntaxes/Mermaid.sublime-syntax")),
];

/// The set as it used to be assembled at runtime, and as `build.rs` assembles
/// it now. This is the reference the embedded dump must match.
fn assembled_set() -> SyntaxSet {
	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
	for (name, src) in VENDORED {
		let def = SyntaxDefinition::load_from_str(src, true, None)
			.unwrap_or_else(|e| panic!("vendored syntax {name} does not parse: {e}"));
		builder.add(def);
	}
	builder.build()
}

/// Distinguishable per slot, so a run that lands in the wrong category is a
/// diff rather than a coincidence. Real ANSI escapes would compare equal
/// whenever two slots share a colour.
const fn palette() -> Palette<'static> {
	Palette {
		comment:     "<comment>",
		keyword:     "<keyword>",
		function:    "<function>",
		variable:    "<variable>",
		string:      "<string>",
		number:      "<number>",
		type_name:   "<type>",
		operator:    "<operator>",
		punctuation: "<punctuation>",
		inserted:    "<inserted>",
		deleted:     "<deleted>",
	}
}

/// Inputs chosen for what they reach, not for being idiomatic in any one
/// language: every syntax is run against all of them.
const CORPUS: &[(&str, &str)] = &[
	("braces and strings", "fn main() { let x = \"hi\"; /* c */ return 42; }\n"),
	("line comments", "# comment\nvalue = 1 // trailing\n"),
	// HTML with both embedded languages: the closure hazard this suite exists
	// for. A broken embed colours these as plain text instead of as CSS and JS.
	(
		"html embedding css and js",
		"<html><style>a{color:red}</style><script>var x=1;</script><p>t</p></html>\n",
	),
	("unified diff", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old line\n+new line\n"),
	("non-ascii", "// héllo wörld — 日本語\nlet s = \"ünïcødé\";\n"),
	("empty", ""),
	("only a newline", "\n"),
	("no trailing newline", "let x = 1"),
];

/// Every token the assembled set can be addressed by: display names and file
/// extensions, enumerated from the set rather than listed here, so a syntect
/// bump that adds or renames a language widens this sweep on its own.
fn tokens(set: &SyntaxSet) -> Vec<String> {
	let mut out = BTreeSet::new();
	for syntax in set.syntaxes() {
		out.insert(syntax.name.clone());
		for ext in &syntax.file_extensions {
			out.insert(ext.clone());
		}
	}
	out.into_iter().collect()
}

#[test]
fn the_embedded_set_holds_exactly_the_languages_that_were_assembled() {
	let assembled = assembled_set();
	let embedded = syntax_set();

	let assembled_names: Vec<&str> = assembled.syntaxes().iter().map(|s| &*s.name).collect();
	let embedded_names: Vec<&str> = embedded.syntaxes().iter().map(|s| &*s.name).collect();

	// Exact equality including order: a dump that reordered syntaxes would
	// change which one an ambiguous extension resolves to.
	assert_eq!(
		assembled_names, embedded_names,
		"the embedded dump does not hold the same languages, in the same order, as an assembled set"
	);
}

#[test]
fn every_vendored_syntax_is_reachable_in_the_embedded_set() {
	let embedded = syntax_set();
	let missing: Vec<&str> = VENDORED
		.iter()
		.map(|(name, _)| *name)
		.filter(|name| embedded.find_syntax_by_name(name).is_none())
		.collect();
	assert!(
		missing.is_empty(),
		"vendored syntaxes absent from the embedded set: {missing:?}. They would degrade to \
		 uncoloured output rather than fail."
	);
}

#[test]
fn the_embedded_set_highlights_every_token_exactly_as_an_assembled_one() {
	let assembled = assembled_set();
	let embedded = syntax_set();
	let palette = palette();

	let tokens = tokens(&assembled);
	assert!(
		tokens.len() > 100,
		"only {} tokens swept: the enumeration stopped reflecting the set, so this suite is no \
		 longer covering the languages it claims to",
		tokens.len()
	);

	let mut divergent = Vec::new();
	for token in &tokens {
		for (case, code) in CORPUS {
			let want = highlight_with(&assembled, code, Some(token), &palette);
			let got = highlight_with(embedded, code, Some(token), &palette);
			if want != got {
				divergent.push(format!("token {token:?} case {case:?}"));
			}
		}
	}

	assert!(
		divergent.is_empty(),
		"{} of {} (token, case) pairs highlight differently against the embedded set:\n{}",
		divergent.len(),
		tokens.len() * CORPUS.len(),
		divergent.join("\n")
	);
}

#[test]
fn an_unresolvable_language_falls_back_to_plain_text_in_both_sets() {
	let assembled = assembled_set();
	let embedded = syntax_set();
	let palette = palette();

	// Absent language, and no language at all: both must reach the same plain
	// text fallback, or a code block with an unknown fence would render
	// differently after this change.
	for lang in [None, Some("no-such-language-8f2a"), Some(""), Some("../etc/passwd")] {
		let code = "plain text { \"quoted\" } # 1\n";
		assert_eq!(
			highlight_with(&assembled, code, lang, &palette),
			highlight_with(embedded, code, lang, &palette),
			"fallback for {lang:?} differs between an assembled set and the embedded one"
		);
	}
}

#[test]
fn an_all_empty_palette_returns_every_input_verbatim() {
	// The napi shim passes an empty string for any colour the caller omitted, so
	// an empty slot must mean "no escape" rather than "an escape around nothing",
	// which would still change the bytes a terminal receives.
	//
	// Swept over every token and every case, this is also the strongest
	// available check on the run splitting itself: the concatenated runs have to
	// reproduce the input exactly, so a scope offset that dropped, duplicated or
	// reordered a run shows up here whatever slot it mapped to.
	let embedded = syntax_set();
	let empty = Palette::default();

	let mut wrong = Vec::new();
	for token in tokens(&assembled_set()) {
		for (case, code) in CORPUS {
			let out = highlight_with(embedded, code, Some(&token), &empty);
			if out != *code {
				wrong.push(format!("token {token:?} case {case:?}"));
			}
		}
	}

	assert!(wrong.is_empty(), "an uncoloured pass altered its input for:\n{}", wrong.join("\n"));
}

#[test]
fn a_populated_slot_wraps_its_run_and_preserves_the_text() {
	// The complement of the sweep above: colours must actually be emitted, and
	// removing them again must land back on the input. Asserted by stripping
	// rather than by pinning run boundaries, which are syntect's business and
	// move with a grammar update.
	let embedded = syntax_set();
	let palette = palette();
	let code = "// c\nfn f() { let s = \"x\"; }\n";

	let out = highlight_with(embedded, code, Some("rs"), &palette);
	assert_ne!(out, code, "a populated palette emitted no escapes at all");

	let mut stripped = out;
	for marker in [
		"\x1b[39m",
		"<comment>",
		"<keyword>",
		"<function>",
		"<variable>",
		"<string>",
		"<number>",
		"<type>",
		"<operator>",
		"<punctuation>",
		"<inserted>",
		"<deleted>",
	] {
		stripped = stripped.replace(marker, "");
	}
	assert_eq!(stripped, code, "removing every escape did not return the original text");
}
