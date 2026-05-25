---
name: go
description: Batch-promote all ready-for-agent issues to agent:implement. Use when Collin types /go to kick off the next round of agent work.
---

# /go — promote ready issues

Promote all `ready-for-agent` issues to `agent:implement` so the sandcastle pipeline picks them up.

## Steps

1. List candidates:
   ```
   gh issue list --repo collod873/claude-ds --label ready-for-agent --state open --json number,title
   ```

2. If none found, tell Collin "nothing queued" and stop.

3. Show the list and confirm: "Promoting N issues to agent:implement — go?"

4. On confirmation, for each issue:
   ```
   gh issue edit <number> --remove-label "ready-for-agent" --add-label "agent:implement"
   ```

5. Report what was promoted.
