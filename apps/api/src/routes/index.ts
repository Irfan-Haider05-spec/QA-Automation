/**
 * All API routes, mounted under /api/v1. Same layout as the MLITech backend
 * (an apiRoutes array), so the QA engine's route discovery can audit this API.
 */
import express from "express";
import { AuthRoutes } from "../modules/auth/auth.routes.js";
import { OrgRoutes } from "../modules/orgs/orgs.routes.js";
import { MembersRouter } from "../modules/members/members.routes.js";
import { InvitesRouter } from "../modules/invites/invites.routes.js";
import { InviteAcceptRouter } from "../modules/invites/invite-accept.routes.js";
import { ClientsRouter } from "../modules/clients/clients.routes.js";
import { ProjectsRouter } from "../modules/projects/projects.routes.js";
import { EnvironmentsRouter } from "../modules/environments/environments.routes.js";
import { CredentialsRouter } from "../modules/credentials/credentials.routes.js";
import { ApiKeysRouter } from "../modules/apiKeys/apiKeys.routes.js";
import { RunsRouter } from "../modules/runs/runs.routes.js";
import { IssuesRouter } from "../modules/issues/issues.routes.js";
import { AuditRouter } from "../modules/audit/audit.routes.js";
import { RunnerRouter } from "../modules/runner/runner.routes.js";
import { DeploymentsRouter } from "../modules/deployments/deployments.routes.js";
import { JobsRouter } from "../modules/jobs/jobs.routes.js";
import { HostedStatusRouter } from "../modules/jobs/hostedStatus.routes.js";
import { SchedulesRouter } from "../modules/schedules/schedules.routes.js";
import { HostedRouter } from "../modules/hosted/hosted.routes.js";
import { NotificationsRouter } from "../modules/notifications/notifications.routes.js";
import { ReportsRouter } from "../modules/reports/reports.routes.js";
import { ReportSharesRouter } from "../modules/reports/shares.routes.js";
import { PublicReportsRouter } from "../modules/reports/public.routes.js";

const router = express.Router();

const apiRoutes = [
  { path: "/auth", route: AuthRoutes },
  { path: "/invites", route: InviteAcceptRouter },
  { path: "/orgs", route: OrgRoutes },
  { path: "/orgs/:orgId/members", route: MembersRouter },
  { path: "/orgs/:orgId/invites", route: InvitesRouter },
  { path: "/orgs/:orgId/clients", route: ClientsRouter },
  { path: "/orgs/:orgId/audit", route: AuditRouter },
  { path: "/orgs/:orgId/projects", route: ProjectsRouter },
  { path: "/orgs/:orgId/projects/:projectId/environments", route: EnvironmentsRouter },
  { path: "/orgs/:orgId/projects/:projectId/environments/:environmentId/credentials", route: CredentialsRouter },
  { path: "/orgs/:orgId/projects/:projectId/api-keys", route: ApiKeysRouter },
  { path: "/orgs/:orgId/projects/:projectId/runs", route: RunsRouter },
  { path: "/orgs/:orgId/projects/:projectId/issues", route: IssuesRouter },
  { path: "/orgs/:orgId/projects/:projectId/deployments", route: DeploymentsRouter },
  { path: "/orgs/:orgId/projects/:projectId/jobs", route: JobsRouter },
  { path: "/orgs/:orgId/projects/:projectId/hosted", route: HostedStatusRouter },
  { path: "/orgs/:orgId/projects/:projectId/schedules", route: SchedulesRouter },
  { path: "/runner", route: RunnerRouter },
  { path: "/hosted", route: HostedRouter },
  { path: "/orgs/:orgId/notifications", route: NotificationsRouter },
  { path: "/orgs/:orgId/reports", route: ReportsRouter },
  { path: "/orgs/:orgId/report-shares", route: ReportSharesRouter },
  { path: "/public", route: PublicReportsRouter },
];

apiRoutes.forEach((r) => router.use(r.path, r.route));

export default router;
