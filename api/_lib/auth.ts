// Clerk request verification for the api/ functions.
// The frontend sends Authorization: Bearer <session token>.

import { createClerkClient } from '@clerk/backend';
import { HttpError } from './http.js';

const clerk = createClerkClient({
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

export async function requireUser(request: Request): Promise<string> {
  const state = await clerk.authenticateRequest(request, { authorizedParties });
  if (!state.isAuthenticated) throw new HttpError(401, 'unauthorized');
  const { userId } = state.toAuth();
  if (!userId) throw new HttpError(401, 'unauthorized');
  return userId;
}
