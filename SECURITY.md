# Security

## Supported versions

Security fixes go into the latest release. Update with `paseo plugin update pi-rust`.

## Report a problem

Report a vulnerability privately through [GitHub security advisories](https://github.com/yannelli/pi-rust-paseo/security/advisories/new). Do not open a public issue. Include the versions of the plugin, Paseo, and pi, the steps to reproduce, and what an attacker could do.

## What the plugin can do

Paseo plugins are trusted, unsandboxed code. This plugin runs `pi` and `git` on the daemon machine as the daemon's user, reads and writes pi's files under the agent directory and in workspaces' `.pi` folders, starts the workflows runner, and can stop background task processes. Install it only on daemons where you would run pi yourself.
