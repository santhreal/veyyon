//! Sublime scope stack -> one of eleven semantic colour slots.
//!
//! The mapping is the whole reason this crate does not need a theme: a caller
//! supplies eleven ANSI strings and every scope any syntax can produce lands in
//! one of them, or in [`NO_COLOR`] for text that stays uncoloured.

use std::{cell::RefCell, collections::HashMap, sync::LazyLock};

use syntect::parsing::{Scope, ScopeStack};

/// Returned for a scope that matches no category. Callers render the text
/// without an escape sequence rather than picking a slot.
pub const NO_COLOR: usize = usize::MAX;

/// Palette slot indices. The numbering is the caller's contract: a palette is
/// an eleven-element array indexed by these.
pub const COMMENT: usize = 0;
pub const KEYWORD: usize = 1;
pub const FUNCTION: usize = 2;
pub const VARIABLE: usize = 3;
pub const STRING: usize = 4;
pub const NUMBER: usize = 5;
pub const TYPE: usize = 6;
pub const OPERATOR: usize = 7;
pub const PUNCTUATION: usize = 8;
pub const INSERTED: usize = 9;
pub const DELETED: usize = 10;

/// How many slots a palette has.
pub const SLOTS: usize = 11;

/// Pre-parsed scope prefixes, matched with [`Scope::is_prefix_of`].
struct ScopeMatchers {
	comment:               Scope,
	string:                Scope,
	constant_character:    Scope,
	meta_string:           Scope,
	constant_numeric:      Scope,
	constant_integer:      Scope,
	constant:              Scope,
	keyword:               Scope,
	storage_type:          Scope,
	storage_modifier:      Scope,
	entity_name_function:  Scope,
	support_function:      Scope,
	meta_function_call:    Scope,
	variable_function:     Scope,
	entity_name_type:      Scope,
	support_type:          Scope,
	support_class:         Scope,
	entity_name_class:     Scope,
	entity_name_struct:    Scope,
	entity_name_enum:      Scope,
	entity_name_interface: Scope,
	entity_name_trait:     Scope,
	keyword_operator:      Scope,
	punctuation_accessor:  Scope,
	punctuation:           Scope,
	variable:              Scope,
	entity_name:           Scope,
	meta_path:             Scope,
	markup_inserted:       Scope,
	markup_deleted:        Scope,
	meta_diff_header:      Scope,
	meta_diff_range:       Scope,
}

/// Every selector here is a literal this crate owns, so a parse failure is a
/// bug in this file rather than in caller input.
fn scope(selector: &str) -> Scope {
	Scope::new(selector).expect("scope selector in this module must parse")
}

static MATCHERS: LazyLock<ScopeMatchers> = LazyLock::new(|| ScopeMatchers {
	comment:               scope("comment"),
	string:                scope("string"),
	constant_character:    scope("constant.character"),
	meta_string:           scope("meta.string"),
	constant_numeric:      scope("constant.numeric"),
	constant_integer:      scope("constant.integer"),
	constant:              scope("constant"),
	keyword:               scope("keyword"),
	storage_type:          scope("storage.type"),
	storage_modifier:      scope("storage.modifier"),
	entity_name_function:  scope("entity.name.function"),
	support_function:      scope("support.function"),
	meta_function_call:    scope("meta.function-call"),
	variable_function:     scope("variable.function"),
	entity_name_type:      scope("entity.name.type"),
	support_type:          scope("support.type"),
	support_class:         scope("support.class"),
	entity_name_class:     scope("entity.name.class"),
	entity_name_struct:    scope("entity.name.struct"),
	entity_name_enum:      scope("entity.name.enum"),
	entity_name_interface: scope("entity.name.interface"),
	entity_name_trait:     scope("entity.name.trait"),
	keyword_operator:      scope("keyword.operator"),
	punctuation_accessor:  scope("punctuation.accessor"),
	punctuation:           scope("punctuation"),
	variable:              scope("variable"),
	entity_name:           scope("entity.name"),
	meta_path:             scope("meta.path"),
	markup_inserted:       scope("markup.inserted"),
	markup_deleted:        scope("markup.deleted"),
	meta_diff_header:      scope("meta.diff.header"),
	meta_diff_range:       scope("meta.diff.range"),
});

thread_local! {
	/// Scope -> slot, per thread. A scope resolves to the same slot for the
	/// life of the process, and a highlight pass asks about the same handful of
	/// scopes on every line.
	static SCOPE_COLOR_CACHE: RefCell<HashMap<Scope, usize>> =
		RefCell::new(HashMap::with_capacity(256));
}

/// The slot for one scope, ignoring the stack it came from.
///
/// Order is behaviour, not preference: `comment` is tested before everything
/// because a commented-out string is a comment, and the diff slots are tested
/// before `string` so a `markup.inserted.diff` line does not read as content.
#[inline]
fn compute_scope_color(s: Scope) -> usize {
	let m = &*MATCHERS;

	if m.comment.is_prefix_of(s) {
		return COMMENT;
	}
	if m.markup_inserted.is_prefix_of(s) {
		return INSERTED;
	}
	if m.markup_deleted.is_prefix_of(s) {
		return DELETED;
	}
	if m.meta_diff_header.is_prefix_of(s) || m.meta_diff_range.is_prefix_of(s) {
		return KEYWORD;
	}
	if m.string.is_prefix_of(s)
		|| m.constant_character.is_prefix_of(s)
		|| m.meta_string.is_prefix_of(s)
	{
		return STRING;
	}
	if m.constant_numeric.is_prefix_of(s) || m.constant_integer.is_prefix_of(s) {
		return NUMBER;
	}
	if m.keyword.is_prefix_of(s)
		|| m.storage_type.is_prefix_of(s)
		|| m.storage_modifier.is_prefix_of(s)
	{
		return KEYWORD;
	}
	if m.entity_name_function.is_prefix_of(s)
		|| m.support_function.is_prefix_of(s)
		|| m.meta_function_call.is_prefix_of(s)
		|| m.variable_function.is_prefix_of(s)
	{
		return FUNCTION;
	}
	if m.entity_name_type.is_prefix_of(s)
		|| m.support_type.is_prefix_of(s)
		|| m.support_class.is_prefix_of(s)
		|| m.entity_name_class.is_prefix_of(s)
		|| m.entity_name_struct.is_prefix_of(s)
		|| m.entity_name_enum.is_prefix_of(s)
		|| m.entity_name_interface.is_prefix_of(s)
		|| m.entity_name_trait.is_prefix_of(s)
	{
		return TYPE;
	}
	if m.keyword_operator.is_prefix_of(s) || m.punctuation_accessor.is_prefix_of(s) {
		return OPERATOR;
	}
	if m.punctuation.is_prefix_of(s) {
		return PUNCTUATION;
	}
	if m.variable.is_prefix_of(s) || m.entity_name.is_prefix_of(s) || m.meta_path.is_prefix_of(s) {
		return VARIABLE;
	}
	// A constant that is neither numeric nor a character reads as a number
	// rather than as uncoloured text.
	if m.constant.is_prefix_of(s) {
		return NUMBER;
	}

	NO_COLOR
}

/// The slot for a scope stack: the innermost scope that maps to anything wins,
/// so `source.rust meta.function string.quoted` is a string and not a function.
#[inline]
pub fn scope_to_color_index(stack: &ScopeStack) -> usize {
	SCOPE_COLOR_CACHE.with(|cache| {
		let mut cache = cache.borrow_mut();
		for s in stack.as_slice().iter().rev() {
			let slot = *cache.entry(*s).or_insert_with(|| compute_scope_color(*s));
			if slot != NO_COLOR {
				return slot;
			}
		}
		NO_COLOR
	})
}
