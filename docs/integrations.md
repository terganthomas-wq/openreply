# API and MCP

Workspace owners and admins can create keys at **API & MCP** (`/integrations`).
For campaign keys the UI offers 30, 60 or 90 days (default: 30), and the API
accepts whole days from 1 to 90. A **report sign-ups** key (`signups:write`
alone) sits on a landing page's server, where an expired key would stop the
sign-up feedback without anyone noticing, so it may live longer: the UI offers
90, 180 or 365 days (default: 365), the API accepts 1 to 365 and gives it 365
when the request names no lifetime. Existing keys are never extended. Copy the
token at creation; only its SHA-256 hash is stored. Revocation takes effect on
subsequent authenticated requests. Use HTTPS and never put a token in a URL,
source control, screenshots or prompts. Keys belong to the workspace, not their
creator, and remain valid until expiry, revocation or workspace deletion.
Review keys when team members leave.

From 14 days before a key expires, **API & MCP** and **Diagnostics** show a
warning with its name, kind and expiry date whenever someone opens them; there
is no e-mail or other notification. After the expiry the warning stays while
the key was used in the last 30 days (its last successful request,
`lastUsedAt`): whatever still uses it is refused now. A key nothing used
expires quietly. Create a new key, replace the old one where it is used, then
revoke the old one; a revoked key never warns. Diagnostics shows the warning to
every member of the workspace, without when the key was last used. Only owners
and admins can create and revoke keys, so a member's warning asks them to have
an owner or admin replace the key and carries no link to API & MCP (the route
sends `canManageKeys`).

## Scopes

- `campaigns:read`: list campaigns, read one campaign's settings and links, read
  its aggregate stats.
- `campaigns:write`: create campaigns. Nothing else: no key can change, switch
  on or off, or delete an existing campaign, and no key sends messages itself.
- `signups:write`: report a sign-up from an offer's landing page
  (`POST /api/offers/signup`, below). Nothing else: such a key opens no MCP
  tool and no campaign route.

The page creates **read-only** keys (`campaigns:read`), **read-and-write** keys
(`campaigns:read` and `campaigns:write`) and **report sign-ups** keys
(`signups:write`). The key API also accepts `campaigns:write` alone; such a key
gets the campaigns it creates back but can read nothing else. `signups:write`
is only accepted on its own: the key lives on the landing page's server and
never carries a campaign scope. Keys made before write access existed stay
read-only.

Contacts and their tags are not part of this API: they are personal data.
Responses never contain recipient logs.

Apply migrations and regenerate Prisma before starting the new web version:

```sh
npm run db:migrate
npm run db:generate
```

The migration that introduced keys only creates `ServiceKey`; write access
needs no further migration. `REDIS_URL` is required for service requests. Each
key allows 120 requests per fixed 60-second window, creates included. Redis
failures reject requests with 503 instead of disabling the limiter.

## MCP clients

Connect to `https://YOUR-DOMAIN/api/mcp` using Streamable HTTP and a custom header:

```text
Authorization: Bearer <service-key>
```

There is no OAuth server, dynamic client registration or token in the URL.
In Claude, use **No authentication** plus this custom request header **only if
your client offers request headers**. Clients requiring OAuth are not supported.
Never switch to public access to work around a client limitation.

`tools/list` shows the tools the key's scopes allow.

Read tools (scope `campaigns:read`, annotated read-only and idempotent):

- `list_campaigns`: up to 100 compact campaign summaries, newest first.
- `get_campaign` with `{ "id": "..." }`: settings, ordered `trackedLinks`, and
  `trackedDestinationUrl`, `secondaryDestinationUrl`, `secondaryButtonLabel`.
  Missing links are `[]` / `null`. Link order matches the existing DM worker.
- `get_campaign_stats` with `{ "id": "..." }`: aggregate send outcomes and raw
  link requests. These are **not** unique recipients or CRM conversions.

Write tool (scope `campaigns:write`, annotated neither read-only nor idempotent):

- `create_campaign`: the body of `POST /api/v1/campaigns` below as arguments;
  returns the created campaign like `get_campaign`. Every call creates another
  campaign, so a client should not retry a call that may have succeeded; check
  with `list_campaigns` first.

Example safe verification: ask your client to list campaigns, then read one
campaign's destination URLs without changing anything.

## REST

Use the same Bearer header:

```text
GET  /api/v1/campaigns
GET  /api/v1/campaigns?id=<campaign-id>
GET  /api/v1/campaigns?id=<campaign-id>&stats=1
POST /api/v1/campaigns
```

Responses use `{ "data": ... }`, errors `{ "error": "..." }`. Lists are capped at
100; pagination is not yet provided. Detail responses use an explicit safe
projection: no provider tokens, report-share secrets, recipient logs or account
relations. A campaign outside the key's workspace returns 404. Invalid/expired/
revoked keys return 401, missing scope returns 403, rate limits return 429.
Results are `Cache-Control: no-store`.

### Creating a campaign

`POST /api/v1/campaigns` takes the fields of a campaign made in the editor
(`createAutomationSchema` in `lib/campaigns/schema.ts`) as a JSON object and
answers `201` with the created campaign in the `get_campaign` shape. For a reel
this is enough:

```sh
curl -X POST https://YOUR-DOMAIN/api/v1/campaigns \
  -H "Authorization: Bearer $OPENREPLY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Prompt reel",
    "keywords": ["Prompt", "Promt", "Prom"],
    "postId": "<instagram-media-id>",
    "trackedDestinationUrl": "https://drive.google.com/file/d/<id>/view?usp=sharing"
  }'
```

- **Defaults.** Every field the body leaves out takes the workspace's default
  texts and switches (**Default texts** in the campaign editor): opening DM,
  both follow requests, link DM and button, public replies, the question-mark
  filter and the offers switch, exactly what a new campaign opens with in the
  editor. A workspace that has none yet gets the built-in set of the
  installation's language (`DEFAULT_LOCALE`, German today) written once, as on
  the editor's first visit; in a language without a built-in set there are no
  defaults and the body must carry the texts (at least `dmMessage`). The
  defaults switch offers on only while the workspace has an active offer and
  only together with the opening DM they bring along, which offers need.
  Anything the body sends, `null` included, wins over a default, so a body
  that switches the opening DM off while the defaults have offers on also
  sends `"offersEnabled": false`.
- **Paused.** A created campaign is paused unless the body sends
  `"isActive": true`. Once active it answers matching comments with DMs.
- **Link.** `trackedDestinationUrl` becomes the DM's tracked link button. As
  the editor does, a `dmMessage` without `{link}` gets ` {link}` appended:
  that is where the link goes when Instagram refuses the button and the text
  is sent alone (the button DM itself never shows the token). Links
  (`trackedDestinationUrl`, `secondaryDestinationUrl`, `postUrl`) must be
  full `http://` or `https://` addresses; `javascript:`, `data:`, `mailto:`
  and every other scheme are refused with a `400`.
- **Trigger.** `postId` (an Instagram media id), `"matchAnyPost": true` or
  `"pendingNextReel": true`; words with `keywords`, or `"matchAnyWord": true`.
- **Account.** `instagramAccountId` names one of the workspace's connected
  accounts (as in `get_campaign`); without it the most recently connected one
  is used.
- **Offers.** `offerIds` sets a custom offer order (ids of this workspace's
  offers that are not deleted); empty uses the workspace's default order.
  Offers need the opening DM: a body that switches the opening DM off while the
  defaults switch offers on must also send `"offersEnabled": false`.
- **Offer start.** `offerDelayHours` is `0`, the default (the offer follows
  the link), or `22`: the offer starts 22 hours after the person's tap or DM,
  while Instagram's 24-hour window is still open, and gets no reminder. Any
  other value is refused with a `400`. It is not among the workspace's
  default texts. Late starts already queued keep their time when a campaign's
  setting changes (see `docs/offers.md`). `list_campaigns`, `get_campaign`
  and the REST reads return the field.
- **Errors.** `400` with `Invalid campaign: <field>: <problem>; ...` for an
  unknown or misspelt field (the body is checked strictly) and for every rule
  the dashboard's create route applies, `Unknown offer`, or `Connect Instagram before creating
  campaigns` (also for an account of another workspace); `403 Missing scope:
  campaigns:write` before the body is read; `413` above 64 KiB; `415` without
  `Content-Type: application/json`.

### Reporting a sign-up

`POST /api/offers/signup` is for an offer whose landing page reports
sign-ups (**Report the sign-up back** in the offer editor, see
`docs/offers.md`). The landing page's server sends the `ig` value the offer's
link brought along, once the sign-up is confirmed:

```sh
curl -X POST https://YOUR-DOMAIN/api/offers/signup \
  --max-time 3 \
  -H "Authorization: Bearer $SIGNUP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "<ig value>"}'
```

- The key needs `signups:write` (403 otherwise) and only finds codes of its
  own workspace. The same limits apply as above: 120 requests per key and
  minute, 503 without Redis, a foreign Origin is refused, so the key never
  belongs in a page's script.
- The body is exactly `{"token": "<24 base64url characters>"}`; anything
  else is a 400 (415 without the JSON content type, 413 above 1 KiB).
- The first report answers `200 {"data": {"alreadyRecorded": false}}`: the
  sign-up time and the offer's "signed up" tag are recorded, and the chat
  confirmation is queued if the offer has one. Every later report of the same
  code answers `200 {"data": {"alreadyRecorded": true}}` and changes nothing.
- An unknown code answers `404 {"error": "Unknown token"}`: another
  workspace's, one of an offer that no longer reports sign-ups, or one of a
  deleted contact.
- The answer never waits for Instagram. Neither the code nor the key is
  logged.

`deploy/README.de.md` has a PHP example for the landing page.

Admin key management uses session authentication at `/api/integrations/keys`:
GET lists metadata (never hashes/tokens) with `expired` and `expiryWarning`
(`"expiring"`, `"expired"` or `null`, as above) by the server's clock, POST
creates a key with `scopes` of one or both campaign scopes above, or
`signups:write` alone, and an optional `days` (1 to 90 for campaign keys, 1 to
365 for a sign-up key; 400 otherwise), DELETE with `?id=` revokes it. A
supplied Origin must match `NEXTAUTH_URL` (or the request origin). JSON request
bodies are bounded to 64 KiB including streamed/chunked requests.

## Verification

`npm test` includes mocked authentication/route tests, campaign creation
included. Set `TEST_DATABASE_URL` to a disposable local PostgreSQL database to
also exercise full migrations, workspace isolation, deterministic link ordering,
fixed key expiration and creating campaigns with seeded defaults. The DB suites
create and remove their own schemas.

For actual HTTP verification of a read-only key, migrate a **disposable local**
database, start the web app with that `DATABASE_URL`, local `REDIS_URL` and
loopback `NEXTAUTH_URL`, then run:

```sh
TEST_BASE_URL=http://127.0.0.1:3317 \
TEST_DATABASE_URL=postgresql://postgres:local-test@127.0.0.1:54456/postgres \
npx tsx scripts/verify-readonly-integrations.ts
```

The script refuses non-loopback URLs, creates dummy fixtures and keys, and
removes its test user/workspace in `finally`. It must never run against a real
deployment, including one tunneled through localhost. No Meta messages are sent.
