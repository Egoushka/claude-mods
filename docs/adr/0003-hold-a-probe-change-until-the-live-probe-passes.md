# A probe change merges only after the live probe passes

Status: accepted (2026-11-23)

A change to the fence probe is merged only after the probe, as changed, has run on the Mac and passed. Passing tests are not enough, because the probe's own logic is what the tests do not cover. If the Mac is unreachable the PR waits.
