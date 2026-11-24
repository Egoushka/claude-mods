# A change to a security fence gets an independent Opus review

Status: accepted (2026-11-23)

The 30-line tier that skips the independent review does not apply to the guardrails fence or the scripts that prove it (`mods/guardrails/`, `scripts/probe-fence.sh`, `scripts/fence-probe-*`). Their changes get a `gate:` review on Opus covering `security` and `engineering` before they are called done.

Why: the review of #26 failed it for a probe rule that could pass without showing anything. A probe that cannot fail is worse than none.
