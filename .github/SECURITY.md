# Security policy

Muse Code Desktop runs coding agents with access to your files, shell and
credentials. Its native shell is the trust boundary (see
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#the-renderer-is-untrusted)), so
we treat reports against it as the highest priority.

## Supported versions

There is no published release yet. Security fixes land on `main` and ship in
the next build. Once releases exist, only the latest release is supported.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- When the repository is public, use **Security → Report a vulnerability**
  (GitHub private vulnerability reporting).
- Until then, contact the maintainer privately through GitHub
  ([@srikantmehra57](https://github.com/srikantmehra57)) and ask for a private
  channel before sharing details.

Include the affected version or commit, your OS, reproduction steps, and the
impact you observed. Never include real API keys, tokens or private workspace
contents. Redacted logs from `~/Library/Logs/com.musecode.desktop/` (macOS) are
welcome.

We aim to acknowledge a report within 3 working days and to share a fix plan
within 14 days. Credit is given in `CHANGELOG.md` unless you prefer otherwise.

## In scope

- Escaping a workspace grant (reading, writing or opening files outside a folder
  the user picked).
- A renderer-originated request reaching the bridge, git, files, processes or
  the keychain without native authorization.
- Credential exposure: API keys reaching the renderer, logs or disk outside the
  OS keychain.
- Bypassing the bundled-bridge digest check or agent executable pinning.
- A third-party agent running without consent or outside its sandbox where one
  is promised.

## Out of scope

- Actions the agent CLI performs after the user approves them, or in a session
  the user set to Unrestricted. The CLI owns its own sandbox and approvals.
- Vulnerabilities in the `muse` CLI or third-party agent CLIs themselves.
  Report those to their maintainers.
- Gatekeeper or SmartScreen warnings on unsigned development builds.
