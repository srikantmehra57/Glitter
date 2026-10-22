---
name: security-review
description: Check code for injection, secret exposure, unsafe input handling and other common vulnerabilities.
---

# Security review

Review the change for ways an attacker could make the system do something the
owner did not intend. Stay concrete: name the input, the sink and the missing
check.

## Checklist

1. **Trust boundaries.** Mark every place data enters from a user, a network
   request, a file, an environment variable or another process. Check what
   validation happens before it reaches a sink.
2. **Injection.** Shell commands built from strings, SQL concatenation, HTML
   injection, path traversal, template injection, header injection and unsafe
   deserialization. Prefer argument arrays, parameterized queries, allowlists and
   canonical paths with a containment check.
3. **Authorization.** Does each privileged action verify the caller may perform
   it, not only that they are authenticated? Check object ownership, tenant
   isolation and admin-only paths.
4. **Secrets.** Keys, tokens and passwords in source, logs, error messages,
   telemetry, URLs and fixtures. Check that redaction runs before logging and
   that secrets are not returned to an untrusted renderer.
5. **SSRF and outbound requests.** URLs that come from user input need a scheme
   allowlist, a host policy and redirect handling.
6. **Crypto and randomness.** No home-grown crypto, no `Math.random` for tokens,
   constant-time comparison for secrets, current algorithms and key sizes.
7. **File and process handling.** Symlink escapes, archive extraction paths,
   temporary-file races, world-readable permissions, and cleanup on failure.
8. **Denial of service.** Unbounded loops, recursion, body sizes, file sizes,
   decompression and regex backtracking on attacker-controlled input.

## Report

One finding per defect:

```
Severity: Critical | High | Medium | Low
Where: path/to/file.ts:42
Input: <attacker-controlled value>
Sink: <what it reaches>
Impact: <what the attacker gains>
Fix: <the concrete change>
```

State what you checked and found clean. Do not report a theoretical issue without
a reachable path; if reachability is unclear, say what would make it reachable.
