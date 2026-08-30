//! A list one row is chosen from.
//!
//! Ten surfaces in this product are this shape: the model picker, the theme
//! picker, the session picker, history search, the copy picker, the queue mode
//! selector, the effort picker, the skill list, the provider login list and the
//! account list. They differ in what fills the rows and in nothing else.

use crate::view::Badge;

/// A list of rows, one or several of which can be chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickList {
	pub title:    String,
	/// The filter text, when the list filters as it is typed into. `None` means
	/// the list does not filter, which is not the same as an empty query.
	pub query:    Option<String>,
	pub rows:     Vec<PickRow>,
	/// Index into `rows` that is highlighted. Out of range when `rows` is empty,
	/// which is why every reader goes through [`PickList::highlighted`].
	pub selected: usize,
	/// True when several rows can be chosen at once.
	pub multi:    bool,
	/// What the surface has to say when there is nothing to choose from.
	pub empty:    String,
	/// One line under the list: a keybinding, a caveat, a count.
	pub footer:   Option<String>,
}

impl PickList {
	pub fn new(title: impl Into<String>, rows: Vec<PickRow>) -> PickList {
		PickList {
			title: title.into(),
			query: None,
			rows,
			selected: 0,
			multi: false,
			empty: "Nothing to choose from".to_owned(),
			footer: None,
		}
	}

	/// The text the list is filtered by.
	pub fn query(mut self, query: impl Into<String>) -> PickList {
		self.query = Some(query.into());
		self
	}

	/// Which row the highlight is on. Out of range is allowed: it is the state a
	/// session that dropped a row leaves behind, and [`PickList::highlighted`]
	/// is what absorbs it.
	pub fn highlight(mut self, selected: usize) -> PickList {
		self.selected = selected;
		self
	}

	/// A list that takes more than one answer.
	pub fn multi(mut self) -> PickList {
		self.multi = true;
		self
	}

	/// The highlighted row, or `None` when the list is empty or the index is
	/// past its end. A renderer never indexes `rows` directly: a stale index
	/// arriving from a session that has since dropped a row would panic the
	/// window.
	pub fn highlighted(&self) -> Option<&PickRow> {
		self.rows.get(self.selected)
	}

	/// Rows the operator has checked, in list order. Empty for a single-choice
	/// list, where the highlight is the answer.
	pub fn checked(&self) -> impl Iterator<Item = &PickRow> {
		self.rows.iter().filter(|row| row.checked)
	}
}

/// One row in a [`PickList`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickRow {
	/// Reported back when the row is chosen. Never displayed.
	pub value:    String,
	pub label:    String,
	/// A second line, or a right-hand column when it is short.
	pub detail:   Option<String>,
	pub badges:   Vec<Badge>,
	/// True when the row is shown and cannot be chosen. A row that should not be
	/// shown is left out of `rows` instead.
	pub disabled: bool,
	/// True when the row is ticked in a multiple-choice list.
	pub checked:  bool,
}

impl PickRow {
	pub fn new(value: impl Into<String>, label: impl Into<String>) -> PickRow {
		PickRow {
			value:    value.into(),
			label:    label.into(),
			detail:   None,
			badges:   Vec::new(),
			disabled: false,
			checked:  false,
		}
	}

	pub fn detail(mut self, detail: impl Into<String>) -> PickRow {
		self.detail = Some(detail.into());
		self
	}

	pub fn badge(mut self, badge: Badge) -> PickRow {
		self.badges.push(badge);
		self
	}

	pub fn disabled(mut self) -> PickRow {
		self.disabled = true;
		self
	}

	pub fn checked(mut self) -> PickRow {
		self.checked = true;
		self
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! `selected` is an index into a list that a session owns, so it arrives
	//! from outside and can point past the end — a row dropped between the
	//! frame being built and the window drawing it. Indexing directly would
	//! panic the window, which is why the accessor exists and why it is the
	//! thing asserted.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a renderer uses the accessor. That is a
	//! review question and a capture, not a test.

	use super::*;

	#[test]
	fn a_highlight_past_the_end_reads_as_nothing() {
		let mut list = PickList::new("Models", vec![PickRow::new("a", "A")]);
		assert_eq!(list.highlighted().map(|row| row.value.as_str()), Some("a"));

		list.selected = 9;
		assert_eq!(list.highlighted(), None);

		list.rows.clear();
		list.selected = 0;
		assert_eq!(list.highlighted(), None);
	}

	#[test]
	fn checked_rows_come_back_in_list_order() {
		let list = PickList {
			multi: true,
			..PickList::new("Tools", vec![
				PickRow::new("read", "read").checked(),
				PickRow::new("write", "write"),
				PickRow::new("bash", "bash").checked(),
			])
		};
		let checked: Vec<&str> = list.checked().map(|row| row.value.as_str()).collect();
		assert_eq!(checked, ["read", "bash"]);
	}
}
