# The CLI's late-entry limit is accepted; the call guard is the fence

Status: accepted (2026-11-23)

Claude Code CLI 2.1.330 hides a fenced tool from a session that starts inside the boundary folder. A session that starts outside and enters it later still gets the tool from its tool search. Desktop build 2.1.325 withholds it in both cases.

Decision: no deeper fix now. The `tool.call` guard denies the call, so no personal data is returned; `scripts/probe-fence.sh` checks the denial. The limit is documented in `mods/guardrails/README.md`.

Reopen if a CLI release honours `tool.list` for late entry, or if a call is ever seen to get through.
