//! The colours a fenced block is drawn in.
//!
//! One colour per token kind the lexer emits, per appearance. The set is small
//! because the lexer's set is small: nine kinds, chosen so a reader can tell a
//! string from a comment from a name, and no more.
//!
//! These are the one thing a terminal theme file describes, so they are the one
//! thing it will supply when a theme file is read. Until then the values here
//! are the source, and there is no second format.

use gpui::Hsla;
use veyyon_gui_core::text::syntax::Token;

/// A colour per token kind.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Syntax {
	pub keyword:   Hsla,
	pub kind:      Hsla,
	pub function:  Hsla,
	pub string:    Hsla,
	pub number:    Hsla,
	pub comment:   Hsla,
	pub attribute: Hsla,
	pub punct:     Hsla,
	pub constant:  Hsla,
}

impl Syntax {
	/// The colour for one of the lexer's kinds.
	pub fn of(&self, token: Token) -> Hsla {
		match token {
			Token::Keyword => self.keyword,
			Token::Type => self.kind,
			Token::Function => self.function,
			Token::Str => self.string,
			Token::Number => self.number,
			Token::Comment => self.comment,
			Token::Attribute => self.attribute,
			Token::Punct => self.punct,
			Token::Constant => self.constant,
		}
	}

	/// Every colour in the set, for a sweep.
	pub fn all(&self) -> [(Token, Hsla); 9] {
		[
			(Token::Keyword, self.keyword),
			(Token::Type, self.kind),
			(Token::Function, self.function),
			(Token::Str, self.string),
			(Token::Number, self.number),
			(Token::Comment, self.comment),
			(Token::Attribute, self.attribute),
			(Token::Punct, self.punct),
			(Token::Constant, self.constant),
		]
	}
}

/// Dark. Hues are spread far enough apart to survive a small size, and the
/// saturation stays under the point where mono text starts to fringe.
pub static DARK: Syntax = Syntax {
	keyword:   Hsla { h: 0.86, s: 0.52, l: 0.72, a: 1.0 },
	kind:      Hsla { h: 0.13, s: 0.62, l: 0.70, a: 1.0 },
	function:  Hsla { h: 0.58, s: 0.62, l: 0.70, a: 1.0 },
	string:    Hsla { h: 0.30, s: 0.42, l: 0.62, a: 1.0 },
	number:    Hsla { h: 0.07, s: 0.60, l: 0.68, a: 1.0 },
	comment:   Hsla { h: 0.63, s: 0.08, l: 0.44, a: 1.0 },
	attribute: Hsla { h: 0.46, s: 0.40, l: 0.62, a: 1.0 },
	punct:     Hsla { h: 0.63, s: 0.06, l: 0.60, a: 1.0 },
	constant:  Hsla { h: 0.02, s: 0.58, l: 0.68, a: 1.0 },
};

/// Light. The same hues taken down in luminance and up in saturation, because a
/// pale colour on a near-white well is a smudge.
pub static LIGHT: Syntax = Syntax {
	keyword:   Hsla { h: 0.86, s: 0.56, l: 0.44, a: 1.0 },
	kind:      Hsla { h: 0.10, s: 0.68, l: 0.36, a: 1.0 },
	function:  Hsla { h: 0.60, s: 0.66, l: 0.42, a: 1.0 },
	string:    Hsla { h: 0.32, s: 0.52, l: 0.32, a: 1.0 },
	number:    Hsla { h: 0.05, s: 0.62, l: 0.42, a: 1.0 },
	comment:   Hsla { h: 0.63, s: 0.08, l: 0.52, a: 1.0 },
	attribute: Hsla { h: 0.48, s: 0.50, l: 0.34, a: 1.0 },
	punct:     Hsla { h: 0.63, s: 0.06, l: 0.44, a: 1.0 },
	constant:  Hsla { h: 0.01, s: 0.60, l: 0.44, a: 1.0 },
};
