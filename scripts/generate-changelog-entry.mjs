#!/usr/bin/env node
// Builds a CHANGELOG.md section for one release by grouping commits since the
// previous tag by their Conventional Commits type (enforced by .githooks/commit-msg).
// Usage: node scripts/generate-changelog-entry.mjs <version> <prevTag|""> <date> <shortSha>

import { execFileSync } from "node:child_process";

const [version, prevTag, date, shortSha] = process.argv.slice(2);

const US = "\x1f"; // unit separator between subject/body
const RS = "\x1e"; // record separator between commits

const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
const log = execFileSync(
  "git",
  ["log", range, "--no-merges", `--pretty=format:%s${US}%b${RS}`],
  { encoding: "utf8" }
);

const COMMIT_PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?(!)?: (.+)/;

const SECTIONS = {
  breaking: { title: "Breaking changes", entries: [] },
  feat: { title: "Added", entries: [] },
  fix: { title: "Fixed", entries: [] },
  change: { title: "Changed", entries: [] },
  other: { title: "Other", entries: [] },
};

for (const rawRecord of log.split(RS)) {
  const record = rawRecord.replace(/^\n/, "");
  if (!record.trim()) continue;
  const [subject, body = ""] = record.split(US);
  if (/^Bump to v/i.test(subject)) continue;

  const match = subject.match(COMMIT_PATTERN);
  const isBreaking = Boolean(match?.[3]) || /BREAKING CHANGE:/.test(body);

  if (isBreaking) {
    SECTIONS.breaking.entries.push(`- ${match ? match[4] : subject}`);
    continue;
  }

  if (!match) {
    SECTIONS.other.entries.push(`- ${subject}`);
    continue;
  }

  const [, type, , , description] = match;
  if (type === "feat") SECTIONS.feat.entries.push(`- ${description}`);
  else if (type === "fix") SECTIONS.fix.entries.push(`- ${description}`);
  else if (type === "perf" || type === "refactor")
    SECTIONS.change.entries.push(`- ${description}`);
  else if (["docs", "style", "test", "build", "ci", "chore", "revert"].includes(type))
    SECTIONS.other.entries.push(`- ${description}`);
}

const lines = [`## [${version}] — ${date} (commit \`${shortSha}\`)`];

for (const key of ["breaking", "feat", "fix", "change", "other"]) {
  const { title, entries } = SECTIONS[key];
  if (entries.length === 0) continue;
  lines.push("", `### ${title}`, ...entries);
}

if (lines.length === 1) {
  lines.push("", "- No notable changes.");
}

process.stdout.write(lines.join("\n") + "\n");
