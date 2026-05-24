# TASK

Create a pull request for branch `{{BRANCH}}` targeting `main`.

# CONTEXT

## Branch diff

!`git diff main...{{BRANCH}}`

## Commits on this branch

!`git log main..{{BRANCH}} --oneline`

# STEPS

1. Read the diff and commits to understand the full scope of changes
2. Push the branch: `git push origin {{BRANCH}}`
3. Create the PR using `gh pr create` with:
   - A clear, descriptive title
   - A body that explains:
     - What changed and why
     - How it was tested
     - Any relevant issue references (use `Closes #N` or `Part of #N`)
   - Appropriate labels if any exist

Once complete, output <promise>COMPLETE</promise>.
