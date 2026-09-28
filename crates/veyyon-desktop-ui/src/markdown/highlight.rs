//! Syntax highlighting of code blocks onto the theme's syntax roles.
//!
//! One `SyntaxSet`, syntect's bundled default syntaxes, loads on first use.
//! Scopes map onto [`SyntaxRole`]s, which the palette colors; no syntect theme
//! is involved. Results are cached by the hash of the code and its language
//! in a bounded LRU. Parser state is also kept after the last complete line
//! of each recent code string, so a code block that grows by appended text
//! resumes from there and parses only the lines after it.

use std::{
	hash::{DefaultHasher, Hash, Hasher},
	ops::Range,
	sync::{Arc, LazyLock, Mutex, PoisonError},
};

use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};
use veyyon_gpui::Hsla;

use crate::theme::Syntax;

/// Highlight results kept, most recently used last.
const RESULTS: usize = 64;
/// Resumable parser states kept, most recently stored last.
const CHECKPOINTS: usize = 8;

/// The syntax class of a span of code; each is a role of the palette's
/// `syntax` table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SyntaxRole {
	Keyword,
	String,
	Number,
	Comment,
	Function,
	TypeName,
	Constant,
	Variable,
	Operator,
	Punctuation,
	Tag,
	Attribute,
}

impl SyntaxRole {
	/// The palette color of this role.
	pub const fn color(self, syntax: &Syntax) -> Hsla {
		match self {
			Self::Keyword => syntax.keyword,
			Self::String => syntax.string,
			Self::Number => syntax.number,
			Self::Comment => syntax.comment,
			Self::Function => syntax.function,
			Self::TypeName => syntax.type_name,
			Self::Constant => syntax.constant,
			Self::Variable => syntax.variable,
			Self::Operator => syntax.operator,
			Self::Punctuation => syntax.punctuation,
			Self::Tag => syntax.tag,
			Self::Attribute => syntax.attribute,
		}
	}
}

/// Scope prefixes and the role each maps to. For each scope, innermost
/// first, the first matching prefix wins, so a specific prefix precedes a
/// general one.
const RULES: &[(&str, SyntaxRole)] = &[
	("comment", SyntaxRole::Comment),
	("punctuation.definition.comment", SyntaxRole::Comment),
	("punctuation.definition.string", SyntaxRole::String),
	("string", SyntaxRole::String),
	("markup.raw", SyntaxRole::String),
	("constant.numeric", SyntaxRole::Number),
	("constant", SyntaxRole::Constant),
	("variable.language", SyntaxRole::Constant),
	("support.constant", SyntaxRole::Constant),
	("keyword.operator", SyntaxRole::Operator),
	("keyword", SyntaxRole::Keyword),
	("storage", SyntaxRole::Keyword),
	("markup.heading", SyntaxRole::Keyword),
	("entity.name.function", SyntaxRole::Function),
	("support.function", SyntaxRole::Function),
	("variable.function", SyntaxRole::Function),
	("entity.name.tag", SyntaxRole::Tag),
	("entity.other.attribute-name", SyntaxRole::Attribute),
	("meta.annotation", SyntaxRole::Attribute),
	("meta.attribute", SyntaxRole::Attribute),
	("entity.name", SyntaxRole::TypeName),
	("entity.other.inherited-class", SyntaxRole::TypeName),
	("support.type", SyntaxRole::TypeName),
	("support.class", SyntaxRole::TypeName),
	("variable", SyntaxRole::Variable),
	("punctuation", SyntaxRole::Punctuation),
];

/// Fence tags that name a bundled syntax by another word. Tags without a
/// bundled syntax of their own borrow the closest one.
const ALIASES: &[(&str, &str)] = &[
	("typescript", "js"),
	("ts", "js"),
	("tsx", "js"),
	("jsx", "js"),
	("mjs", "js"),
	("cjs", "js"),
	("shell", "sh"),
	("console", "sh"),
	("zsh", "sh"),
	("golang", "go"),
	("jsonc", "json"),
	("json5", "json"),
	("patch", "diff"),
	("c++", "cpp"),
	("py3", "py"),
];

/// The highlighted spans of one code string.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Highlighted {
	spans:      Vec<(Range<usize>, SyntaxRole)>,
	resumed_at: usize,
}

impl Highlighted {
	/// The byte ranges of the code with a role, in order and disjoint. Bytes
	/// outside every span are plain text.
	pub fn spans(&self) -> &[(Range<usize>, SyntaxRole)] {
		&self.spans
	}

	/// The byte offset parsing began at: 0 for a fresh parse, or the end of
	/// the last complete line of an earlier, shorter version of the code.
	pub const fn resumed_at(&self) -> usize {
		self.resumed_at
	}

	/// The role of the byte at `offset`, or `None` for plain text.
	pub fn role_at(&self, offset: usize) -> Option<SyntaxRole> {
		let index = self.spans.partition_point(|(range, _)| range.end <= offset);
		self
			.spans
			.get(index)
			.filter(|(range, _)| range.start <= offset)
			.map(|&(_, role)| role)
	}
}

/// The bundled syntax a fence tag names, as the syntax's display name.
///
/// The tag is matched case-insensitively against file extensions, then
/// syntax names. `None` for an unknown tag and for plain text.
pub fn resolve_language(tag: &str) -> Option<&'static str> {
	syntax_for(tag).map(|syntax| syntax.name.as_str())
}

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);

static SCOPES: LazyLock<Vec<(Scope, SyntaxRole)>> = LazyLock::new(|| {
	RULES
		.iter()
		.filter_map(|&(prefix, role)| Scope::new(prefix).ok().map(|scope| (scope, role)))
		.collect()
});

static PLAIN: LazyLock<Arc<Highlighted>> = LazyLock::new(Arc::default);

fn syntax_for(tag: &str) -> Option<&'static SyntaxReference> {
	let tag = tag.trim().to_ascii_lowercase();
	let token = ALIASES
		.iter()
		.find(|(alias, _)| *alias == tag)
		.map_or(tag.as_str(), |(_, to)| to);
	let set: &'static SyntaxSet = &SYNTAXES;
	let syntax = set.find_syntax_by_token(token)?;
	(syntax.name != set.find_syntax_plain_text().name).then_some(syntax)
}

/// Highlights `code` in the language its fence tag names.
///
/// Unknown and absent languages return no spans. A cached result for the
/// same code and language is returned without parsing. Otherwise parsing
/// resumes from the longest cached line-aligned prefix of `code`.
pub fn highlight(code: &str, lang: Option<&str>) -> Arc<Highlighted> {
	let Some(syntax) = lang.and_then(syntax_for) else {
		return PLAIN.clone();
	};
	let key = Key { hash: hash(code), len: code.len(), syntax: syntax.name.as_str() };
	let resume = {
		let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
		if let Some(hit) = cache.hit(key) {
			return hit;
		}
		cache.take_checkpoint(key.syntax, code)
	};
	let (result, checkpoint) = run(code, syntax, resume);
	let result = Arc::new(result);
	CACHE
		.lock()
		.unwrap_or_else(PoisonError::into_inner)
		.store(key, &result, checkpoint);
	result
}

/// The result [`highlight`] returns for `code` and `lang`, looked up in the
/// cache without parsing.
///
/// Unknown and absent languages return the plain result, as [`highlight`]
/// does. `None` when the code has not been highlighted in that language or
/// its result has left the cache.
pub fn cached(code: &str, lang: Option<&str>) -> Option<Arc<Highlighted>> {
	let Some(syntax) = lang.and_then(syntax_for) else {
		return Some(PLAIN.clone());
	};
	let key = Key { hash: hash(code), len: code.len(), syntax: syntax.name.as_str() };
	CACHE
		.lock()
		.unwrap_or_else(PoisonError::into_inner)
		.hit(key)
}

fn hash(text: &str) -> u64 {
	let mut hasher = DefaultHasher::new();
	text.hash(&mut hasher);
	hasher.finish()
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Key {
	hash:   u64,
	len:    usize,
	syntax: &'static str,
}

/// Parser state after the last complete line of a code string.
struct Checkpoint {
	syntax: &'static str,
	/// Length of the line-aligned prefix the state follows.
	len:    usize,
	hash:   u64,
	state:  ParseState,
	stack:  ScopeStack,
	spans:  Vec<(Range<usize>, SyntaxRole)>,
}

struct Cache {
	results:     Vec<(Key, Arc<Highlighted>)>,
	checkpoints: Vec<Checkpoint>,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache { results: Vec::new(), checkpoints: Vec::new() });

impl Cache {
	fn hit(&mut self, key: Key) -> Option<Arc<Highlighted>> {
		let at = self.results.iter().position(|(cached, _)| *cached == key)?;
		let entry = self.results.remove(at);
		let result = entry.1.clone();
		self.results.push(entry);
		Some(result)
	}

	/// Removes and returns the checkpoint of the longest line-aligned prefix
	/// of `code` in `syntax`.
	fn take_checkpoint(&mut self, syntax: &str, code: &str) -> Option<Checkpoint> {
		let cut = complete_len(code);
		let at = self
			.checkpoints
			.iter()
			.enumerate()
			.filter(|(_, point)| point.syntax == syntax && point.len <= cut)
			.filter(|(_, point)| {
				code
					.get(..point.len)
					.is_some_and(|prefix| hash(prefix) == point.hash)
			})
			.max_by_key(|(_, point)| point.len)
			.map(|(at, _)| at)?;
		Some(self.checkpoints.remove(at))
	}

	fn store(&mut self, key: Key, result: &Arc<Highlighted>, checkpoint: Option<Checkpoint>) {
		if self.results.len() >= RESULTS {
			self.results.remove(0);
		}
		self.results.push((key, result.clone()));
		if let Some(checkpoint) = checkpoint {
			self
				.checkpoints
				.retain(|point| point.syntax != checkpoint.syntax || point.hash != checkpoint.hash);
			if self.checkpoints.len() >= CHECKPOINTS {
				self.checkpoints.remove(0);
			}
			self.checkpoints.push(checkpoint);
		}
	}
}

/// The length of `code` up to and including its last newline.
fn complete_len(code: &str) -> usize {
	code.rfind('\n').map_or(0, |newline| newline + 1)
}

/// Parses `code` from `resume`, or from the start. Returns the spans and the
/// state after the last complete line. A line the syntax fails on ends
/// highlighting there; the rest of the code is plain.
fn run(
	code: &str,
	syntax: &'static SyntaxReference,
	resume: Option<Checkpoint>,
) -> (Highlighted, Option<Checkpoint>) {
	let set: &'static SyntaxSet = &SYNTAXES;
	let cut = complete_len(code);
	let (mut state, mut stack, mut spans, resumed_at) = match resume {
		Some(point) => (point.state, point.stack, point.spans, point.len),
		None => (ParseState::new(syntax), ScopeStack::new(), Vec::new(), 0),
	};
	let mut at = resumed_at;
	for line in code[resumed_at..cut].split_inclusive('\n') {
		if parse_line(line, at, set, &mut state, &mut stack, &mut spans).is_none() {
			return (Highlighted { spans, resumed_at }, None);
		}
		at += line.len();
	}
	let checkpoint = Checkpoint {
		syntax: syntax.name.as_str(),
		len:    cut,
		hash:   hash(&code[..cut]),
		state:  state.clone(),
		stack:  stack.clone(),
		spans:  spans.clone(),
	};
	if cut < code.len() {
		// The incomplete last line is parsed on a copy; the checkpoint stays
		// at the line boundary.
		let _ = parse_line(&code[cut..], cut, set, &mut state, &mut stack, &mut spans);
	}
	(Highlighted { spans, resumed_at }, Some(checkpoint))
}

fn parse_line(
	line: &str,
	base: usize,
	set: &SyntaxSet,
	state: &mut ParseState,
	stack: &mut ScopeStack,
	spans: &mut Vec<(Range<usize>, SyntaxRole)>,
) -> Option<()> {
	let ops = state.parse_line(line, set).ok()?;
	let mut from = 0;
	for (to, op) in ops {
		push_span(spans, (base + from)..(base + to), role_of(stack));
		stack.apply(&op).ok()?;
		from = to;
	}
	push_span(spans, (base + from)..(base + line.len()), role_of(stack));
	Some(())
}

fn role_of(stack: &ScopeStack) -> Option<SyntaxRole> {
	let rules: &[(Scope, SyntaxRole)] = &SCOPES;
	stack.as_slice().iter().rev().find_map(|&scope| {
		rules
			.iter()
			.find(|(prefix, _)| prefix.is_prefix_of(scope))
			.map(|&(_, role)| role)
	})
}

fn push_span(
	spans: &mut Vec<(Range<usize>, SyntaxRole)>,
	range: Range<usize>,
	role: Option<SyntaxRole>,
) {
	let Some(role) = role else {
		return;
	};
	if range.is_empty() {
		return;
	}
	if let Some((last, last_role)) = spans.last_mut() {
		let contiguous = last.end == range.start;
		if contiguous && *last_role == role {
			last.end = range.end;
			return;
		}
	}
	spans.push((range, role));
}
