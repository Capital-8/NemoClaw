// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

const workflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(
  ".github/workflows/session-report-comments.yaml",
);
const script = workflow.jobs["refresh-report"].steps![0].with!.script as string;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;

function fixture() {
  const pr = { number: 42, state: "open", head: { sha: "a".repeat(40) } };
  const context = {
    eventName: "issue_comment",
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
  const list = vi.fn();
  const github = {
    paginate,
    rest: {
      pulls: { get },
      actions: { listWorkflowRuns: list, getWorkflowRun: getRun, reRunWorkflow: rerun },
    },
  };
  const sleep = vi.fn((callback: () => void) => callback());
  const run = () =>
    new AsyncFunction("github", "context", "setTimeout", script)(github, context, sleep);
  return { pr, context, get, paginate, getRun, rerun, list, sleep, run };
}

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
