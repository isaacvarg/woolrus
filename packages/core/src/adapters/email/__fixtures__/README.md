# Resend fixtures

Response bodies of `POST https://api.resend.com/emails`, copied from Resend's API reference
(<https://resend.com/docs/api-reference/emails/send-email> and `/docs/api-reference/errors`) on 2026-10-20 and
pretty-printed. Not recorded live: there is no Resend account for dev, and the spec keeps real third-party accounts
ask-first. Re-record with a test key when one exists:

```bash
curl -s https://api.resend.com/emails -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" -H "Idempotency-Key: fixture-1" \
  -d '{"from":"onboarding@resend.dev","to":["delivered@resend.dev"],"subject":"x","text":"x"}'
```

| File | Status | When |
|---|---|---|
| `sent.json` | 200 | Accepted |
| `error-403-invalid-api-key.json` | 403 | Wrong key |
| `error-422-validation.json` | 422 | Bad `from`, `to`, etc. |
| `error-409-concurrent.json` | 409 | Same idempotency key while the first request is still running |
| `error-429-rate-limit.json` | 429 | Over the rate limit |
| `error-500.json` | 500 | Resend's own failure |

`409 invalid_idempotent_request` (same key, different body) is a permanent 4xx like the others.
