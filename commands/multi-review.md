---
description: Run three independent reviewers on smol, default, and slow models
---

Run an independent multi-model code review of: $ARGUMENTS

Call `task` exactly once with one batch containing these three agents:

- `reviewer-smol`
- `reviewer-default`
- `reviewer-slow`

Give every agent the same complete review target and acceptance criteria. Keep shared `context` factual; do not include conclusions or output from another reviewer. Do not let reviewers coordinate or edit files.

Wait for all three results. Then deduplicate findings, preserve disagreements, and identify which reviewer and model alias reported each finding.
