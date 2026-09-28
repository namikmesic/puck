# Example Puck config repo

A config repo holds the agent and environment definitions Puck starts environments from.
Puck reads it through the GitHub API at a tag, a branch or a commit, and validates every file before it starts anything.
This folder is a complete example, and Puck's own tests use it as their fixture.

## Layout

```
puck.schema.json            # the JSON Schema Puck generates; editors and CI validate against it
agents/<name>.yaml          # kind: Agent, one per file
environments/<name>.yaml    # kind: Environment, one per file
prompts/**                  # optional; referenced by an agent's instructionsFile
.github/workflows/validate.yml
```

A file's `name` must equal its file name without `.yaml`.
Names use lowercase letters, digits and dashes.
Puck ignores every other path.

The example defines three agents and one environment:

- `lead` orchestrates: it turns requests into work items and assigns them.
  An orchestrator must use the `claude-code` harness.
- `implementer` works one item at a time on its own branch.
- `reviewer` reviews a finished branch with its editing tools turned off.
- `example` runs them against one application repo, with up to two implementers at once.

## Use it

1. Create a repository for your definitions on GitHub, and install the Puck GitHub App on its owner.
2. Copy the contents of this folder into it, including the hidden `.github/` folder.
3. In `environments/example.yaml`, replace `your-org/your-app` with a repository your GitHub sign-in can reach, and adjust `dir` and `branch`.
4. Commit, push and tag a release such as `v1.0.0`.
   Puck offers the highest semver tag by default and tells you when a newer tag exists.
5. In Puck, choose the repository as the config repo under **Settings → Providers → GitHub**.

## Keep puck.schema.json current

`puck.schema.json` describes every field and the options of each harness, so editors with YAML schema support (the `yaml-language-server` comment at the top of each file) autocomplete and check definitions as you type.
Save a fresh copy from **Settings → Providers → GitHub → Save puck.schema.json** after updating Puck, and commit it.
The schema's `$id` changes whenever the schema does.

## Validation in CI

`.github/workflows/validate.yml` validates every agent and environment file against the committed schema on each push and pull request.
The schema checks one file at a time.
Checks that span files run only in Puck: that names match file names, that referenced agents and files exist, and that the orchestrator uses `claude-code`.
Puck lists those errors with the file and line, and a link to the line on GitHub.
