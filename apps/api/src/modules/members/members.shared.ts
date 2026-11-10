import { z } from "zod";
import { badRequest } from "../../lib/http.js";
import type { Query } from "../../db/index.js";

export const zClientIds = z.array(z.string().uuid()).max(500).nullable().optional();

/** Reject clientIds that don't belong to the current org (RLS hides other orgs' clients) */
export async function assertClientsInOrg(q: Query, clientIds: string[] | null | undefined) {
  if (!clientIds?.length) return;
  const rows = await q<{ id: string }>("select id from clients where id = any($1::uuid[])", [clientIds]);
  if (rows.length !== new Set(clientIds).size) throw badRequest("One or more clientIds don't exist in this organization");
}
