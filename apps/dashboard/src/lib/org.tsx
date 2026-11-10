/**
 * The org named in the URL (/o/:orgId/...) and the current user's role in it.
 * `can()` mirrors the API's permission table so the UI hides actions the API
 * would refuse; the API stays the authority.
 */
import { useParams } from "react-router-dom";
import { can as canRole, type Permission } from "@qa/shared";
import { useAuth } from "../auth/AuthProvider";

export function useCurrentOrg() {
  const { orgId = "" } = useParams();
  const { orgs } = useAuth();
  const org = orgs.find((o) => o.id === orgId) ?? null;
  return {
    orgId,
    org,
    role: org?.role ?? "viewer",
    can: (p: Permission) => (org ? canRole(org.role, p) : false),
    scoped: !!org?.clientIds,
  };
}
