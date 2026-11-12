# GitHub review Trigger

This is an operator-owned code project, not a Hub review policy preset. Edit `policy.ts`,
the target, native agent settings and repository grants before deploying. The example refuses
authors outside `trustedAuthors` and checks actual GitHub Review receipts and comment counts.

```sh
miko trigger check examples/triggers/github-review/trigger.ts
miko trigger deploy examples/triggers/github-review/trigger.ts --url <test-hub-url> --token-file <test-organization-key>
```

The workflow holds a durable PR lock, waits for CI without occupying a runner worker, reviews
the accepted head, supplements incomplete verification, repairs findings within explicit limits,
and independently reviews each new head. Closed/draft PRs and changed candidates stop the flow.
API reads, waits, claims and agent calls are recorded so recovery does not republish completed work.

CI failures enter a bounded repair round and the new head returns to CI before formal review.
Adjust the CI selection, trusted identities,
labels, prompts, retries and stop conditions directly in this project. Every agent prompt is
passed unchanged; include any required context yourself.

Use a dedicated test repository and test connection for live validation. Private operator
configuration belongs in a private repository.
