//! WHY THIS SUITE EXISTS.
//! This suite verifies syntax highlighting token spans across all supported
//! languages. It tests that spans are strictly monotonic, non-overlapping,
//! non-empty, and bounded. It checks that comment and string tokens
//! dominate inner keywords and terminate gracefully.
//!
//! WHAT IT DOES NOT CATCH.
//! It does not perform full abstract syntax tree semantic analysis or scope
//! resolution. It does not validate grammar syntax correctness for invalid
//! code snippets.

mod each_language;

use super::*;

fn assert_invariants(body: &str, spans: &[(Range<usize>, Token)]) {
	let mut prev_end = 0usize;
	for (range, _) in spans {
		assert!(range.start < range.end, "span must be non-empty: {}..{}", range.start, range.end);
		assert!(
			range.start >= prev_end,
			"spans must not overlap or regress: prev_end={}, start={}",
			prev_end,
			range.start
		);
		assert!(
			range.end <= body.len(),
			"span exceeds body len: end={}, len={}",
			range.end,
			body.len()
		);
		assert!(body.is_char_boundary(range.start), "start is not char boundary: {}", range.start);
		assert!(body.is_char_boundary(range.end), "end is not char boundary: {}", range.end);
		prev_end = range.end;
	}
}

fn language_sample(lang: Language) -> &'static str {
	match lang {
		Language::Rust => "// Rust\nfn total(items: &[Item]) -> u64 {\n\tlet mut s = 0u64;\n\ts\n}\n",
		Language::TypeScript => {
			"// TS\nexport async function load(url: string): Promise<Data> {\n\treturn null;\n}\n"
		},
		Language::Python => "# Python\ndef calc(scores: list[float]) -> float:\n\treturn 0.0\n",
		Language::Go => "// Go\nfunc Process(tasks []Task) error {\n\treturn nil\n}\n",
		Language::Shell => "# Shell\nif [ -f \"$FILE\" ]; then\n\techo \"ok\"\nfi\n",
		Language::Json => "{\n\t\"name\": \"gui\",\n\t\"v\": 1,\n\t\"ok\": true\n}\n",
		Language::Toml => "# TOML\n[package]\nname = \"gui\"\nversion = \"0.1.0\"\n",
		Language::Yaml => "# YAML\nversion: \"3\"\nservices:\n  web:\n    ports:\n      - \"80\"\n",
		Language::Sql => "-- SQL\nSELECT id, name\nFROM users\nWHERE active = 1\nLIMIT 10;\n",
		Language::C => "// C\n#include <stdio.h>\nint main(void) {\n\treturn 0;\n}\n",
		Language::Diff => "--- a/old.rs\n+++ b/new.rs\n@@ -1,1 +1,1 @@\n-fn old() {}\n+fn new() {}\n",
		Language::Markdown => "# Head\n\n**bold** `code` [link](https://example.com)\n- item\n",
	}
}

#[test]
fn every_language_variant_is_accounted_for_in_all_and_satisfies_all_invariants() {
	assert_eq!(ALL.len(), 12);
	for lang in ALL {
		match lang {
			Language::Rust
			| Language::TypeScript
			| Language::Python
			| Language::Go
			| Language::Shell
			| Language::Json
			| Language::Toml
			| Language::Yaml
			| Language::Sql
			| Language::C
			| Language::Diff
			| Language::Markdown => {},
		}

		let sample = language_sample(lang);
		let result = spans_of(lang, sample);
		assert_invariants(sample, &result);
	}
}

#[test]
fn language_name_resolution_matches_known_aliases() {
	assert_eq!(language("rust"), Some(Language::Rust));
	assert_eq!(language("RS"), Some(Language::Rust));
	assert_eq!(language("typescript"), Some(Language::TypeScript));
	assert_eq!(language("ts"), Some(Language::TypeScript));
	assert_eq!(language("tsx"), Some(Language::TypeScript));
	assert_eq!(language("js"), Some(Language::TypeScript));
	assert_eq!(language("python"), Some(Language::Python));
	assert_eq!(language("py"), Some(Language::Python));
	assert_eq!(language("go"), Some(Language::Go));
	assert_eq!(language("golang"), Some(Language::Go));
	assert_eq!(language("sh"), Some(Language::Shell));
	assert_eq!(language("bash"), Some(Language::Shell));
	assert_eq!(language("json"), Some(Language::Json));
	assert_eq!(language("toml"), Some(Language::Toml));
	assert_eq!(language("yaml"), Some(Language::Yaml));
	assert_eq!(language("sql"), Some(Language::Sql));
	assert_eq!(language("c"), Some(Language::C));
	assert_eq!(language("cpp"), Some(Language::C));
	assert_eq!(language("diff"), Some(Language::Diff));
	assert_eq!(language("markdown"), Some(Language::Markdown));
	assert_eq!(language("unknown_lang"), None);
	assert_eq!(language(""), None);
}

#[test]
fn strings_and_comments_dominate_inner_keywords() {
	let body = "\"fn let mut struct\"\n// fn let mut\n/* fn let */\n";
	let res = spans_of(Language::Rust, body);
	assert_invariants(body, &res);

	for (_, token) in &res {
		assert!(*token == Token::Str || *token == Token::Comment);
	}
}

#[test]
fn unterminated_markers_run_to_end_of_file_without_panicking() {
	let unclosed_str = "let x = \"unclosed string without end";
	let res_str = spans_of(Language::Rust, unclosed_str);
	assert_invariants(unclosed_str, &res_str);
	assert!(
		res_str
			.iter()
			.any(|(r, t)| *t == Token::Str && r.end == unclosed_str.len())
	);

	let unclosed_block = "/* unclosed block comment";
	let res_block = spans_of(Language::Rust, unclosed_block);
	assert_invariants(unclosed_block, &res_block);
	assert!(
		res_block
			.iter()
			.any(|(r, t)| *t == Token::Comment && r.end == unclosed_block.len())
	);

	let unclosed_raw = "r###\"unclosed raw string";
	let res_raw = spans_of(Language::Rust, unclosed_raw);
	assert_invariants(unclosed_raw, &res_raw);
	assert!(
		res_raw
			.iter()
			.any(|(r, t)| *t == Token::Str && r.end == unclosed_raw.len())
	);

	let unclosed_tpl = "`start of template ${ 1 + 2 } rest of template";
	let res_tpl = spans_of(Language::TypeScript, unclosed_tpl);
	assert_invariants(unclosed_tpl, &res_tpl);
}

#[test]
fn plain_identifiers_and_whitespace_produce_no_spans() {
	let plain = "   foo_bar   baz_qux   regular_variable   ";
	let res = spans_of(Language::Rust, plain);
	assert!(res.is_empty(), "expected empty spans for plain identifiers");
}

#[test]
fn adversarial_inputs_terminate_and_maintain_character_boundary_invariants() {
	let empty = "";
	let res = spans_of(Language::Rust, empty);
	assert!(res.is_empty());

	let quote_only = "\"";
	let res = spans_of(Language::Rust, quote_only);
	assert_invariants(quote_only, &res);

	let slash_star_only = "/*";
	let res = spans_of(Language::Rust, slash_star_only);
	assert_invariants(slash_star_only, &res);

	let multibyte = "// 日本語コメント\nlet 変数 = \"テキスト 🦀\";\n/* коммент \u{1F980} */\n";
	let res = spans_of(Language::Rust, multibyte);
	assert_invariants(multibyte, &res);

	let crlf = "fn main() {\r\n\tlet x = 1;\r\n\t// comment\r\n}\r\n";
	let res = spans_of(Language::Rust, crlf);
	assert_invariants(crlf, &res);

	let long_line = format!("fn long_{}() {{ let x = {}; }}\n", "a".repeat(20_000), 123);
	let res = spans_of(Language::Rust, &long_line);
	assert_invariants(&long_line, &res);

	let alternating = "\"".repeat(5000);
	let res = spans_of(Language::Rust, &alternating);
	assert_invariants(&alternating, &res);
}
