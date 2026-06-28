import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { stripFrontMatter, providerCommandDirs } from "../../utils/command-paths.js";

test("providerCommandDirs: claude reads .claude/commands/", () => {
  const home = os.homedir();
  const claude = providerCommandDirs("claude", "/proj");
  assert.equal(claude.userDir, path.join(home, ".claude", "commands"));
  assert.equal(claude.projectDir, path.join("/proj", ".claude", "commands"));
});

test("providerCommandDirs: opencode reads .opencode/commands/ and ~/.config/opencode/commands/", () => {
  const home = os.homedir();
  const oc = providerCommandDirs("opencode", "/proj");
  assert.equal(oc.userDir, path.join(home, ".config", "opencode", "commands"));
  assert.equal(oc.projectDir, path.join("/proj", ".opencode", "commands"));
});

test("providerCommandDirs: unknown provider falls back to claude layout", () => {
  const home = os.homedir();
  const fallback = providerCommandDirs("cursor", "/proj");
  assert.equal(fallback.userDir, path.join(home, ".claude", "commands"));
  assert.equal(fallback.projectDir, path.join("/proj", ".claude", "commands"));
});

test("providerCommandDirs: null project path yields null project dir", () => {
  const oc = providerCommandDirs("opencode", undefined);
  assert.equal(oc.projectDir, null);
  assert.equal(typeof oc.userDir, "string");
});

test("stripFrontMatter: returns body unchanged when no frontmatter", () => {
  const body = "# Title\n\nSome content.";
  assert.equal(stripFrontMatter(body), body);
});

test("stripFrontMatter: strips a well-formed frontmatter block", () => {
  const file = "---\ndescription: hi\nargument-hint: plain\n---\n# Title\nBody";
  assert.equal(stripFrontMatter(file), "# Title\nBody");
});

test("stripFrontMatter: strips a malformed frontmatter block (bracket-then-paren)", () => {
  // This is the exact pattern that crashed gray-matter/js-yaml in production.
  const file =
    "---\n" +
    "description: Quick commit\n" +
    "argument-hint: [target description] (blank = all changes)\n" +
    "---\n" +
    "# Smart Commit\n" +
    "Body here.";
  assert.equal(stripFrontMatter(file), "# Smart Commit\nBody here.");
});

test("stripFrontMatter: returns content unchanged when closing fence is missing", () => {
  const file = "---\ndescription: hi\nbody";
  assert.equal(stripFrontMatter(file), file);
});

test("stripFrontMatter: non-string input returns empty string", () => {
  assert.equal(stripFrontMatter(undefined), "");
  assert.equal(stripFrontMatter(null), "");
});

// Verify the actual failing files from the bug report parse via the fallback
// path (this does not exercise the route, only the fallback helper that the
// route uses when parseFrontMatter throws).
test("regression: prp-commit.md-style frontmatter is strippable", async () => {
  const sample =
    "---\n" +
    "description: Quick commit with natural language file targeting\n" +
    "argument-hint: [target description] (blank = all changes)\n" +
    "---\n" +
    "# Smart Commit\n" +
    "Create a git commit for the described target.";
  const stripped = stripFrontMatter(sample);
  assert.ok(stripped.startsWith("# Smart Commit"));
  assert.ok(!stripped.includes("argument-hint"));
});