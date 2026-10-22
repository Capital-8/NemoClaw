// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

it("selects the unavailable-search proof when the provenance parser changes", () => {
  const plan = buildE2eWorkflowPlan(
    {},
    { changedFiles: ["src/lib/openclaw/agent-json-provenance.ts"] },
  );
  expect(plan.coverageMatrix.map((row) => row.id)).toContain(
    "common-egress-agent-openclaw-balanced-weather",
  );
});
