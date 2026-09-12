//! Runtime enumeration tests for ast language tables, summary matchers,
//! and expando configurations.

use std::{collections::HashSet, path::Path};

use ast_grep_core::{Language, tree_sitter::LanguageExt};
use veyyon_ast::{
	SupportLang,
	summary::{SummaryOptions, summarize_code},
};

#[test]
fn test_all_languages_enumerated_and_valid() {
	let langs = SupportLang::all_langs();
	assert!(!langs.is_empty(), "all_langs must not be empty");
	assert_eq!(langs.len(), 57, "must support all 57 languages");

	let mut seen_names = HashSet::new();

	for lang in langs {
		let name = lang.to_string();
		assert!(!name.is_empty(), "Display name must not be empty for {lang:?}");
		assert!(seen_names.insert(name.clone()), "duplicate Display name for {lang:?}");

		// Verify tree-sitter language initializes correctly
		let ts_lang = lang.get_ts_language();
		assert!(ts_lang.node_kind_count() > 0, "node_kind_count must be > 0 for {lang:?}");

		// Verify expando char is one of the valid set
		let expando = lang.expando_char();
		assert!(
			matches!(expando, '$' | '_' | 'z' | '𐀀' | 'µ'),
			"invalid expando char {expando:?} for {lang:?}"
		);

		// Verify pre_process_pattern works on variable patterns
		let processed = lang.pre_process_pattern("foo($BAR, $$$BAZ)");
		assert!(!processed.is_empty());

		// Verify alias lookup
		let alias_lang = SupportLang::from_alias(&name.to_lowercase());
		assert_eq!(
			alias_lang,
			Some(*lang),
			"from_alias must resolve lowercase display name for {lang:?}"
		);

		// Verify summarization doesn't panic on minimal snippet
		let summary_res = summarize_code(SummaryOptions {
			code:               "fn test() { let x = 1; }\n".to_string(),
			lang:               Some(name.to_lowercase()),
			path:               None,
			min_body_lines:     None,
			min_comment_lines:  None,
			unfold_until_lines: None,
			unfold_limit_lines: None,
		});
		assert!(summary_res.is_ok(), "summarize_code must succeed for {lang:?}");
	}
}

#[test]
fn test_language_expando_character_classes() {
	// Languages requiring Linear B syllable '𐀀' (C-family identifiers)
	for lang in [SupportLang::C, SupportLang::Cpp, SupportLang::Fortran, SupportLang::ObjC] {
		assert_eq!(lang.expando_char(), '𐀀', "{lang:?} must use Linear B expando");
	}

	// Languages requiring underscore '_'
	for lang in [SupportLang::Css, SupportLang::Nix] {
		assert_eq!(lang.expando_char(), '_', "{lang:?} must use underscore expando");
	}

	// HTML requiring ASCII letter 'z'
	assert_eq!(SupportLang::Html.expando_char(), 'z', "Html must use 'z' expando");

	// Stub languages accepting '$' directly in grammar
	for lang in [
		SupportLang::Astro,
		SupportLang::Bash,
		SupportLang::Clojure,
		SupportLang::Java,
		SupportLang::JavaScript,
		SupportLang::Json,
		SupportLang::Lua,
		SupportLang::Scala,
		SupportLang::Solidity,
		SupportLang::Svelte,
		SupportLang::Tsx,
		SupportLang::TypeScript,
		SupportLang::Vue,
		SupportLang::Yaml,
		SupportLang::Markdown,
		SupportLang::Toml,
		SupportLang::Diff,
		SupportLang::Xml,
		SupportLang::Regex,
		SupportLang::Dart,
		SupportLang::EmacsLisp,
		SupportLang::Graphql,
	] {
		assert_eq!(lang.expando_char(), '$', "{lang:?} must use '$' stub expando");
	}

	// Expando languages requiring micro sign 'µ'
	for lang in [
		SupportLang::CSharp,
		SupportLang::Cmake,
		SupportLang::Dockerfile,
		SupportLang::Elixir,
		SupportLang::Erlang,
		SupportLang::Go,
		SupportLang::Haskell,
		SupportLang::Hcl,
		SupportLang::Ini,
		SupportLang::Just,
		SupportLang::Kotlin,
		SupportLang::Ocaml,
		SupportLang::Php,
		SupportLang::Powershell,
		SupportLang::Proto,
		SupportLang::Python,
		SupportLang::R,
		SupportLang::Ruby,
		SupportLang::Rust,
		SupportLang::Sql,
		SupportLang::Swift,
		SupportLang::Make,
		SupportLang::Starlark,
		SupportLang::Odin,
		SupportLang::Julia,
		SupportLang::Verilog,
		SupportLang::Zig,
		SupportLang::Tlaplus,
	] {
		assert_eq!(lang.expando_char(), 'µ', "{lang:?} must use 'µ' expando");
	}
}

#[test]
fn test_language_aliases_resolution() {
	for alias in SupportLang::sorted_aliases() {
		let resolved = SupportLang::from_alias(alias);
		assert!(resolved.is_some(), "sorted_alias '{alias}' must resolve to a valid SupportLang");
	}
}

#[test]
fn test_language_from_path_resolution() {
	let test_cases = [
		("src/main.rs", SupportLang::Rust),
		("app.ts", SupportLang::TypeScript),
		("component.tsx", SupportLang::Tsx),
		("script.js", SupportLang::JavaScript),
		("module.py", SupportLang::Python),
		("server.go", SupportLang::Go),
		("Main.java", SupportLang::Java),
		("file.c", SupportLang::C),
		("file.cpp", SupportLang::Cpp),
		("style.css", SupportLang::Css),
		("page.html", SupportLang::Html),
		("data.json", SupportLang::Json),
		("config.yaml", SupportLang::Yaml),
		("config.toml", SupportLang::Toml),
		("script.sh", SupportLang::Bash),
		("script.ps1", SupportLang::Powershell),
		("Makefile", SupportLang::Make),
		("Dockerfile", SupportLang::Dockerfile),
	];

	for (file_path, expected_lang) in test_cases {
		let resolved = SupportLang::from_path(Path::new(file_path));
		assert_eq!(
			resolved,
			Some(expected_lang),
			"from_path({file_path}) must resolve to {expected_lang:?}"
		);
	}
}
