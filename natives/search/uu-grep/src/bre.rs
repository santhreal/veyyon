//! POSIX basic regular expressions, translated into the syntax the search
//! engines speak.
//!
//! WHY THIS EXISTS. `grep -G` asks for a BASIC regular expression, where `+`,
//! `?`, `|`, `(`, `)`, `{` and `}` are ordinary characters and the escaped
//! forms `\+`, `\?`, `\|`, `\(`, `\)`, `\{` and `\}` are the operators. That is
//! the opposite of every regex engine written since, including the two this
//! builtin searches with, so a BRE has to be rewritten before it can be
//! compiled. Until this module existed, `-G` was accepted and then ignored: it
//! selected the same mode as no flag at all, which compiles the pattern as a
//! modern regex. So `grep -G 'a+b'` looked for one or more `a` followed by `b`,
//! while GNU grep 3.11 looks for the three characters `a+b`, and a user who
//! wrote the pattern GNU's way got silent nonsense rather than an error.
//!
//! WHAT THE RULES ARE, every one measured against GNU grep 3.11 rather than
//! read off a summary of POSIX:
//!
//! - `+ ? | ( ) { }` match themselves. `\+ \? \| \( \) \{ \}` are the
//!   operators.
//! - `*` is an operator EXCEPT where there is nothing for it to repeat, which
//!   means at the start of the pattern, just after `\(` or `\|`, and just after
//!   a leading `^`. There it matches itself: `grep '*abc'` finds `*abc`.
//! - `^` is an anchor in those same positions and matches itself anywhere else,
//!   so `a^b` finds `a^b`.
//! - `$` is an anchor at the end of the pattern and before `\)` or `\|`, and
//!   matches itself anywhere else, so `a$b` finds `a$b`.
//! - A bracket expression is POSIX's, and POSIX has no escapes inside one: `\`
//!   is an ordinary character there, `]` first is ordinary, and `[:alpha:]`,
//!   `[.coll.]` and `[=equiv=]` keep their meaning. `grep 'a[\]b'` finds `a\b`.
//! - `\b \B \w \W \s \S \< \>` are GNU's extensions and survive the
//!   translation.
//! - `\1` to `\9` are back-references. The Rust engine cannot compile one at
//!   all, so a pattern that uses one is handed to PCRE2 instead of being
//!   quietly dropped.
//! - Any other escaped character is that character: `\d` finds `d`.
//!
//! Errors carry GNU's wording, because the exit code is 2 either way and the
//! message is the only thing that tells a script's author what to fix.

/// A basic regular expression, rewritten for the engines.
pub(crate) struct Translated {
	/// The pattern in the syntax the Rust and PCRE2 engines share.
	pub(crate) pattern:        String,
	/// Whether it uses a back-reference, which only PCRE2 can compile.
	pub(crate) back_reference: bool,
}

/// GNU's message for a pattern that ends inside an escape.
const TRAILING_BACKSLASH: &str = "Trailing backslash";
/// GNU's message for an interval that never closes.
const UNMATCHED_BRACE: &str = r"Unmatched \{";
/// GNU's message for an interval whose body is not a count.
const BAD_INTERVAL: &str = r"Invalid content of \{\}";
/// GNU's message for a bracket expression that never closes.
const UNMATCHED_BRACKET: &str = "Unmatched [, [^, [:, [., or [=";
/// GNU's message for a `[` with nothing after it at all.
const INVALID_EXPRESSION: &str = "Invalid regular expression";

/// Translate a POSIX basic regular expression.
///
/// The error strings are GNU grep 3.11's, so `grep -G 'a\{'` reports
/// `grep: Unmatched \{` and not a Rust regex diagnostic about a repetition
/// operator.
pub(crate) fn translate(bre: &str) -> Result<Translated, String> {
	let chars: Vec<char> = bre.chars().collect();
	let mut out = String::with_capacity(bre.len() + 8);
	let mut back_reference = false;
	// Where an operator has nothing to repeat: the start of the pattern, and the
	// start of any group or alternative. A `*` is literal here and a `^` anchors.
	let mut at_start = true;
	let mut index = 0usize;

	while index < chars.len() {
		let ch = chars[index];
		match ch {
			'\\' => {
				let Some(&next) = chars.get(index + 1) else {
					return Err(TRAILING_BACKSLASH.to_string());
				};
				index += 2;
				match next {
					'(' => {
						out.push('(');
						at_start = true;
					},
					'|' => {
						out.push('|');
						at_start = true;
					},
					')' => {
						out.push(')');
						at_start = false;
					},
					'{' => {
						index = push_interval(&chars, index, &mut out)?;
						at_start = false;
					},
					'}' => {
						// A `\}` with no `\{` before it is GNU's literal brace.
						out.push_str("\\}");
						at_start = false;
					},
					'+' | '?' => {
						out.push(next);
						at_start = false;
					},
					'1'..='9' => {
						back_reference = true;
						out.push('\\');
						out.push(next);
						at_start = false;
					},
					'b' | 'B' | 'w' | 'W' | 's' | 'S' | '<' | '>' => {
						out.push('\\');
						out.push(next);
						at_start = false;
					},
					_ => {
						push_literal(&mut out, next);
						at_start = false;
					},
				}
			},
			'*' => {
				// Nothing to repeat means the asterisk is one of the characters being
				// looked for.
				if at_start {
					out.push_str("\\*");
				} else {
					out.push('*');
				}
				at_start = false;
				index += 1;
			},
			'^' => {
				if at_start {
					out.push('^');
					// A leading anchor still leaves nothing for a `*` to repeat.
				} else {
					out.push_str("\\^");
					at_start = false;
				}
				index += 1;
			},
			'$' => {
				if anchors_here(&chars, index) {
					out.push('$');
				} else {
					out.push_str("\\$");
				}
				at_start = false;
				index += 1;
			},
			'[' => {
				index = push_bracket(&chars, index, &mut out)?;
				at_start = false;
			},
			'.' => {
				out.push('.');
				at_start = false;
				index += 1;
			},
			_ => {
				push_literal(&mut out, ch);
				at_start = false;
				index += 1;
			},
		}
	}

	Ok(Translated { pattern: out, back_reference })
}

/// Whether the `$` at `index` is the end-of-line anchor.
///
/// It is at the end of the pattern, and before `\)` or `\|`. Anywhere else it
/// is the character itself, which is why `grep 'a$b'` finds `a$b`.
fn anchors_here(chars: &[char], index: usize) -> bool {
	matches!((chars.get(index + 1), chars.get(index + 2)), (None, _) | (Some('\\'), Some(')' | '|')))
}

/// Copy the body of a `\{...\}` interval, having just consumed the `\{`.
///
/// Returns the index just past the closing `\}`. The body is validated here
/// rather than left to the engine, so the message is GNU's.
fn push_interval(chars: &[char], mut index: usize, out: &mut String) -> Result<usize, String> {
	let mut body = String::new();
	loop {
		match (chars.get(index), chars.get(index + 1)) {
			(None, _) => return Err(UNMATCHED_BRACE.to_string()),
			(Some('\\'), Some('}')) => {
				index += 2;
				break;
			},
			(Some(&ch), _) => {
				body.push(ch);
				index += 1;
			},
		}
	}
	if !interval_is_a_count(&body) {
		return Err(BAD_INTERVAL.to_string());
	}
	out.push('{');
	out.push_str(&body);
	out.push('}');
	Ok(index)
}

/// Whether an interval body is `m`, `m,` or `m,n` with `m` no greater than `n`.
///
/// GNU rejects `a\{2,1\}` and `a\{x\}` with the same message, so both are
/// checked in one place.
fn interval_is_a_count(body: &str) -> bool {
	let (low, high) = match body.split_once(',') {
		None => (body, None),
		Some((low, "")) => (low, None),
		Some((low, high)) => (low, Some(high)),
	};
	let Ok(low) = low.parse::<u64>() else {
		return false;
	};
	match high {
		None => true,
		Some(high) => high.parse::<u64>().is_ok_and(|high| low <= high),
	}
}

/// Copy a bracket expression, having its opening `[` at `index`.
///
/// Returns the index just past the closing `]`. POSIX gives a bracket
/// expression no escapes at all, so a backslash inside one is an ordinary
/// character and is doubled on the way out, where the engines would have read
/// it as an escape.
fn push_bracket(chars: &[char], index: usize, out: &mut String) -> Result<usize, String> {
	let mut at = index + 1;
	if at >= chars.len() {
		return Err(INVALID_EXPRESSION.to_string());
	}
	out.push('[');
	if chars.get(at) == Some(&'^') {
		out.push('^');
		at += 1;
	}
	// A `]` in the first position is one of the characters in the set. The engines
	// need it escaped to read it that way.
	if chars.get(at) == Some(&']') {
		out.push_str("\\]");
		at += 1;
	}
	loop {
		match chars.get(at) {
			None => return Err(UNMATCHED_BRACKET.to_string()),
			Some(']') => {
				out.push(']');
				return Ok(at + 1);
			},
			// `[:alpha:]`, `[.coll.]` and `[=equiv=]` keep their own closers.
			Some('[') if matches!(chars.get(at + 1), Some(':' | '.' | '=')) => {
				let kind = chars[at + 1];
				out.push('[');
				out.push(kind);
				at += 2;
				loop {
					match chars.get(at) {
						None => return Err(UNMATCHED_BRACKET.to_string()),
						Some(&ch) if ch == kind && chars.get(at + 1) == Some(&']') => {
							out.push(ch);
							out.push(']');
							at += 2;
							break;
						},
						Some(&ch) => {
							out.push(ch);
							at += 1;
						},
					}
				}
			},
			Some('\\') => {
				out.push_str("\\\\");
				at += 1;
			},
			Some(&ch) => {
				out.push(ch);
				at += 1;
			},
		}
	}
}

/// Write `ch` so the engines read it as itself.
fn push_literal(out: &mut String, ch: char) {
	if matches!(
		ch,
		'\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$'
	) {
		out.push('\\');
	}
	out.push(ch);
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The translated pattern, or the error message.
	fn rewrite(bre: &str) -> String {
		match translate(bre) {
			Ok(translated) => translated.pattern,
			Err(error) => format!("error: {error}"),
		}
	}

	/// The operators a BRE spells with a backslash, and the characters it spells
	/// without one. Both directions in one test, because a translator that only
	/// escapes, or only unescapes, passes half of them.
	#[test]
	fn the_escaped_forms_are_the_operators_and_the_bare_forms_are_characters() {
		assert_eq!(rewrite("a+b"), r"a\+b", "GNU finds the three characters a+b");
		assert_eq!(rewrite(r"a\+b"), "a+b", "and one or more a followed by b");
		assert_eq!(rewrite("a?b"), r"a\?b");
		assert_eq!(rewrite(r"a\?b"), "a?b");
		assert_eq!(rewrite("a|b"), r"a\|b");
		assert_eq!(rewrite(r"a\|b"), "a|b");
		assert_eq!(rewrite("(ab)"), r"\(ab\)");
		assert_eq!(rewrite(r"\(ab\)"), "(ab)");
		assert_eq!(rewrite("a{2}"), r"a\{2\}");
		assert_eq!(rewrite(r"a\{2\}"), "a{2}");
	}

	/// `*` and `.` need no backslash in either syntax, so they must survive
	/// untouched. A translator that escaped everything would still pass the test
	/// above.
	#[test]
	fn the_two_operators_a_bre_shares_with_a_modern_regex_are_untouched() {
		assert_eq!(rewrite("ab*c"), "ab*c");
		assert_eq!(rewrite("a.c"), "a.c");
		assert_eq!(rewrite(r"a\.c"), r"a\.c", "an escaped dot stays escaped");
		assert_eq!(rewrite("a**"), "a**", "GNU accepts a doubled star and so must this");
	}

	/// `*` matches itself where there is nothing to repeat, which is the rule
	/// that makes `grep '*abc'` find `*abc`. Every position GNU treats that
	/// way: the start of the pattern, after `\(`, after `\|`, and after a
	/// leading `^`.
	#[test]
	fn a_star_with_nothing_to_repeat_is_a_character() {
		assert_eq!(rewrite("*abc"), r"\*abc");
		assert_eq!(rewrite(r"\(*a\)"), r"(\*a)");
		assert_eq!(rewrite(r"a\|*b"), r"a|\*b");
		assert_eq!(rewrite("^*abc"), r"^\*abc");
		assert_eq!(rewrite("a*b"), "a*b", "THE TWIN: with something to repeat it is the operator");
	}

	/// `^` anchors only where a `*` would have been literal, and `$` anchors
	/// only at the end of the pattern or before `\)` or `\|`. Everywhere else
	/// both are characters, which is why `grep 'a^b'` finds `a^b` and `grep
	/// 'a$b'` finds `a$b`.
	#[test]
	fn the_anchors_are_characters_in_the_middle_of_a_pattern() {
		assert_eq!(rewrite("^ab"), "^ab");
		assert_eq!(rewrite("a^b"), r"a\^b");
		assert_eq!(rewrite("ab$"), "ab$");
		assert_eq!(rewrite("a$b"), r"a\$b");
		assert_eq!(rewrite(r"a$\|b"), r"a$|b", "an anchor before an alternative");
		assert_eq!(rewrite(r"\(a$\)"), "(a$)", "and before a closing group");
		assert_eq!(rewrite(r"\(a$b\)"), r"(a\$b)", "but not in the middle of one");
		assert_eq!(rewrite("^$"), "^$", "the empty-line pattern still works");
	}

	/// A bracket expression is POSIX's, and POSIX has no escapes inside one. The
	/// backslash is an ordinary character there and has to be doubled so the
	/// engines read it that way: `grep 'a[\]b'` finds `a\b`.
	#[test]
	fn a_bracket_expression_has_no_escapes_inside_it() {
		assert_eq!(rewrite(r"a[\]b"), r"a[\\]b");
		assert_eq!(rewrite("[]a]"), r"[\]a]", "a closing bracket first is a character");
		assert_eq!(rewrite("[^]a]"), r"[^\]a]", "and after a negation too");
		assert_eq!(rewrite("[a-c]"), "[a-c]");
		assert_eq!(rewrite("[^a-c]"), "[^a-c]");
		assert_eq!(rewrite("[[:digit:]]"), "[[:digit:]]");
		assert_eq!(rewrite("[[:alpha:][:space:]]"), "[[:alpha:][:space:]]");
		assert_eq!(rewrite("[[.hyphen.]]"), "[[.hyphen.]]");
		assert_eq!(rewrite("[[=a=]]"), "[[=a=]]");
		assert_eq!(
			rewrite("[+*.]"),
			"[+*.]",
			"an operator inside a bracket expression is already a character"
		);
	}

	/// GNU's own extensions survive, since a user who reaches for `\<word\>` in
	/// `-G` mode is using GNU grep and not POSIX.
	#[test]
	fn the_gnu_extensions_survive() {
		for extension in [r"\b", r"\B", r"\w", r"\W", r"\s", r"\S", r"\<", r"\>"] {
			assert_eq!(rewrite(extension), extension, "{extension} is GNU's own");
		}
		assert_eq!(rewrite(r"\<word\>"), r"\<word\>");
	}

	/// An escape GNU does not define is the character itself, so `\d` finds `d`
	/// and does not become a digit class. This is the case where passing the
	/// pattern through unchanged would silently mean something else.
	#[test]
	fn an_undefined_escape_is_the_character_itself() {
		assert_eq!(rewrite(r"\d"), "d");
		assert_eq!(rewrite(r"x\y"), "xy");
		assert_eq!(rewrite(r"a\\b"), r"a\\b", "an escaped backslash is one backslash");
		assert_eq!(rewrite(r"\."), r"\.", "and an escaped dot is a dot");
		assert_eq!(rewrite(r"\*"), r"\*");
	}

	/// A back-reference is reported, because the Rust engine cannot compile one
	/// and the caller has to route the pattern to PCRE2 instead of failing or
	/// quietly dropping it.
	#[test]
	fn a_back_reference_is_reported_to_the_caller() {
		let translated = translate(r"\(a\)\1").expect("a back-reference translates");
		assert_eq!(translated.pattern, r"(a)\1");
		assert!(translated.back_reference, "the caller needs PCRE2 for this one");

		let translated = translate(r"\(a\)\(b\)\2").expect("two groups translate");
		assert_eq!(translated.pattern, r"(a)(b)\2");
		assert!(translated.back_reference);

		let plain = translate(r"\(a\)b").expect("a group without a reference translates");
		assert!(!plain.back_reference, "THE TWIN: a group alone needs no PCRE2");
	}

	/// An interval's body is checked here so the message is GNU's, and the
	/// boundaries are the ones GNU accepts.
	#[test]
	fn an_interval_body_must_be_a_count() {
		assert_eq!(rewrite(r"a\{2\}"), "a{2}");
		assert_eq!(rewrite(r"a\{2,\}"), "a{2,}");
		assert_eq!(rewrite(r"a\{1,2\}"), "a{1,2}");
		assert_eq!(rewrite(r"a\{0,0\}"), "a{0,0}");
		assert_eq!(rewrite(r"a\{2,2\}"), "a{2,2}", "equal bounds are a count");
		assert_eq!(rewrite(r"a\{2,1\}"), r"error: Invalid content of \{\}");
		assert_eq!(rewrite(r"a\{x\}"), r"error: Invalid content of \{\}");
		assert_eq!(rewrite(r"a\{\}"), r"error: Invalid content of \{\}");
	}

	/// The errors carry GNU's wording, byte for byte, because the exit code is 2
	/// either way and the message is the only thing that says what to fix.
	#[test]
	fn the_errors_are_gnus_own_words() {
		assert_eq!(rewrite("\\"), "error: Trailing backslash");
		assert_eq!(rewrite(r"a\"), "error: Trailing backslash");
		assert_eq!(rewrite(r"a\{"), r"error: Unmatched \{");
		assert_eq!(rewrite(r"a\{1"), r"error: Unmatched \{");
		assert_eq!(rewrite("[a"), "error: Unmatched [, [^, [:, [., or [=");
		assert_eq!(rewrite("[[:al"), "error: Unmatched [, [^, [:, [., or [=");
		assert_eq!(rewrite("["), "error: Invalid regular expression");
	}

	/// A `\}` with no interval before it is a character, which GNU accepts, and
	/// an unmatched `}` is one too.
	#[test]
	fn a_stray_brace_is_a_character() {
		assert_eq!(rewrite("a}b"), r"a\}b");
		assert_eq!(rewrite(r"a\}b"), r"a\}b");
		assert_eq!(rewrite("}"), r"\}");
	}

	/// The empty pattern translates to the empty pattern, which matches every
	/// line. A translator that pushed an anchor or a group would break `grep
	/// ''`.
	#[test]
	fn the_empty_pattern_stays_empty() {
		assert_eq!(rewrite(""), "");
		assert_eq!(rewrite(r"\(\)"), "()", "and an empty group stays one");
	}

	/// Text outside the ASCII range is copied through, one character at a time,
	/// so a multi-byte character is never split and never escaped.
	#[test]
	fn non_ascii_text_is_copied_through() {
		assert_eq!(rewrite("héllo"), "héllo");
		assert_eq!(rewrite("日本語"), "日本語");
		assert_eq!(rewrite(r"caf\+é"), "caf+é");
		assert_eq!(rewrite("[é]"), "[é]");
	}
}
