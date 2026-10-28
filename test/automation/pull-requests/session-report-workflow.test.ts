// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

const workflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(
  ".github/workflows/session-report-comments.yaml",
);
const script = workflow.jobs["refresh-report"].steps![0].with!.script as string;
const authorize = workflow.jobs.authorize.steps![0].with!.script as string;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;

it("ignores unrelated opening comments when reading report candidates", async () => {
  const metadata = readYaml<{ jobs: Record<string, WorkflowJob> }>(
    ".github/workflows/commit-lint.yaml",
  );
  const read = metadata.jobs["commit-lint"].steps!.find(
    (step) => step.name === "Read current PR comments",
  )!.with!.script as string;
  const comments = [
    { body: "<!-- agent-session-report:opening -->\nAuthor report", user: { login: "author" } },
    { body: "<!-- agent-session-report:opening -->\nFake report", user: { login: "outsider" } },
    { body: "Unrelated discussion", user: { login: "author" } },
  ];
  const write = vi.fn();
  const permission = vi.fn(async () => ({ data: { permission: "read", role_name: "read" } }));
  const github = {
    paginate: vi.fn(async () => comments),
    rest: {
      issues: { listComments: vi.fn() },
      pulls: { get: vi.fn(async () => ({ data: { user: { login: "author" } } })) },
      repos: { getCollaboratorPermissionLevel: permission },
    },
  };
  await new AsyncFunction("github", "context", "require", "process", read)(
    github,
    { repo: { owner: "NVIDIA", repo: "NemoClaw" }, payload: { pull_request: { number: 42 } } },
    () => ({ writeFileSync: write }),
    { env: { RUNNER_TEMP: "/fixture" } },
  );
  expect(JSON.parse(write.mock.calls[0][1])).toEqual([comments[0]]);
});

function fixture() {
  const pr = {
    number: 42,
    state: "open",
    user: { login: "author" },
    head: { sha: "a".repeat(40) },
  };
  const context = {
    eventName: "issue_comment",
    actor: "author",
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    payload: {
      issue: { number: 42, pull_request: {} },
      comment: { body: "<!-- agent-session-report:opening -->" },
      changes: { body: { from: "" } },
    },
  };
  const get = vi.fn(async () => ({ data: pr }));
  const paginate = vi.fn(async () => [
    { id: 1, pull_requests: [{ number: 42 }] },
    { id: 3, pull_requests: [{ number: 99 }] },
    { id: 2, pull_requests: [{ number: 42 }] },
  ]);
  const getRun = vi.fn(async () => ({ data: { status: "completed" } }));
  const rerun = vi.fn(async () => undefined);
  const permission = vi.fn(async () => ({ data: { permission: "read", role_name: "read" } }));
  const list = vi.fn();
  const github = {
    paginate,
    rest: {
      pulls: { get },
      repos: { getCollaboratorPermissionLevel: permission },
      actions: { listWorkflowRuns: list, getWorkflowRun: getRun, reRunWorkflow: rerun },
    },
  };
  const sleep = vi.fn((callback: () => void) => callback());
  const authorizeEvent = async () => {
    let allowed = false;
    await new AsyncFunction("github", "context", "core", authorize)(github, context, {
      setOutput: (_name: string, value: string) => {
        allowed = value === "true";
      },
    });
    return allowed;
  };
  const run = async () => {
    expect(await authorizeEvent()).toBe(true);
    await new AsyncFunction("github", "context", "setTimeout", script)(github, context, sleep);
  };
  return {
    pr,
    context,
    get,
    paginate,
    getRun,
    rerun,
    permission,
    list,
    sleep,
    run,
    authorizeEvent,
  };
}

it("does not let an unrelated commenter rerun candidate metadata", async () => {
  const f = fixture();
  f.context.actor = "outsider";
  await expect(f.authorizeEvent()).resolves.toBe(false);
  expect(f.rerun).not.toHaveBeenCalled();
});

it.each(["maintain", "admin"])(
  "allows a repository %s actor to refresh an automated PR",
  async (role) => {
    const f = fixture();
    f.context.actor = "maintainer";
    f.permission.mockResolvedValueOnce({ data: { permission: "write", role_name: role } });
    await f.run();
    expect(f.rerun).toHaveBeenCalledTimes(1);
  },
);

it("does not grant rerun permission when the authority lookup fails", async () => {
  const f = fixture();
  f.context.actor = "outsider";
  f.permission.mockRejectedValueOnce(new Error("permission lookup failed"));
  await expect(f.run()).rejects.toThrow("permission lookup failed");
  expect(f.rerun).not.toHaveBeenCalled();
});

it("rejects a candidate event before it can rerun a workflow", async () => {
  const f = fixture();
  f.context.eventName = "pull_request";
  await expect(f.run()).rejects.toThrow();
  expect(f.rerun).not.toHaveBeenCalled();
});

it("reruns only the latest metadata run for this PR commit", async () => {
  const f = fixture();
  await f.run();
  expect(f.paginate).toHaveBeenCalledWith(
    f.list,
    expect.objectContaining({
      workflow_id: "commit-lint.yaml",
      event: "pull_request",
      head_sha: f.pr.head.sha,
    }),
  );
  expect(f.rerun).toHaveBeenCalledExactlyOnceWith({ ...f.context.repo, run_id: 2 });
});

it("waits for active metadata before refreshing current comments", async () => {
  const f = fixture();
  f.getRun.mockResolvedValueOnce({ data: { status: "in_progress" } });
  await f.run();
  expect(f.sleep).toHaveBeenCalledTimes(1);
  expect(f.rerun).toHaveBeenCalledTimes(1);
});

it("does not rerun a superseded PR commit", async () => {
  const f = fixture();
  f.get
    .mockResolvedValueOnce({ data: f.pr })
    .mockResolvedValueOnce({ data: f.pr })
    .mockResolvedValueOnce({ data: { ...f.pr, head: { sha: "b".repeat(40) } } });
  await f.run();
  expect(f.rerun).not.toHaveBeenCalled();
});

it("reports a missing metadata run instead of dispatching another workflow", async () => {
  const f = fixture();
  f.paginate.mockResolvedValueOnce([]);
  await expect(f.run()).rejects.toThrow("No metadata run");
  expect(f.rerun).not.toHaveBeenCalled();
});

it("refreshes when an edit removes the opening marker", async () => {
  const f = fixture();
  f.context.payload.changes.body.from = f.context.payload.comment.body;
  f.context.payload.comment.body = "removed";
  await f.run();
  expect(f.rerun).toHaveBeenCalledTimes(1);
});
