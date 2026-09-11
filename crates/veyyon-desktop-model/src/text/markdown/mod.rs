//! Markdown that is still arriving.
//!
//! A model writes markdown a few characters at a time, so every frame drawn
//! mid-turn is handed a prefix of a document rather than a document: a fence
//! with no closing fence, a table header with no delimiter row under it, a
//! list marker whose text has not arrived, a `**` with one word after it. A
//! reader handed that prefix reads what is there, which is why an arriving
//! table drew as a row of pipes and an arriving bold word drew its asterisks.
//!
//! Two answers live here, and neither is a reader:
//!
//! - [`mend`] closes what the prefix left open, so the prefix reads as the
//!   shape it is becoming. It only ever adds: no byte of the source is dropped,
//!   moved or rewritten.
//! - [`settled_prefix_len`] states how much of the source can no longer change
//!   shape, which is the boundary a surface draws separately so settled text is
//!   not laid out again when the next delta lands.
//!
//! Both are text in, text out, with no window and no block reader in them:
//! the reader that turns the mended text into blocks is the drawing kit's,
//! and the surface applies these two before handing it over.

mod mend;
mod veil;

pub use self::{
	mend::{OpenShape, mend, open_shapes},
	veil::settled_prefix_len,
};
