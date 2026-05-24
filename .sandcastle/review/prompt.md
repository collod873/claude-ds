# TASK

Review the code changes on branch `{{SOURCE_BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality.

# PRE-FLIGHT

Read `.sandcastle/CODING_STANDARDS.md` before starting.

Read `CONTEXT.md` if it exists — it contains domain language and architecture decisions.

# CONTEXT

## Branch diff

!`git diff main...{{SOURCE_BRANCH}}`

## Commits on this branch

!`git log main..{{SOURCE_BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Consumer safety check**:
   - Could this change clobber consumer-authored files not declared in the manifest?
   - Does it remove or weaken hand-edit detection (`abort` on managed files)?
   - Does it change managed/hybrid/seeded categories without a migration Op?
   - Could it break a consumer repo if dropped in via `npx`?

5. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

6. **Apply project standards**: Follow the coding standards defined in `.sandcastle/CODING_STANDARDS.md`

7. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on this branch
2. Run tests and type checking to ensure nothing is broken — never pipe output through `tail`, `head`, or redirect to a temp file; run commands directly so streaming output keeps the session alive
3. Never use sleep-loops or polling patterns — run commands synchronously
4. Commit using conventional-commit style (e.g. `refactor:`, `fix:`, `test:`, `style:`) describing the refinements

If the code is already clean and well-structured, do nothing.

Once complete, output <promise>COMPLETE</promise>.
