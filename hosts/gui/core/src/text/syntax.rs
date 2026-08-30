//! Colour spans for a fenced body, one scanner per language.
//!
//! The rules are lexical on purpose. A front end colours a body it received a
//! moment ago, in a language it may not have rules for, possibly truncated
//! mid-token, and it has to do it every frame the body is on screen. A lexer
//! that never looks past the character in front of it is total over arbitrary
//! input and cheap enough to run per frame; a parser is neither.
//!
//! Two rules hold across every language. A comment or a string dominates
//! anything inside it, and an unterminated one runs to the end of the body
//! rather than swallowing the scanner. Both are what a reader sees when a
//! message arrives half-written.

use std::ops::Range;

mod c;
mod diff;
mod go;
mod json;
mod markdown;
mod python;
mod rust;
mod scan;
mod shell;
mod sql;
mod toml;
mod typescript;
mod yaml;

use c::scan_c;
use diff::scan_diff;
use go::scan_go;
use json::scan_json;
use markdown::scan_markdown;
use python::scan_python;
use rust::scan_rust;
use scan::SpanCollector;
use shell::scan_shell;
use sql::scan_sql;
use toml::scan_toml;
use typescript::scan_typescript;
use yaml::scan_yaml;

/// What a run of code is coloured as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Token {
	/// Reserved language keywords.
	Keyword,
	/// Type names and definitions.
	Type,
	/// Function and method names or invocations.
	Function,
	/// String and character literals.
	Str,
	/// Numeric literals.
	Number,
	/// Source comments.
	Comment,
	/// Attributes, decorators, flags, and keys.
	Attribute,
	/// Punctuation and structural delimiters.
	Punct,
	/// Constants and literal values.
	Constant,
}

/// A language the lexer has rules for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
	/// The Rust programming language.
	Rust,
	/// TypeScript and JavaScript.
	TypeScript,
	/// The Python programming language.
	Python,
	/// The Go programming language.
	Go,
	/// POSIX and Bourne-compatible shells.
	Shell,
	/// JavaScript Object Notation.
	Json,
	/// Tom's Obvious Minimal Language.
	Toml,
	/// YAML Ain't Markup Language.
	Yaml,
	/// Structured Query Language.
	Sql,
	/// The C and C++ programming languages.
	C,
	/// Unified diff patches.
	Diff,
	/// Markdown document formatting.
	Markdown,
}

/// All supported languages in a fixed array.
pub const ALL: [Language; 12] = [
	Language::Rust,
	Language::TypeScript,
	Language::Python,
	Language::Go,
	Language::Shell,
	Language::Json,
	Language::Toml,
	Language::Yaml,
	Language::Sql,
	Language::C,
	Language::Diff,
	Language::Markdown,
];

impl Language {
	/// All supported languages in a fixed array.
	pub const ALL: [Language; 12] = ALL;
}

/// The language a fence's info string names, if the lexer has rules for it.
pub fn language(lang: &str) -> Option<Language> {
	let clean = lang.trim();
	if clean.is_empty() {
		return None;
	}
	let word = clean
		.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
		.next()
		.unwrap_or("");
	if word.is_empty() {
		return None;
	}
	let lower = word.to_ascii_lowercase();
	match lower.as_str() {
		"rust" | "rs" => Some(Language::Rust),
		"ts" | "tsx" | "typescript" | "js" | "jsx" | "javascript" | "mjs" | "cjs" => {
			Some(Language::TypeScript)
		},
		"py" | "python" | "python3" => Some(Language::Python),
		"go" | "golang" => Some(Language::Go),
		"sh" | "bash" | "zsh" | "shell" | "console" | "shellscript" => Some(Language::Shell),
		"json" | "jsonc" | "json5" => Some(Language::Json),
		"toml" | "ini" | "cfg" => Some(Language::Toml),
		"yaml" | "yml" => Some(Language::Yaml),
		"sql" | "postgres" | "postgresql" | "mysql" | "sqlite" => Some(Language::Sql),
		"c" | "h" | "cpp" | "cc" | "hpp" | "cxx" | "c++" | "objc" => Some(Language::C),
		"diff" | "patch" => Some(Language::Diff),
		"md" | "markdown" | "mdx" => Some(Language::Markdown),
		_ => None,
	}
}

/// Colour spans for a body, in ascending order, non-overlapping.
pub fn spans(lang: &str, body: &str) -> Vec<(Range<usize>, Token)> {
	match language(lang) {
		Some(l) => spans_of(l, body),
		None => Vec::new(),
	}
}

/// Colour spans for a body whose language is already resolved.
pub fn spans_of(language: Language, body: &str) -> Vec<(Range<usize>, Token)> {
	if body.is_empty() {
		return Vec::new();
	}
	let mut collector = SpanCollector::new();
	match language {
		Language::Rust => scan_rust(body, &mut collector),
		Language::TypeScript => scan_typescript(body, &mut collector),
		Language::Python => scan_python(body, &mut collector),
		Language::Go => scan_go(body, &mut collector),
		Language::Shell => scan_shell(body, &mut collector),
		Language::Json => scan_json(body, &mut collector),
		Language::Toml => scan_toml(body, &mut collector),
		Language::Yaml => scan_yaml(body, &mut collector),
		Language::Sql => scan_sql(body, &mut collector),
		Language::C => scan_c(body, &mut collector),
		Language::Diff => scan_diff(body, &mut collector),
		Language::Markdown => scan_markdown(body, &mut collector),
	}
	collector.finish(body.len())
}

#[cfg(test)]
mod tests;
