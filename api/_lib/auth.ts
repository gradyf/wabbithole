// Clerk request verification for the api/ functions.
// The frontend sends Authorization: Bearer <session token>.

import { createClerkClient } from '@clerk/backend';
import { HttpError } from './http.js';

export const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
  publishableKey:
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY,
});

// Exact origins allowed to present tokens (Clerk recommends setting this).
// VERCEL_URL covers preview deployments; localhost covers `vercel dev`.
const authorizedParties = [
  'https://wabbithole.io',
  'https://wabbit-hole.vercel.app',
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
  'http://localhost:3000',
].filter(Boolean);

// Verify the request and return both the user id and Clerk's `has` predicate.
// `has` is read from `state.toAuth()` (the session claims — networkless), so a
// caller can check plan/feature entitlements without a Clerk API round trip.
export async function authenticate(request: Request) {
  const state = await clerk.authenticateRequest(request, { authorizedParties });
  if (!state.isAuthenticated) throw new HttpError(401, 'unauthorized');
  const { userId, has } = state.toAuth();
  if (!userId) throw new HttpError(401, 'unauthorized');
  return { userId, has };
}

/** The networkless authorization predicate from the session claims. */
export type Has = Awaited<ReturnType<typeof authenticate>>['has'];

// Thin wrapper preserved verbatim for the callers that only need the id
// (bank.ts, me.ts, article-status.ts, race.ts, trails.ts, quiz-results.ts).
export async function requireUser(request: Request): Promise<string> {
  const { userId } = await authenticate(request);
  return userId;
}
