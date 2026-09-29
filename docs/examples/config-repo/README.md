# Puck home

A Puck home is the one GitHub repository that holds your agent and environment definitions.
Puck reads it through the GitHub API at a tag, a branch or a commit, and validates every definition file.
Git is the only way to change a definition: commit to this repository, and Puck reads the new version.
Puck never edits these files itself.

These files are the starter home Puck commits when it initializes a new one; in the Puck repository they live in `docs/examples/config-repo/`, and Puck's own tests use them as their fixture.

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
Referenced instruction files are read. A symlink is not the file it names. Every other path is ignored.

The starter defines three agents and one environment:

- `lead` orchestrates: it turns requests into work items and assigns them.
  An orchestrator must use the `claude-code` harness.
- `implementer` works one item at a time on its own branch.
- `reviewer` reviews a finished branch with its editing tools turned off.
- One environment runs them against one application repository, with up to two implementers at once.

## Set up a Puck home

In Puck, open **Connect your Puck home** in the first-run steps, or **Settings → Providers → GitHub → Puck home**.

- **Initialize** a new home: create an empty repository on GitHub (Puck opens GitHub's page with the name `puck-home` and private visibility filled in), pick it, and pick the repository your first environment works on.
  Puck commits these files into it as one commit and tags it `v1.0.0`.
  Puck initializes only an empty repository, so it never overwrites anyone's files.
- **Connect** an existing home: pick a repository that has `agents/` or `environments/` at its root.

To set one up by hand instead, copy the contents of `docs/examples/config-repo/` into an empty repository, including the hidden `.github/` folder.
In `environments/example.yaml`, replace `your-org/your-app` with a repository your GitHub sign-in can reach, and adjust `dir` and `branch`.
Commit, push and tag a release such as `v1.0.0`, then connect the repository in Puck.

## Change a definition

Commit the change to the Puck home, on a branch or straight to the default branch, and tag a release when it is ready.
To add an environment, commit `environments/<name>.yaml`; to add an agent, commit `agents/<name>.yaml`.

A tag, branch or commit is a pin. The default pin is the highest semver release tag, or the highest prerelease when no release exists.
An environment started at a tag offers the next release tag as an update; one started at a branch offers the branch's new head.

## Keep puck.schema.json current

`puck.schema.json` describes every field and the options of each harness, so editors with YAML schema support (the `yaml-language-server` comment at the top of each file) autocomplete and check definitions as you type.
Puck generates it with `npm run schema` into `schema/puck.schema.json` in the Puck repository; copy a fresh one from there after updating Puck, and commit it.
The schema's `$id` changes whenever the schema does.

## Validation in CI

`.github/workflows/validate.yml` validates every agent and environment file against the committed schema on each push and pull request.
The schema checks one file at a time.
Checks that span files run only in Puck: that names match file names, that referenced agents and files exist, and that the orchestrator uses `claude-code`.
Puck reports those errors with the file, line and column, and a link to the line on GitHub.
