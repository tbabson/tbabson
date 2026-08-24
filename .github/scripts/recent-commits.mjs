// Rebuilds the "Recent Commits, by Project" block in README.md.
//
// Takes the owner's most recently pushed public repos and pulls the latest
// commits from each. Deliberately does NOT use /users/:user/events/public --
// that feed no longer embeds commit details (only head/before SHAs) and it
// drops anything older than ~90 days.
//
// Run by .github/workflows/update-readme.yml. GITHUB_TOKEN is only used for
// the higher rate limit; the script reads public data exclusively.

import { readFileSync, writeFileSync } from "node:fs";

const USER = process.env.GH_USER ?? "tbabson";
const README = process.env.README_PATH ?? "README.md";
const MAX_PROJECTS = Number(process.env.MAX_PROJECTS ?? 5);
const MAX_COMMITS = Number(process.env.MAX_COMMITS ?? 3);
const START = "<!-- RECENT-COMMITS:START -->";
const END = "<!-- RECENT-COMMITS:END -->";

// The profile repo itself is skipped: these workflow runs would otherwise be
// the only thing ever listed.
const SKIP_REPOS = new Set([USER.toLowerCase()]);
const BOT_AUTHOR = /\[bot\]|github-actions/i;

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": `${USER}-profile-readme`,
  ...(process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

function ago(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

// Commit subjects land inside a markdown list, so newlines and pipes have to go.
function clean(message) {
  const subject = message.split("\n")[0].trim();
  const flat = subject.replace(/\|/g, "\|").replace(/`/g, "'");
  return flat.length > 72 ? `${flat.slice(0, 69)}...` : flat;
}

async function activeProjects() {
  const repos = await api(`/users/${USER}/repos?per_page=100&sort=pushed`);
  return repos
    .filter((r) => !r.fork && !r.archived && !SKIP_REPOS.has(r.name.toLowerCase()))
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, MAX_PROJECTS);
}

async function commitsFor(repo) {
  let commits;
  try {
    commits = await api(`/repos/${repo.full_name}/commits?per_page=10`);
  } catch (error) {
    // An empty repo returns 409; nothing to show, and it must not fail the run.
    console.warn(`Skipping ${repo.full_name}: ${error.message.split("\n")[0]}`);
    return [];
  }

  return commits
    .filter((c) => !BOT_AUTHOR.test(c.commit.author?.name ?? ""))
    .slice(0, MAX_COMMITS)
    .map((c) => ({
      sha: c.sha.slice(0, 7),
      url: c.html_url,
      message: clean(c.commit.message),
      at: c.commit.author?.date ?? c.commit.committer?.date,
    }));
}

function render(projects) {
  const withCommits = projects.filter((p) => p.commits.length > 0);

  if (withCommits.length === 0) {
    return "_No public commits to show right now._";
  }

  return withCommits
    .map((project) => {
      const lines = project.commits
        .map((c) => `- [\`${c.sha}\`](${c.url}) ${c.message} <sub>· ${ago(c.at)}</sub>`)
        .join("\n");
      const language = project.language ? ` <sub>· ${project.language}</sub>` : "";
      return `**[${project.name}](${project.url})**${language}\n\n${lines}`;
    })
    .join("\n\n");
}

const repos = await activeProjects();
const projects = [];
for (const repo of repos) {
  projects.push({
    name: repo.name,
    url: repo.html_url,
    language: repo.language,
    commits: await commitsFor(repo),
  });
}

const readme = readFileSync(README, "utf8");
const startIndex = readme.indexOf(START);
const endIndex = readme.indexOf(END);

if (startIndex === -1 || endIndex === -1) {
  throw new Error(`Markers ${START} / ${END} not found in ${README}`);
}

const updated =
  readme.slice(0, startIndex + START.length) +
  "\n\n" +
  render(projects) +
  "\n\n" +
  readme.slice(endIndex);

if (updated === readme) {
  console.log("Recent commits block already up to date.");
} else {
  writeFileSync(README, updated);
  console.log(`Recent commits block updated (${projects.length} projects).`);
}
