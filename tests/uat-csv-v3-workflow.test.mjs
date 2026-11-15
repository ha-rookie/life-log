import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const workflow=readFileSync(new URL("../.github/workflows/life-log-uat-csv-target-v3-migrate-once.yml",import.meta.url),"utf8");
const migration=readFileSync(new URL("../migrations/0006_csv_target_audit_v3.sql",import.meta.url),"utf8");
const approvedParent=workflow.match(/^\s+APPROVED_PARENT: ([a-f0-9]{40})\s*$/m)?.[1]??"";
const approvedTitle=workflow.match(/startsWith\(github\.event\.workflow_run\.head_commit\.message, '([^']+)'\)/)?.[1]??"";

describe("Issue #219: one-shot UAT audit-v3 workflow static contract (no external calls)",()=>{
  it("balances every Actions expression including credentials, SHA and checkout",()=>{
    const open=workflow.match(/\$\{\{/g)||[];
    const complete=workflow.match(/\$\{\{[^\n{}]+\}\}/g)||[];
    expect(open).toHaveLength(5);
    expect(complete).toHaveLength(open.length);
    for(const fragment of [
      "TARGET_SHA: \$\{\{ github.event.workflow_run.head_sha \}\}",
      "GH_TOKEN: \$\{\{ github.token \}\}",
      "ref: \$\{\{ github.event.workflow_run.head_sha \}\}",
      "CLOUDFLARE_API_TOKEN: \$\{\{ secrets.CLOUDFLARE_API_TOKEN \}\}",
      "CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets.CLOUDFLARE_ACCOUNT_ID \}\}"
    ])expect(workflow).toContain(fragment.replaceAll("\\",""));
  });
  it("binds CI success, immutable merge parent, UAT DB and exact one-shot title",()=>{
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain("github.event.workflow_run.run_attempt <= 2");
    expect(workflow).toContain("github.run_attempt == 1");
    expect(approvedParent).toMatch(/^[a-f0-9]{40}$/);
    expect(approvedTitle).toMatch(/^ci\(d1\): (?:repair|rearm) CSV v3 additive schema to UAT \(#\d+\)$/);
    expect(workflow).toContain("APPROVED_PARENT: "+approvedParent);
    expect(workflow).toContain("startsWith(github.event.workflow_run.head_commit.message, '"+approvedTitle+"')");
    expect(workflow).toContain("test \"$(git show -s --format=%s HEAD)\" = '"+approvedTitle+"'");
    expect(workflow).toContain("git diff-tree --no-commit-id --name-only -r HEAD");
    expect(workflow).toContain("printf '%s\\n' '.github/workflows/life-log-uat-csv-target-v3-migrate-once.yml'");
    expect(workflow).toContain('diff -u "$RUNNER_TEMP/approved-files" "$RUNNER_TEMP/actual-files"');
    expect(workflow).toContain('test "$GITHUB_RUN_ATTEMPT" = 1');
    expect(workflow).toContain("gh api \\"repos/$GITHUB_REPOSITORY/pulls/212\\"");
    expect(workflow).toContain("test \"$(git rev-parse HEAD^)\" = \"$APPROVED_PARENT\"");
    expect(workflow).toContain("421d0116-5c33-4782-a2b6-28f9684d3956");
    expect(workflow).toContain("8dbdd979f5c9d9d0be8aa6d965a6de8c31e58bf9");
    expect(workflow).toContain("npx --no-install wrangler d1 migrations apply DB --env uat --remote");
  });
  it("allows only additive reviewed tables/index; no data DML or backfill",()=>{
    const withoutComments=migration.split(/\r?\n/).filter(s=>!s.trimStart().startsWith("--")).join("\n");
    const stmts=withoutComments.split(";").map(x=>x.trim()).filter(Boolean);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toMatch(/^CREATE TABLE IF NOT EXISTS import_job_target_manifest \(/);
    expect(stmts[1]).toMatch(/^CREATE TABLE IF NOT EXISTS import_target_audit \(/);
    expect(stmts[2]).toMatch(/^CREATE INDEX IF NOT EXISTS idx_import_target_audit_job_row/);
    expect(withoutComments).not.toMatch(/\b(?:DROP|ALTER|UPDATE|DELETE|INSERT|REPLACE|TRUNCATE|PRAGMA|VACUUM)\b/i);
    expect(workflow).toContain("Existing schema definition drift; fail closed");
    expect(workflow).toContain("SELECT name FROM d1_migrations ORDER BY id");
    expect(workflow).toContain("0/3 v3 objects");
  });
});
