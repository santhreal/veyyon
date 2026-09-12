//! Vendored and extended language definitions for ast-grep integration.
//!
//! Originally derived from `ast-grep-language` v0.39.9, stripped of
//! serde/ignore machinery, and extended with additional languages.

use std::{borrow::Cow, collections::HashMap, fmt, path::Path, sync::LazyLock};

use ast_grep_core::{
	Doc, Language, Node,
	matcher::{KindMatcher, Pattern, PatternBuilder, PatternError},
	tree_sitter::{LanguageExt, StrDoc, TSLanguage, TSRange},
};
use phf::phf_map;

fn pre_process_pattern(expando: char, query: &str) -> Cow<'_, str> {
	let mut ret = Vec::with_capacity(query.len());
	let mut dollar_count = 0;
	for c in query.chars() {
		if c == '$' {
			dollar_count += 1;
			continue;
		}
		let need_replace = matches!(c, 'A'..='Z' | '_') || dollar_count == 3;
		let sigil = if need_replace { expando } else { '$' };
		ret.extend(std::iter::repeat_n(sigil, dollar_count));
		dollar_count = 0;
		ret.push(c);
	}
	let sigil = if dollar_count == 3 { expando } else { '$' };
	ret.extend(std::iter::repeat_n(sigil, dollar_count));
	Cow::Owned(ret.into_iter().collect())
}

impl Language for SupportLang {
	fn kind_to_id(&self, kind: &str) -> u16 {
		self.get_ts_language().id_for_node_kind(kind, true)
	}

	fn field_to_id(&self, field: &str) -> Option<u16> {
		self
			.get_ts_language()
			.field_id_for_name(field)
			.map(|f| f.get())
	}

	fn expando_char(&self) -> char {
		match self {
			Self::C | Self::Cpp | Self::Fortran | Self::ObjC => '𐀀',
			Self::Css | Self::Nix => '_',
			Self::Html => 'z',
			Self::Astro
			| Self::Bash
			| Self::Clojure
			| Self::Java
			| Self::JavaScript
			| Self::Json
			| Self::Lua
			| Self::Scala
			| Self::Solidity
			| Self::Svelte
			| Self::Tsx
			| Self::TypeScript
			| Self::Vue
			| Self::Yaml
			| Self::Markdown
			| Self::Toml
			| Self::Diff
			| Self::Xml
			| Self::Regex
			| Self::Dart
			| Self::EmacsLisp
			| Self::Graphql => '$',
			_ => 'µ',
		}
	}

	fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
		let expando = self.expando_char();
		if expando == '$' {
			Cow::Borrowed(query)
		} else {
			pre_process_pattern(expando, query)
		}
	}

	fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
		builder.build(|src| StrDoc::try_new(src, *self))
	}

	fn from_path<P: AsRef<Path>>(path: P) -> Option<Self> {
		from_extension(path.as_ref())
	}
}

impl LanguageExt for SupportLang {
	fn get_ts_language(&self) -> TSLanguage {
		match self {
			Self::Astro => tree_sitter_astro::LANGUAGE.into(),
			Self::Bash => tree_sitter_bash::LANGUAGE.into(),
			Self::C => tree_sitter_c::LANGUAGE.into(),
			Self::Cmake => tree_sitter_cmake::LANGUAGE.into(),
			Self::Cpp => tree_sitter_cpp::LANGUAGE.into(),
			Self::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
			Self::Dart => tree_sitter_dart::LANGUAGE.into(),
			Self::Clojure => tree_sitter_clojure::LANGUAGE.into(),
			Self::Css => tree_sitter_css::LANGUAGE.into(),
			Self::Diff => tree_sitter_diff::LANGUAGE.into(),
			Self::Dockerfile => tree_sitter_dockerfile::language(),
			Self::EmacsLisp => tree_sitter_elisp::LANGUAGE.into(),
			Self::Elixir => tree_sitter_elixir::LANGUAGE.into(),
			Self::Erlang => tree_sitter_erlang::LANGUAGE.into(),
			Self::Fortran => tree_sitter_fortran::LANGUAGE.into(),
			Self::Go => tree_sitter_go::LANGUAGE.into(),
			Self::Graphql => tree_sitter_graphql::LANGUAGE.into(),
			Self::Haskell => tree_sitter_haskell::LANGUAGE.into(),
			Self::Hcl => tree_sitter_hcl::LANGUAGE.into(),
			Self::Html => tree_sitter_html::LANGUAGE.into(),
			Self::Ini => tree_sitter_ini::LANGUAGE.into(),
			Self::Java => tree_sitter_java::LANGUAGE.into(),
			Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
			Self::Json => tree_sitter_json::LANGUAGE.into(),
			Self::Just => tree_sitter_just::LANGUAGE.into(),
			Self::Julia => tree_sitter_julia::LANGUAGE.into(),
			Self::Kotlin => tree_sitter_kotlin::LANGUAGE.into(),
			Self::Lua => tree_sitter_lua::LANGUAGE.into(),
			Self::Make => tree_sitter_make::LANGUAGE.into(),
			Self::Markdown => tree_sitter_md::LANGUAGE.into(),
			Self::Nix => tree_sitter_nix::LANGUAGE.into(),
			Self::ObjC => tree_sitter_objc::LANGUAGE.into(),
			Self::Ocaml => tree_sitter_ocaml::LANGUAGE_OCAML.into(),
			Self::Odin => tree_sitter_odin::LANGUAGE.into(),
			Self::Php => tree_sitter_php::LANGUAGE_PHP_ONLY.into(),
			Self::Powershell => tree_sitter_powershell::LANGUAGE.into(),
			Self::Proto => tree_sitter_proto::LANGUAGE.into(),
			Self::Python => tree_sitter_python::LANGUAGE.into(),
			Self::R => tree_sitter_r::LANGUAGE.into(),
			Self::Regex => tree_sitter_regex::LANGUAGE.into(),
			Self::Ruby => tree_sitter_ruby::LANGUAGE.into(),
			Self::Rust => tree_sitter_rust::LANGUAGE.into(),
			Self::Scala => tree_sitter_scala::LANGUAGE.into(),
			Self::Solidity => tree_sitter_solidity::LANGUAGE.into(),
			Self::Sql => tree_sitter_sql::LANGUAGE.into(),
			Self::Starlark => tree_sitter_starlark::LANGUAGE.into(),
			Self::Svelte => tree_sitter_svelte::LANGUAGE.into(),
			Self::Swift => tree_sitter_swift::LANGUAGE.into(),
			Self::Toml => tree_sitter_toml_ng::LANGUAGE.into(),
			Self::Tlaplus => tree_sitter_tlaplus::LANGUAGE.into(),
			Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
			Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
			Self::Verilog => tree_sitter_verilog::LANGUAGE.into(),
			Self::Vue => tree_sitter_vue::LANGUAGE.into(),
			Self::Xml => tree_sitter_xml::LANGUAGE_XML.into(),
			Self::Yaml => tree_sitter_yaml::LANGUAGE.into(),
			Self::Zig => tree_sitter_zig::LANGUAGE.into(),
		}
	}

	fn injectable_languages(&self) -> Option<&'static [&'static str]> {
		match self {
			Self::Html => Some(&["css", "js", "ts", "tsx", "scss", "less", "stylus", "coffee"]),
			_ => None,
		}
	}

	fn extract_injections<L: LanguageExt>(
		&self,
		root: Node<StrDoc<L>>,
	) -> HashMap<String, Vec<TSRange>> {
		match self {
			Self::Html => extract_html_injections(root),
			_ => HashMap::new(),
		}
	}
}
fn extract_html_injections<L: LanguageExt>(root: Node<StrDoc<L>>) -> HashMap<String, Vec<TSRange>> {
	let lang = root.lang();
	let mut map = HashMap::new();
	let matcher = KindMatcher::new("script_element", lang.clone());
	for script in root.find_all(matcher) {
		let injected = find_html_lang(&script).unwrap_or_else(|| "js".into());
		let content = script.children().find(|c| c.kind() == "raw_text");
		if let Some(content) = content {
			map.entry(injected)
				.or_insert_with(Vec::new)
				.push(node_to_range(&content));
		}
	}
	let matcher = KindMatcher::new("style_element", lang.clone());
	for style in root.find_all(matcher) {
		let injected = find_html_lang(&style).unwrap_or_else(|| "css".into());
		let content = style.children().find(|c| c.kind() == "raw_text");
		if let Some(content) = content {
			map.entry(injected)
				.or_insert_with(Vec::new)
				.push(node_to_range(&content));
		}
	}
	map
}

fn find_html_lang<D: Doc>(node: &Node<D>) -> Option<String> {
	let html = node.lang();
	let attr_matcher = KindMatcher::new("attribute", html.clone());
	let name_matcher = KindMatcher::new("attribute_name", html.clone());
	let val_matcher = KindMatcher::new("attribute_value", html.clone());
	node.find_all(attr_matcher).find_map(|attr| {
		let name = attr.find(&name_matcher)?;
		if name.text() != "lang" {
			return None;
		}
		let val = attr.find(&val_matcher)?;
		Some(val.text().to_string())
	})
}

fn node_to_range<D: Doc>(node: &Node<D>) -> TSRange {
	let r = node.range();
	let start = node.start_pos();
	let sp = start.byte_point();
	let sp = tree_sitter::Point::new(sp.0, sp.1);
	let end = node.end_pos();
	let ep = end.byte_point();
	let ep = tree_sitter::Point::new(ep.0, ep.1);
	TSRange { start_byte: r.start, end_byte: r.end, start_point: sp, end_point: ep }
}
// ── SupportLang enum ────────────────────────────────────────────────────

/// All supported languages for ast-grep structural search/replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SupportLang {
	Astro,
	Bash,
	C,
	Cmake,
	Cpp,
	CSharp,
	Dart,
	Clojure,
	Css,
	Diff,
	Dockerfile,
	EmacsLisp,
	Elixir,
	Erlang,
	Fortran,
	Go,
	Graphql,
	Haskell,
	Hcl,
	Html,
	Ini,
	Java,
	JavaScript,
	Json,
	Just,
	Julia,
	Kotlin,
	Lua,
	Make,
	Markdown,
	Nix,
	ObjC,
	Ocaml,
	Odin,
	Php,
	Powershell,
	Proto,
	Python,
	R,
	Regex,
	Ruby,
	Rust,
	Scala,
	Solidity,
	Sql,
	Starlark,
	Svelte,
	Swift,
	Toml,
	Tlaplus,
	Tsx,
	TypeScript,
	Verilog,
	Vue,
	Xml,
	Yaml,
	Zig,
}

static SORTED_ALIASES: LazyLock<Box<[&'static str]>> = LazyLock::new(|| {
	let mut aliases = LANG_ALIASES.keys().copied().collect::<Box<[_]>>();
	aliases.sort_unstable();
	aliases
});

impl SupportLang {
	pub const fn all_langs() -> &'static [Self] {
		use SupportLang::*;
		&[
			Astro, Bash, C, Cmake, Cpp, CSharp, Dart, Clojure, Css, Diff, Dockerfile, EmacsLisp,
			Elixir, Erlang, Fortran, Go, Graphql, Haskell, Hcl, Html, Ini, Java, JavaScript, Json,
			Just, Julia, Kotlin, Lua, Make, Markdown, Nix, ObjC, Ocaml, Odin, Php, Powershell, Proto,
			Python, R, Regex, Ruby, Rust, Scala, Solidity, Sql, Starlark, Svelte, Swift, Toml,
			Tlaplus, Tsx, TypeScript, Verilog, Vue, Xml, Yaml, Zig,
		]
	}

	/// The canonical lowercase name used as a stable key in alias maps,
	/// file-type inference results, and error messages.
	pub const fn canonical_name(self) -> &'static str {
		match self {
			Self::Astro => "astro",
			Self::Bash => "bash",
			Self::C => "c",
			Self::Cmake => "cmake",
			Self::Cpp => "cpp",
			Self::CSharp => "csharp",
			Self::Dart => "dart",
			Self::Clojure => "clojure",
			Self::Css => "css",
			Self::Diff => "diff",
			Self::Dockerfile => "dockerfile",
			Self::EmacsLisp => "emacs-lisp",
			Self::Elixir => "elixir",
			Self::Erlang => "erlang",
			Self::Fortran => "fortran",
			Self::Go => "go",
			Self::Graphql => "graphql",
			Self::Haskell => "haskell",
			Self::Hcl => "hcl",
			Self::Html => "html",
			Self::Ini => "ini",
			Self::Java => "java",
			Self::JavaScript => "javascript",
			Self::Json => "json",
			Self::Just => "just",
			Self::Julia => "julia",
			Self::Kotlin => "kotlin",
			Self::Lua => "lua",
			Self::Make => "make",
			Self::Markdown => "markdown",
			Self::Nix => "nix",
			Self::ObjC => "objc",
			Self::Ocaml => "ocaml",
			Self::Odin => "odin",
			Self::Php => "php",
			Self::Powershell => "powershell",
			Self::Proto => "protobuf",
			Self::Python => "python",
			Self::R => "r",
			Self::Regex => "regex",
			Self::Ruby => "ruby",
			Self::Rust => "rust",
			Self::Scala => "scala",
			Self::Solidity => "solidity",
			Self::Sql => "sql",
			Self::Starlark => "starlark",
			Self::Svelte => "svelte",
			Self::Swift => "swift",
			Self::Toml => "toml",
			Self::Tlaplus => "tlaplus",
			Self::Tsx => "tsx",
			Self::TypeScript => "typescript",
			Self::Verilog => "verilog",
			Self::Vue => "vue",
			Self::Xml => "xml",
			Self::Yaml => "yaml",
			Self::Zig => "zig",
		}
	}

	pub fn from_alias(value: &str) -> Option<Self> {
		let lowered = value.trim().to_ascii_lowercase();
		LANG_ALIASES.get(lowered.as_str()).copied()
	}

	pub fn from_path(path: &Path) -> Option<Self> {
		from_extension(path)
	}

	pub fn sorted_aliases() -> &'static [&'static str] {
		&SORTED_ALIASES
	}
}

impl fmt::Display for SupportLang {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{self:?}")
	}
}

// ── File extension mapping ──────────────────────────────────────────────

const fn extensions(lang: SupportLang) -> &'static [&'static str] {
	use SupportLang::*;
	match lang {
		Astro => &["astro"],
		Bash => {
			&["bash", "bats", "cgi", "command", "env", "fcgi", "ksh", "sh", "tmux", "tool", "zsh"]
		},
		C => &["c", "h"],
		Cmake => &["cmake"],
		Cpp => &["cc", "hpp", "cpp", "c++", "hh", "cxx", "cu", "ino"],
		CSharp => &["cs"],
		Dart => &["dart"],
		Clojure => &["clj", "cljs", "cljc", "edn"],
		Css => &["css", "scss"],
		Diff => &["diff", "patch"],
		Dockerfile => &["dockerfile"],
		EmacsLisp => &["el"],
		Elixir => &["ex", "exs"],
		Erlang => &["erl", "hrl"],
		Fortran => &["f90", "F90", "f95", "F95", "f03", "F03", "f08", "F08"],
		Go => &["go"],
		Graphql => &["graphql", "gql"],
		Haskell => &["hs"],
		Hcl => &["hcl", "tf", "tfvars"],
		Html => &["html", "htm", "xhtml"],
		Ini => &["ini", "cfg", "conf", "properties"],
		Java => &["java"],
		JavaScript => &["cjs", "js", "mjs", "jsx"],
		Json => &["json"],
		Just => &[],
		Julia => &["jl"],
		Kotlin => &["kt", "ktm", "kts"],
		Lua => &["lua"],
		Make => &["mk", "mak"],
		Markdown => &["md", "markdown", "mdx"],
		Nix => &["nix"],
		ObjC => &["m"],
		Ocaml => &["ml"],
		Odin => &["odin"],
		Php => &["php"],
		Powershell => &["ps1", "psm1"],
		Proto => &["proto"],
		Python => &["py", "py3", "pyi", "bzl"],
		R => &["r"],
		Regex => &[],
		Ruby => &["rb", "rbw", "gemspec"],
		Rust => &["rs"],
		Scala => &["scala", "sc", "sbt"],
		Solidity => &["sol"],
		Sql => &["sql"],
		Starlark => &["star", "bzl"],
		Svelte => &["svelte"],
		Swift => &["swift"],
		Toml => &["toml"],
		Tlaplus => &["tla"],
		Tsx => &["tsx"],
		TypeScript => &["ts", "cts", "mts"],
		Verilog => &["v", "sv", "svh", "vh"],
		Vue => &["vue"],
		Xml => &["xml", "xsl", "xslt", "svg", "plist"],
		Yaml => &["yaml", "yml"],
		Zig => &["zig"],
	}
}

/// Guess language from file extension.
fn from_extension(path: &Path) -> Option<SupportLang> {
	let name = path.file_name()?.to_str()?;
	if name == "Makefile" || name == "makefile" || name == "GNUmakefile" {
		return Some(SupportLang::Make);
	}
	if name == "Justfile" || name == "justfile" {
		return Some(SupportLang::Just);
	}
	if name == "CMakeLists.txt" {
		return Some(SupportLang::Cmake);
	}
	if name == "Dockerfile"
		|| name == "dockerfile"
		|| name.starts_with("Dockerfile.")
		|| name.starts_with("dockerfile.")
		|| name == "Containerfile"
		|| name == "containerfile"
	{
		return Some(SupportLang::Dockerfile);
	}
	if name == ".emacs" {
		return Some(SupportLang::EmacsLisp);
	}

	// Extensionless shell rc/profile files. `Path::extension` returns `None`
	// for both bare (`zshrc`) and dotfile (`.zshrc`) forms, so they would
	// otherwise resolve to no language and disable block-aware ops on them.
	let stem = name.strip_prefix('.').unwrap_or(name);
	if matches!(
		stem,
		"zshrc"
			| "zshenv"
			| "zprofile"
			| "zlogin"
			| "zlogout"
			| "zsh_aliases"
			| "bashrc"
			| "bash_profile"
			| "bash_login"
			| "bash_logout"
			| "bash_aliases"
			| "profile"
			| "kshrc"
			| "mkshrc"
			| "shrc"
	) {
		return Some(SupportLang::Bash);
	}

	let ext = path.extension()?.to_str()?;
	SupportLang::all_langs()
		.iter()
		.copied()
		.find(|&l| extensions(l).contains(&ext))
}

static LANG_ALIASES: phf::Map<&'static str, SupportLang> = phf_map! {
"astro"          => SupportLang::Astro,
"bash"           => SupportLang::Bash,
"sh"             => SupportLang::Bash,
"zsh"            => SupportLang::Bash,
"ksh"            => SupportLang::Bash,
"bats"           => SupportLang::Bash,
"c"              => SupportLang::C,
"h"              => SupportLang::C,
"cmake"          => SupportLang::Cmake,
"cpp"            => SupportLang::Cpp,
"c++"            => SupportLang::Cpp,
"cc"             => SupportLang::Cpp,
"cxx"            => SupportLang::Cpp,
"hh"             => SupportLang::Cpp,
"hpp"            => SupportLang::Cpp,
"cu"             => SupportLang::Cpp,
"ino"            => SupportLang::Cpp,
"csharp"         => SupportLang::CSharp,
"c#"             => SupportLang::CSharp,
"cs"             => SupportLang::CSharp,
"dart"           => SupportLang::Dart,
"css"            => SupportLang::Css,
"clj"            => SupportLang::Clojure,
"cljc"           => SupportLang::Clojure,
"cljs"           => SupportLang::Clojure,
"clojure"        => SupportLang::Clojure,
"clojurescript"  => SupportLang::Clojure,
"edn"            => SupportLang::Clojure,
"diff"           => SupportLang::Diff,
"patch"          => SupportLang::Diff,
"docker"         => SupportLang::Dockerfile,
"dockerfile"     => SupportLang::Dockerfile,
"containerfile"  => SupportLang::Dockerfile,
"emacs-lisp"     => SupportLang::EmacsLisp,
"emacslisp"      => SupportLang::EmacsLisp,
"elisp"          => SupportLang::EmacsLisp,
"el"             => SupportLang::EmacsLisp,
"elixir"         => SupportLang::Elixir,
"ex"             => SupportLang::Elixir,
"exs"            => SupportLang::Elixir,
"erlang"         => SupportLang::Erlang,
"erl"            => SupportLang::Erlang,
"hrl"            => SupportLang::Erlang,
"fortran"        => SupportLang::Fortran,
"f90"            => SupportLang::Fortran,
"f95"            => SupportLang::Fortran,
"f03"            => SupportLang::Fortran,
"f08"            => SupportLang::Fortran,
"go"             => SupportLang::Go,
"golang"         => SupportLang::Go,
"graphql"        => SupportLang::Graphql,
"gql"            => SupportLang::Graphql,
"haskell"        => SupportLang::Haskell,
"hs"             => SupportLang::Haskell,
"hcl"            => SupportLang::Hcl,
"tf"             => SupportLang::Hcl,
"tfvars"         => SupportLang::Hcl,
"terraform"      => SupportLang::Hcl,
"html"           => SupportLang::Html,
"htm"            => SupportLang::Html,
"xhtml"          => SupportLang::Html,
"ini"            => SupportLang::Ini,
"cfg"            => SupportLang::Ini,
"conf"           => SupportLang::Ini,
"config"         => SupportLang::Ini,
"properties"     => SupportLang::Ini,
"java"           => SupportLang::Java,
"javascript"     => SupportLang::JavaScript,
"js"             => SupportLang::JavaScript,
"jsx"            => SupportLang::JavaScript,
"mjs"            => SupportLang::JavaScript,
"cjs"            => SupportLang::JavaScript,
"json"           => SupportLang::Json,
"just"           => SupportLang::Just,
"justfile"       => SupportLang::Just,
"julia"          => SupportLang::Julia,
"jl"             => SupportLang::Julia,
"kotlin"         => SupportLang::Kotlin,
"kt"             => SupportLang::Kotlin,
"kts"            => SupportLang::Kotlin,
"ktm"            => SupportLang::Kotlin,
"lua"            => SupportLang::Lua,
"make"           => SupportLang::Make,
"makefile"       => SupportLang::Make,
"gnumake"        => SupportLang::Make,
"mk"             => SupportLang::Make,
"mak"            => SupportLang::Make,
"markdown"       => SupportLang::Markdown,
"md"             => SupportLang::Markdown,
"mdx"            => SupportLang::Markdown,
"nix"            => SupportLang::Nix,
"objc"           => SupportLang::ObjC,
"obj-c"          => SupportLang::ObjC,
"objective-c"    => SupportLang::ObjC,
"m"              => SupportLang::ObjC,
"mm"             => SupportLang::ObjC,
"ocaml"          => SupportLang::Ocaml,
"ml"             => SupportLang::Ocaml,
"odin"           => SupportLang::Odin,
"php"            => SupportLang::Php,
"powershell"     => SupportLang::Powershell,
"ps1"            => SupportLang::Powershell,
"psm1"           => SupportLang::Powershell,
"protobuf"       => SupportLang::Proto,
"proto"          => SupportLang::Proto,
"python"         => SupportLang::Python,
"py"             => SupportLang::Python,
"py3"            => SupportLang::Python,
"pyi"            => SupportLang::Python,
"r"              => SupportLang::R,
"regex"          => SupportLang::Regex,
"re"             => SupportLang::Regex,
"ruby"           => SupportLang::Ruby,
"rb"             => SupportLang::Ruby,
"rbw"            => SupportLang::Ruby,
"gemspec"        => SupportLang::Ruby,
"rust"           => SupportLang::Rust,
"rs"             => SupportLang::Rust,
"scala"          => SupportLang::Scala,
"sc"             => SupportLang::Scala,
"sbt"            => SupportLang::Scala,
"solidity"       => SupportLang::Solidity,
"sol"            => SupportLang::Solidity,
"sql"            => SupportLang::Sql,
"starlark"       => SupportLang::Starlark,
"star"           => SupportLang::Starlark,
"bzl"            => SupportLang::Starlark,
"bazel"          => SupportLang::Starlark,
"skylark"        => SupportLang::Starlark,
"svelte"         => SupportLang::Svelte,
"swift"          => SupportLang::Swift,
"toml"           => SupportLang::Toml,
"tla"            => SupportLang::Tlaplus,
"tla+"           => SupportLang::Tlaplus,
"tlaplus"        => SupportLang::Tlaplus,
"pluscal"        => SupportLang::Tlaplus,
"pcal"           => SupportLang::Tlaplus,
"tsx"            => SupportLang::Tsx,
"typescript"     => SupportLang::TypeScript,
"ts"             => SupportLang::TypeScript,
"mts"            => SupportLang::TypeScript,
"cts"            => SupportLang::TypeScript,
"verilog"        => SupportLang::Verilog,
"systemverilog"  => SupportLang::Verilog,
"sv"             => SupportLang::Verilog,
"svh"            => SupportLang::Verilog,
"vh"             => SupportLang::Verilog,
"v"              => SupportLang::Verilog,
"vue"            => SupportLang::Vue,
"xml"            => SupportLang::Xml,
"xsl"            => SupportLang::Xml,
"xslt"           => SupportLang::Xml,
"svg"            => SupportLang::Xml,
"plist"          => SupportLang::Xml,
"yaml"           => SupportLang::Yaml,
"yml"            => SupportLang::Yaml,
"zig"            => SupportLang::Zig,
};
