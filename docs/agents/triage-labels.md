# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Agent state labels

The `agent:*` labels track an issue or PR's position in the AFK-agent workflow:

| Label | Meaning |
| ----- | ------- |
| `agent:implement` | Ready for the implement workflow to run (issues and PRs). |
| `agent:review` | PR is ready for the automated review workflow. |
| `agent:update-branch` | PR branch needs merge/rebase against its base. |
| `agent:in-progress` | A workflow run is currently active. |
| `agent:blocked` | A run failed or was refused; needs human attention before retry. |
