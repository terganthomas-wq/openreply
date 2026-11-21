/**
 * An offer's landing page reports a sign-up: POST {"token": "<ig value>"}
 * (lib/offers/signup.ts).
 *
 * Server to server, with a service key that has signups:write (the API & MCP
 * page's "Report sign-ups" key): the key's workspace is the only one whose
 * codes count, its 120 requests a minute are the limit (authenticateService),
 * and a request from a browser page of another origin is refused, since the
 * key must never be in a page's script. The first report of a code answers
 * { data: { alreadyRecorded: false } }, every later one
 * { data: { alreadyRecorded: true } } and changes nothing; an unknown code is
 * a 404. The answer never waits for Instagram: the chat confirmation is a
 * queued job. Neither the code nor the key is ever logged.
 */

import { z } from "zod";
import { authenticateService, requireScope } from "@/lib/integrations/auth";
import {
  apiError,
  ApiError,
  checkOrigin,
  readJson,
} from "@/lib/integrations/http";
import { SIGNUP_SCOPE } from "@/lib/integrations/scopes";
import { recordSignup } from "@/lib/offers/signup";
import { SIGNUP_TOKEN_PATTERN } from "@/lib/offers/signup-link";
import { errorKind } from "@/lib/offers/signup-token";

// {"token": "<24 characters>"} takes about 40 bytes.
const MAX_BODY_BYTES = 1024;

// The token alone, exactly in the code's shape.
const reportSchema = z
  .object({ token: z.string().regex(SIGNUP_TOKEN_PATTERN) })
  .strict();

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    requireScope(context, SIGNUP_SCOPE);
    const parsed = reportSchema.safeParse(
      await readJson(request, MAX_BODY_BYTES)
    );
    if (!parsed.success) {
      throw new ApiError('Send the ig value as {"token": "<ig value>"}');
    }

    const report = await recordSignup(context.workspaceId, parsed.data.token);
    if (report.status === "unknown") throw new ApiError("Unknown token", 404);
    return Response.json(
      { data: { alreadyRecorded: report.status === "alreadyRecorded" } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // The kind only: a database error's message may quote the token.
    if (!(error instanceof ApiError)) {
      console.error("[Sign-up] Report failed:", errorKind(error));
    }
    return apiError(error);
  }
}
