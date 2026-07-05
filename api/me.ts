// GET /api/me — auth smoke test: returns the verified Clerk user id.

import { requireUser } from './_lib/auth';
import { handle, json, requireMethod } from './_lib/http';

export default handle(async (request) => {
  requireMethod(request, 'GET');
  const userId = await requireUser(request);
  return json({ userId });
});
