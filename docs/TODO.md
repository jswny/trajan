# TODO

- [ ] Revisit [Cloudflare Computer’s experimental replay](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#how-replay-works) when it stabilizes. A Worker restart currently stops an in-flight `exec`, even if some nested calls already finished. Before enabling replay, verify that interrupted filesystem, Git, and registered tool mutations can safely retry, deduplicate by call ID, or refuse the retry.
