---
name: performance
description: Find and fix a measured performance bottleneck instead of guessing.
---

# Performance

Measure first. A change without a before/after number is not a performance fix.

## Workflow

1. Define the slow operation and its budget: latency, throughput, memory or
   startup time. Name the input size and the environment.
2. Reproduce it with a measurement that is cheap to repeat: a benchmark, a
   profiler, a trace, or timing around the real path. Record the baseline.
3. Find where the time or memory actually goes. Follow the largest cost, not the
   most suspicious-looking code:
   - repeated work in a loop
   - an accidental O(n²) join or lookup
   - synchronous I/O on a hot path
   - unnecessary serialization, copying or re-rendering
   - an unbounded cache or listener that never releases
4. Change one thing. Re-measure with the same input and environment. Keep the
   change only if the number moves beyond noise.
5. Guard the improvement with a test where practical (a complexity assertion, a
   budget, or a benchmark in CI), not a brittle wall-clock assertion.

## Rules

- Do not trade correctness, clarity or safety for a speedup that is not measured.
- Do not add a cache before you know the cache key is stable and the invalidation
  rule is correct.
- State the cost of the optimization: memory, complexity, cold-start work or
  behavior changes.

## Report

```
Operation: ...
Baseline: <number and method>
Bottleneck: path/to/file.ts:42 — <mechanism>
Change: <what changed>
After: <number and method>
Guard: <test or monitoring added>
```
