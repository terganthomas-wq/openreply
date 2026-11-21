# API and MCP

Workspace owners and admins can create keys at **API & MCP** (`/integrations`).
The UI offers 30, 60 or 90 days (default: 30). The API accepts whole days from
1 to 90. Existing keys are never extended. Copy the token at creation; only its
SHA-256 hash is stored. Revocation takes effect on subsequent authenticated requests.
Use HTTPS and never put a token in a URL, source control, screenshots or prompts.
Keys belong to the workspace, not their creator, and remain valid until expiry,
revocation or workspace deletion. Review keys when team members leave.

## Scopes

- `campaigns:read`: list campaigns, read one campaign's settings and links, read
  its aggregate stats.
- `campaigns:write`: create campaigns. Nothing else: no key can change, switch
  on or off, or delete an existing campaign, and no key sends messages itself.

The page creates **read-only** keys (`campaigns:read`) or **read-and-write** keys
(`campaigns:read` and `campaigns:write`). The key API also accepts
`campaigns:write` alone; such a key gets the campaigns it creates back but can
read nothing else. Keys made before write access existed stay read-only.

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
- **Errors.** `400` with `Invalid campaign: <field>: <problem>; ...` for an
  unknown or misspelt field (the body is checked strictly) and for every rule
  the dashboard's create route applies, `Unknown offer`, or `Connect Instagram before creating
  campaigns` (also for an account of another workspace); `403 Missing scope:
  campaigns:write` before the body is read; `413` above 64 KiB; `415` without
  `Content-Type: application/json`.

Admin key management uses session authentication at `/api/integrations/keys`:
GET lists metadata (never hashes/tokens), POST creates a key with `scopes` of
one or both scopes above, DELETE with `?id=` revokes it. A supplied Origin must
match `NEXTAUTH_URL` (or the request origin). JSON request bodies are bounded to
64 KiB including streamed/chunked requests.

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
