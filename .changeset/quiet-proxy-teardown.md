---
"wrangler": patch
---

Drain in-flight proxy control requests before tearing down the local development server

Avoid disposing the proxy worker while a control request is still using its HTTP dispatcher. Queued requests and pending readiness waits are cancelled during teardown so early shutdown does not hang.
