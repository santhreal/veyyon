//! WHY THIS SUITE EXISTS.
//! One test per language, each asserting that the tokens a reader looks for
//! first are the ones the scanner produced: the keyword, the string, the
//! comment, the type, the punctuation. A scanner that colours nothing and a
//! scanner that colours everything both satisfy the shared invariants, and
//! neither is usable.
//!
//! WHAT IT DOES NOT CATCH. Whether the colour a token maps to reads well, and
//! whether the language's whole grammar is covered, which a lexical scanner
//! does not attempt.

use super::assert_invariants;
use crate::text::syntax::*;

#[test]
fn rust_spans_cover_keywords_types_functions_and_comments() {
	let body =
		"/// Doc comment\nfn calculate<'a, T>(val: &'a T) -> u64 {\n\tprintln!(\"{}\", 42u64);\n}";
	let res = spans_of(Language::Rust, body);
	assert_invariants(body, &res);

	let doc_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "/// Doc comment" && *t == Token::Comment);
	let fn_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "fn" && *t == Token::Keyword);
	let lt_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "'a" && *t == Token::Type);
	let mac_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "println!" && *t == Token::Function);
	let num_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "42u64" && *t == Token::Number);

	assert!(doc_s);
	assert!(fn_s);
	assert!(lt_s);
	assert!(mac_s);
	assert!(num_s);
}

#[test]
fn typescript_spans_cover_keywords_strings_types_and_regex() {
	let body = "import { Data } from './api';\nconst re = /[a-z]+/i;\nreturn null;\n";
	let res = spans_of(Language::TypeScript, body);
	assert_invariants(body, &res);

	let imp_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "import" && *t == Token::Keyword);
	let str_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "'./api'" && *t == Token::Str);
	let rex_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "/[a-z]+/i" && *t == Token::Str);
	let nul_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "null" && *t == Token::Constant);

	assert!(imp_s);
	assert!(str_s);
	assert!(rex_s);
	assert!(nul_s);
}

#[test]
fn python_spans_cover_decorators_def_keywords_and_constants() {
	let body = "@property\ndef is_active(self) -> bool:\n\treturn True\n";
	let res = spans_of(Language::Python, body);
	assert_invariants(body, &res);

	let dec_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "@property" && *t == Token::Attribute);
	let def_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "def" && *t == Token::Keyword);
	let fn_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "is_active" && *t == Token::Function);
	let slf_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "self" && *t == Token::Constant);
	let tru_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "True" && *t == Token::Constant);

	assert!(dec_s);
	assert!(def_s);
	assert!(fn_s);
	assert!(slf_s);
	assert!(tru_s);
}

#[test]
fn go_spans_cover_keywords_types_functions_and_runes() {
	let body = "package main\nfunc Run(name string, char rune) (int, error) {\n\treturn nil\n}\n";
	let res = spans_of(Language::Go, body);
	assert_invariants(body, &res);

	let pkg_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "package" && *t == Token::Keyword);
	let fnc_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "func" && *t == Token::Keyword);
	let str_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "string" && *t == Token::Type);
	let nil_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "nil" && *t == Token::Constant);

	assert!(pkg_s);
	assert!(fnc_s);
	assert!(str_s);
	assert!(nil_s);
}

#[test]
fn shell_spans_cover_commands_variables_and_flags() {
	let body = "echo \"Starting\"\ncargo build --release\nexport DEST=\"$OUT\"\n";
	let res = spans_of(Language::Shell, body);
	assert_invariants(body, &res);

	let ech_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "echo" && *t == Token::Function);
	let flg_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "--release" && *t == Token::Attribute);
	let var_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "\"$OUT\"" && *t == Token::Str);
	let exp_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "export" && *t == Token::Keyword);

	assert!(ech_s);
	assert!(flg_s);
	assert!(var_s);
	assert!(exp_s);
}

#[test]
fn json_spans_cover_keys_values_and_punctuation() {
	let body = "{\n\t\"key\": \"value\",\n\t\"count\": 10,\n\t\"valid\": true\n}";
	let res = spans_of(Language::Json, body);
	assert_invariants(body, &res);

	let key_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "\"key\"" && *t == Token::Attribute);
	let val_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "\"value\"" && *t == Token::Str);
	let num_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "10" && *t == Token::Number);
	let cst_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "true" && *t == Token::Constant);
	let pnc_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "{" && *t == Token::Punct);

	assert!(key_s);
	assert!(val_s);
	assert!(num_s);
	assert!(cst_s);
	assert!(pnc_s);
}

#[test]
fn toml_spans_cover_sections_attributes_and_numbers() {
	let body = "[server]\nport = 8080\nenabled = true\n";
	let res = spans_of(Language::Toml, body);
	assert_invariants(body, &res);

	let sec_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "[server]" && *t == Token::Type);
	let prt_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "port" && *t == Token::Attribute);
	let num_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "8080" && *t == Token::Number);
	let cst_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "true" && *t == Token::Constant);

	assert!(sec_s);
	assert!(prt_s);
	assert!(num_s);
	assert!(cst_s);
}

#[test]
fn yaml_spans_cover_keys_list_markers_and_scalars() {
	let body = "name: demo\nenabled: true\nitems:\n  - first\n";
	let res = spans_of(Language::Yaml, body);
	assert_invariants(body, &res);

	let key_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "name" && *t == Token::Attribute);
	let cst_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "true" && *t == Token::Constant);
	let mrk_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "-" && *t == Token::Punct);

	assert!(key_s);
	assert!(cst_s);
	assert!(mrk_s);
}

#[test]
fn sql_spans_cover_case_insensitive_keywords_and_strings() {
	let body = "SELECT * FROM users WHERE status = 'active';";
	let res = spans_of(Language::Sql, body);
	assert_invariants(body, &res);

	let sel_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "SELECT" && *t == Token::Keyword);
	let frm_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "FROM" && *t == Token::Keyword);
	let str_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "'active'" && *t == Token::Str);

	assert!(sel_s);
	assert!(frm_s);
	assert!(str_s);
}

#[test]
fn c_spans_cover_preprocessor_keywords_and_types() {
	let body = "#include <stdio.h>\nint main(void) {\n\tsize_t n = 0;\n\treturn 0;\n}";
	let res = spans_of(Language::C, body);
	assert_invariants(body, &res);

	let inc_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "#include <stdio.h>" && *t == Token::Attribute);
	let int_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "int" && *t == Token::Keyword);
	let typ_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "size_t" && *t == Token::Type);
	let ret_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "return" && *t == Token::Keyword);

	assert!(inc_s);
	assert!(int_s);
	assert!(typ_s);
	assert!(ret_s);
}

#[test]
fn diff_spans_cover_additions_deletions_and_headers() {
	let body = "--- a/old.txt\n+++ b/new.txt\n@@ -1,2 +1,2 @@\n-old line\n+new line\n";
	let res = spans_of(Language::Diff, body);
	assert_invariants(body, &res);

	let hdr_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "--- a/old.txt" && *t == Token::Comment);
	let hnk_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "@@ -1,2 +1,2 @@" && *t == Token::Attribute);
	let del_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "-old line" && *t == Token::Keyword);
	let add_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "+new line" && *t == Token::Function);

	assert!(hdr_s);
	assert!(hnk_s);
	assert!(del_s);
	assert!(add_s);
}

#[test]
fn markdown_spans_cover_headings_code_bold_and_links() {
	let body = "# Title\n\nInline `code` and **strong** text with [target](https://example.com).\n";
	let res = spans_of(Language::Markdown, body);
	assert_invariants(body, &res);

	let hd_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "# Title" && *t == Token::Keyword);
	let cd_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "`code`" && *t == Token::Str);
	let bd_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "**strong**" && *t == Token::Type);
	let lk_s = res
		.iter()
		.any(|(r, t)| &body[r.clone()] == "(https://example.com)" && *t == Token::Attribute);

	assert!(hd_s);
	assert!(cd_s);
	assert!(bd_s);
	assert!(lk_s);
}
