//! SQL. Case-insensitive keywords, single-quoted literals with doubled-quote
//! escapes, and both comment forms.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_sql(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);

	while !s.is_eof() {
		let start = s.pos;

		if s.starts_with("--") {
			s.eat_while(|c| c != '\n');
			out.push(start..s.pos, Token::Comment);
			continue;
		}

		if s.starts_with("/*") {
			s.advance(2);
			while !s.is_eof() {
				if s.starts_with("*/") {
					s.advance(2);
					break;
				}
				s.bump();
			}
			out.push(start..s.pos, Token::Comment);
			continue;
		}

		if s.starts_with("'") {
			s.advance(1);
			while !s.is_eof() {
				if s.starts_with("''") {
					s.advance(2);
				} else if s.starts_with("'") {
					s.advance(1);
					break;
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Str);
			continue;
		}

		if s.starts_with("\"") || s.starts_with("`") || s.starts_with("[") {
			let closer = match s.peek() {
				Some('\"') => '\"',
				Some('`') => '`',
				_ => ']',
			};
			s.advance(1);
			while !s.is_eof() {
				if s.peek() == Some(closer) {
					s.bump();
					break;
				}
				s.bump();
			}
			out.push(start..s.pos, Token::Type);
			continue;
		}

		if let Some(num_range) = scan_number_literal(&mut s) {
			out.push(num_range, Token::Number);
			continue;
		}

		if let Some(c) = s.peek()
			&& is_ident_start(c)
		{
			s.eat_while(is_ident_continue);
			let ident = &body[start..s.pos];

			if is_sql_keyword(ident) {
				out.push(start..s.pos, Token::Keyword);
				continue;
			}

			s.bump();
			continue;
		}

		s.bump();
	}
}

fn is_sql_keyword(s: &str) -> bool {
	matches!(
		s.to_ascii_uppercase().as_str(),
		"SELECT"
			| "FROM"
			| "WHERE"
			| "INSERT"
			| "INTO"
			| "VALUES"
			| "UPDATE"
			| "SET"
			| "DELETE"
			| "CREATE"
			| "DROP"
			| "ALTER"
			| "TABLE"
			| "VIEW"
			| "INDEX"
			| "JOIN"
			| "INNER"
			| "LEFT"
			| "RIGHT"
			| "FULL"
			| "OUTER"
			| "CROSS"
			| "ON" | "GROUP"
			| "BY" | "ORDER"
			| "HAVING"
			| "LIMIT"
			| "OFFSET"
			| "UNION"
			| "ALL"
			| "DISTINCT"
			| "AS" | "IN"
			| "IS" | "NULL"
			| "NOT"
			| "AND"
			| "OR" | "LIKE"
			| "ILIKE"
			| "BETWEEN"
			| "EXISTS"
			| "CASE"
			| "WHEN"
			| "THEN"
			| "ELSE"
			| "END"
			| "CAST"
			| "PRIMARY"
			| "KEY"
			| "FOREIGN"
			| "REFERENCES"
			| "DEFAULT"
			| "CHECK"
			| "UNIQUE"
			| "CONSTRAINT"
			| "CASCADE"
			| "WITH"
			| "BEGIN"
			| "COMMIT"
			| "ROLLBACK"
			| "TRANSACTION"
			| "GRANT"
			| "REVOKE"
			| "DATABASE"
			| "SCHEMA"
			| "COLUMN"
			| "ADD"
			| "TRUNCATE"
			| "SHOW"
			| "DESCRIBE"
			| "EXPLAIN"
			| "USE"
			| "TOP"
			| "ROW_NUMBER"
			| "OVER"
			| "PARTITION"
	)
}
