# TASK

Create a pull request for branch `{{BRANCH}}` targeting `main`. This branch implements work from PRD #{{PRD_NUMBER}}.

# CONTEXT

## Parent PRD

!`gh issue view {{PRD_NUMBER}} --json title,body -q '"\(.title)\n\n\(.body)"'`

## Branch diff

!`git diff main...{{BRANCH}}`

## Commits on this branch

!`git log main..{{BRANCH}} --oneline`

# STEPS

1. Read the PRD, diff, and commits to understand the full scope of changes
2. Push the branch: `git push origin {{BRANCH}}`
3. Create the PR using `gh pr create` with:
   - A clear, descriptive title referencing the PRD
   - A body that explains:
     - Which sub-issues from the PRD are addressed
     - What changed and why
     - How it was tested
     - `Part of #{{PRD_NUMBER}}`
   - Appropriate labels if any exist

Once complete, output <promise>COMPLETE</promise>.
