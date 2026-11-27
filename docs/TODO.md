# TODO

- Give nested Code Mode calls their own durable tasks when a tool needs to sleep and wake independently (for example, while waiting for a CI webhook). Defer until then because durable receipts already let `exec` recover individual calls. If repeated crashes become a problem first, address per-call failure isolation directly.
