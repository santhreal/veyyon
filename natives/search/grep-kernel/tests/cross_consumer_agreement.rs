//! Cross-consumer differential test.
//!
//! Asserts that `compile_with_demotion`, `MatcherSpec`, and `MatchCollector`
//! find identical matches across representative search queries and test
//! haystacks.

use grep_matcher::Matcher;
use grep_searcher::Searcher;
use veyyon_grep_kernel::{MatchCollector, MatcherSpec, RegexEngine, compile_with_demotion};

#[test]
fn compile_with_demotion_and_matcher_spec_agree() {
	let corpus: &[(&str, &[&str])] = &[
		("fn foo()", &["fn foo() -> i32 {", "let x = foo();", "bar()"]),
		("foo|bar", &["foo", "bar", "baz", "foobar"]),
		("(?<=a)b", &["ab", "cb", "bb", "a b"]),
		("^[0-9]+$", &["12345", "12a34", "0", ""]),
	];

	for &(pattern, lines) in corpus {
		let (demoted, _) = compile_with_demotion(pattern, false, false)
			.expect("compile_with_demotion should succeed");

		let spec = MatcherSpec {
			case_insensitive:     false,
			case_smart:           false,
			word:                 false,
			whole_line:           false,
			fixed_strings:        false,
			dot_matches_new_line: false,
			crlf:                 false,
			unicode:              true,
			multi_line:           true,
			line_terminator:      Some(b'\n'),
		};
		let spec_matcher = spec
			.build_matcher(&[pattern.to_string()], RegexEngine::Auto)
			.expect("spec matcher should build");

		for &line in lines {
			let bytes = line.as_bytes();
			let mut demoted_spans = Vec::new();
			let mut spec_spans = Vec::new();

			let _ = demoted.find_iter(bytes, |mat| {
				demoted_spans.push((mat.start(), mat.end()));
				true
			});
			let _ = spec_matcher.find_iter(bytes, |mat| {
				spec_spans.push((mat.start(), mat.end()));
				true
			});

			assert_eq!(
				demoted_spans, spec_spans,
				"demoted and spec matchers disagree on pattern '{pattern}' for line '{line}'"
			);
		}
	}
}

#[test]
fn compile_with_demotion_falls_back_to_literal() {
	let pattern = "(?[a";
	let (matcher, fallback) = compile_with_demotion(pattern, false, false)
		.expect("compile_with_demotion should succeed via fallback");

	assert!(fallback.is_some());

	let line = b"this has (?[a in text\n";
	let mut spans = Vec::new();
	let _ = matcher.find_iter(line, |mat| {
		spans.push((mat.start(), mat.end()));
		true
	});
	assert_eq!(spans, vec![(9, 13)]);
}

#[test]
fn match_collector_gathers_expected_counts() {
	let pattern = "test";
	let (matcher, _) =
		compile_with_demotion(pattern, false, false).expect("valid regex should compile");

	let mut collector = MatchCollector::new(None, 0, None, true);
	let mut searcher = Searcher::new();

	let haystack = b"first test line\nsecond line\nthird test with test\n";
	let result = searcher.search_slice(&matcher, haystack, &mut collector);
	assert!(result.is_ok());

	assert_eq!(collector.match_count, 2);
	assert_eq!(collector.collected_count, 2);
	assert_eq!(collector.matches.len(), 2);
}
