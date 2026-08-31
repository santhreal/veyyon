import { describe, expect, it } from "bun:test";
import { parseGitignorePatterns } from "../src/glob";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	ADVISOR_TRANSCRIPT_PREFIX,
	ADVISOR_TRANSCRIPT_STEM,
	advisorTranscriptSlug,
	isAdvisorTranscriptName,
	isSessionBackupName,
	isSessionFileName,
	SESSION_BACKUP_EXTENSION,
	SESSION_FILE_EXTENSION,
	sessionBackupName,
	sessionBackupPrimaryName,
	sessionFileName,
	sessionFileStem,
} from "../src/session-file";

describe("isSessionFileName", () => {
	it("returns true for .jsonl file", () => {
		expect(isSessionFileName("session.jsonl")).toBe(true);
	});

	it("returns false for non-.jsonl file", () => {
		expect(isSessionFileName("session.txt")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isSessionFileName("")).toBe(false);
	});

	it("returns true for .jsonl at end only", () => {
		expect(isSessionFileName("session.jsonl.bak")).toBe(false);
	});
});

describe("sessionFileStem", () => {
	it("strips .jsonl extension", () => {
		expect(sessionFileStem("session.jsonl")).toBe("session");
	});

	it("returns unchanged when no .jsonl extension", () => {
		expect(sessionFileStem("session.txt")).toBe("session.txt");
	});

	it("handles empty string", () => {
		expect(sessionFileStem("")).toBe("");
	});
});

describe("sessionFileName", () => {
	it("appends .jsonl when not present", () => {
		expect(sessionFileName("session")).toBe("session.jsonl");
	});

	it("returns unchanged when .jsonl already present", () => {
		expect(sessionFileName("session.jsonl")).toBe("session.jsonl");
	});

	it("handles empty string", () => {
		expect(sessionFileName("")).toBe(".jsonl");
	});
});

describe("sessionBackupName", () => {
	it("creates backup name with string id", () => {
		expect(sessionBackupName("session.jsonl", "abc")).toBe("session.jsonl.abc.bak");
	});

	it("creates backup name with numeric id", () => {
		expect(sessionBackupName("session.jsonl", 42)).toBe("session.jsonl.42.bak");
	});
});

describe("isSessionBackupName", () => {
	it("returns true for .bak file", () => {
		expect(isSessionBackupName("session.jsonl.42.bak")).toBe(true);
	});

	it("returns false for non-.bak file", () => {
		expect(isSessionBackupName("session.jsonl")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isSessionBackupName("")).toBe(false);
	});
});

describe("sessionBackupPrimaryName", () => {
	it("extracts primary name from backup", () => {
		expect(sessionBackupPrimaryName("session.jsonl.42.bak")).toBe("session.jsonl");
	});

	it("extracts primary name with string id", () => {
		expect(sessionBackupPrimaryName("session.jsonl.abc.bak")).toBe("session.jsonl");
	});

	it("returns undefined for non-backup name", () => {
		expect(sessionBackupPrimaryName("session.jsonl")).toBeUndefined();
	});

	it("returns undefined when primary is not a session file", () => {
		expect(sessionBackupPrimaryName("session.txt.42.bak")).toBeUndefined();
	});

	it("returns undefined for backup without id", () => {
		expect(sessionBackupPrimaryName("session.jsonl..bak")).toBeUndefined();
	});
});

describe("ADVISOR_TRANSCRIPT constants", () => {
	it("ADVISOR_TRANSCRIPT_STEM is __advisor", () => {
		expect(ADVISOR_TRANSCRIPT_STEM).toBe("__advisor");
	});

	it("ADVISOR_TRANSCRIPT_FILENAME is __advisor.jsonl", () => {
		expect(ADVISOR_TRANSCRIPT_FILENAME).toBe("__advisor.jsonl");
	});

	it("ADVISOR_TRANSCRIPT_PREFIX is __advisor.", () => {
		expect(ADVISOR_TRANSCRIPT_PREFIX).toBe("__advisor.");
	});
});

describe("isAdvisorTranscriptName", () => {
	it("returns true for main advisor file", () => {
		expect(isAdvisorTranscriptName("__advisor.jsonl")).toBe(true);
	});

	it("returns true for advisor transcript with slug", () => {
		expect(isAdvisorTranscriptName("__advisor.myslug.jsonl")).toBe(true);
	});

	it("returns false for non-advisor session file", () => {
		expect(isAdvisorTranscriptName("session.jsonl")).toBe(false);
	});

	it("returns false for non-jsonl file", () => {
		expect(isAdvisorTranscriptName("__advisor.txt")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isAdvisorTranscriptName("")).toBe(false);
	});
});

describe("advisorTranscriptSlug", () => {
	it("returns empty string for main advisor file", () => {
		expect(advisorTranscriptSlug("__advisor.jsonl")).toBe("");
	});

	it("returns slug from advisor transcript name", () => {
		expect(advisorTranscriptSlug("__advisor.myslug.jsonl")).toBe("myslug");
	});

	it("returns slug with dots", () => {
		expect(advisorTranscriptSlug("__advisor.my.slug.jsonl")).toBe("my.slug");
	});
});

describe("SESSION_FILE_EXTENSION", () => {
	it("is .jsonl", () => {
		expect(SESSION_FILE_EXTENSION).toBe(".jsonl");
	});
});

describe("SESSION_BACKUP_EXTENSION", () => {
	it("is .bak", () => {
		expect(SESSION_BACKUP_EXTENSION).toBe(".bak");
	});
});

describe("parseGitignorePatterns", () => {
	it("returns empty for empty content", () => {
		expect(parseGitignorePatterns("", "/repo", "/repo")).toEqual([]);
	});

	it("returns empty for comments only", () => {
		expect(parseGitignorePatterns("# comment\n# another", "/repo", "/repo")).toEqual([]);
	});

	it("returns empty for negation patterns", () => {
		expect(parseGitignorePatterns("!important.txt", "/repo", "/repo")).toEqual([]);
	});

	it("handles simple file pattern", () => {
		const result = parseGitignorePatterns("node_modules", "/repo", "/repo");
		expect(result).toEqual(["**/node_modules", "**/node_modules/**"]);
	});

	it("handles trailing slash (directory pattern)", () => {
		const result = parseGitignorePatterns("dist/", "/repo", "/repo");
		expect(result).toEqual(["**/dist", "**/dist/**"]);
	});

	it("handles anchored pattern with leading slash", () => {
		const result = parseGitignorePatterns("/secret.txt", "/repo", "/repo");
		expect(result).toEqual(["secret.txt", "secret.txt/**"]);
	});

	it("handles pattern with path separator", () => {
		const result = parseGitignorePatterns("src/build", "/repo", "/repo");
		expect(result).toEqual(["src/build", "src/build/**"]);
	});

	it("skips empty lines", () => {
		const result = parseGitignorePatterns("\n\nnode_modules\n\n", "/repo", "/repo");
		expect(result).toEqual(["**/node_modules", "**/node_modules/**"]);
	});

	it("handles mixed patterns", () => {
		const result = parseGitignorePatterns("# comment\nnode_modules\n!keep\n/dist\n", "/repo", "/repo");
		expect(result).toContain("**/node_modules");
		expect(result).toContain("**/node_modules/**");
		expect(result).toContain("dist");
		expect(result).toContain("dist/**");
	});

	it("returns empty for pattern outside base dir", () => {
		const result = parseGitignorePatterns("/secret.txt", "/other", "/repo");
		expect(result).toEqual([]);
	});
});
