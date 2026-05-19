import * as core from "@actions/core";
import * as github from "@actions/github";
import fs from "node:fs";

const LINE_RE =
  /^\d{2}:\d{2}:\d{2}\.\d{3} (STDOUT|INFO|STDERR|WARN)\s+\[([^\]]+)\] terraform: ?(.*)$/;

const PLAN_SUMMARY_RE =
  /Plan:\s+(\d+)\s+to add,\s+(\d+)\s+to change,\s+(\d+)\s+to destroy/;

const PR_COMMENT_MARKER = "<!-- terragrunt-diff -->";

function parseLog(raw) {
  const moduleAll = new Map();
  const moduleStdout = new Map();

  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, level, module, content] = m;
    const trimmed = content.trim();

    if (level === "STDOUT" || level === "STDERR") {
      if (!moduleAll.has(module)) moduleAll.set(module, []);
      moduleAll.get(module).push(trimmed);
    }
    if (level === "STDOUT") {
      if (!moduleStdout.has(module)) moduleStdout.set(module, []);
      moduleStdout.get(module).push(trimmed);
    }
  }

  const changed = [];

  for (const [module, allLines] of moduleAll) {
    const summaryLine = allLines.find((l) => PLAN_SUMMARY_RE.test(l));
    if (!summaryLine) continue;

    const [, add, change, destroy] = summaryLine.match(PLAN_SUMMARY_RE);
    const toAdd = parseInt(add, 10);
    const toChange = parseInt(change, 10);
    const toDestroy = parseInt(destroy, 10);

    if (toAdd === 0 && toChange === 0 && toDestroy === 0) continue;

    const stdoutLines = moduleStdout.get(module) || allLines;
    const startIdx = stdoutLines.findIndex((l) =>
      l.startsWith("Terraform will perform the following actions:"),
    );
    const endIdx = stdoutLines.findIndex((l) => PLAN_SUMMARY_RE.test(l));
    const planBody =
      startIdx !== -1 && endIdx !== -1
        ? stdoutLines.slice(startIdx, endIdx + 1).join("\n")
        : stdoutLines.join("\n");

    changed.push({ module, toAdd, toChange, toDestroy, planBody });
  }

  changed.sort(
    (a, b) =>
      b.toDestroy - a.toDestroy || b.toChange - a.toChange || b.toAdd - a.toAdd,
  );

  return changed;
}

function buildMarkdown(changes) {
  if (changes.length === 0) {
    return "## Terragrunt Plan\n\n No changes detected across all modules.\n";
  }

  const totals = changes.reduce(
    (acc, c) => ({
      add: acc.add + c.toAdd,
      change: acc.change + c.toChange,
      destroy: acc.destroy + c.toDestroy,
    }),
    { add: 0, change: 0, destroy: 0 },
  );

  let md = "## Terragrunt Plan\n\n";
  md += `**${changes.length} module(s) with changes** — `;
  md += `${totals.add} to add, ${totals.change} to change, ${totals.destroy} to destroy\n\n`;

  md += "| Module | +Add | ~Change | -Destroy |\n";
  md += "|--------|:----:|:-------:|:--------:|\n";
  for (const { module, toAdd, toChange, toDestroy } of changes) {
    const addStr = toAdd > 0 ? `**+${toAdd}**` : `${toAdd}`;
    const chgStr = toChange > 0 ? `**~${toChange}**` : `${toChange}`;
    const dstStr = toDestroy > 0 ? `**-${toDestroy}**` : `${toDestroy}`;
    md += `| \`${module}\` | ${addStr} | ${chgStr} | ${dstStr} |\n`;
  }

  md += "\n---\n\n";

  for (const { module, toAdd, toChange, toDestroy, planBody } of changes) {
    const emoji = toDestroy > 0 ? "🔴" : toChange > 0 ? "🟡" : "🟢";
    md += `<details>\n<summary>${emoji} <code>${module}</code>`;
    md += ` — ${toAdd} to add, ${toChange} to change, ${toDestroy} to destroy</summary>\n\n`;
    md += "```hcl\n";
    md += planBody.trim();
    md += "\n```\n\n";
    md += "</details>\n\n";
  }

  return md;
}

async function run() {
  const logFile = core.getInput("log_file", { required: true });
  const token = core.getInput("token");
  const mode = core.getInput("mode") || "both";

  if (!fs.existsSync(logFile)) {
    core.setFailed(`Log file not found: ${logFile}`);
    return;
  }

  const raw = fs.readFileSync(logFile, "utf8");
  const changes = parseLog(raw);

  core.info(`Modules with changes: ${changes.length}`);
  core.setOutput("has_changes", String(changes.length > 0));
  core.setOutput(
    "changes_json",
    JSON.stringify(
      changes.map(({ module, toAdd, toChange, toDestroy }) => ({
        module,
        toAdd,
        toChange,
        toDestroy,
      })),
    ),
  );

  const markdown = buildMarkdown(changes);

  if (mode === "summary" || mode === "both") {
    await core.summary.addRaw(markdown).write();
  }

  const hasPR = !!github.context.payload.pull_request;

  if ((mode === "comment" || mode === "both") && token && hasPR) {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const prNumber = github.context.payload.pull_request.number;

    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });

    const existing = comments.find((c) => c.body?.includes(PR_COMMENT_MARKER));
    const body = `${PR_COMMENT_MARKER}\n${markdown}`;

    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      core.info(`Updated PR comment #${existing.id}`);
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      core.info("Created PR comment");
    }
  }
}

run().catch((error) => {
  core.setFailed(error.message);
});
