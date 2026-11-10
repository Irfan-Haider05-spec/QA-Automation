/**
 * Data hooks (TanStack Query). Query keys start with the org id so switching
 * org never shows another org's cached data.
 */
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiKey, AuditEvent, Channel, Delivery, Deployment, HostedStatus, Job, Report, ReportShare, Schedule, Client, Credential, Environment, Invite, Issue, IssueDetail, Member, Org, OrgSummary, Project, Run, RunDetail, User, Verification } from "./types";

export const keys = {
  me: ["me"] as const,
  org: (o: string) => ["org", o] as const,
  clients: (o: string) => ["org", o, "clients"] as const,
  projects: (o: string) => ["org", o, "projects"] as const,
  project: (o: string, p: string) => ["org", o, "project", p] as const,
  envs: (o: string, p: string) => ["org", o, "project", p, "envs"] as const,
  verification: (o: string, p: string, e: string) => ["org", o, "project", p, "envs", e, "verification"] as const,
  creds: (o: string, p: string, e: string) => ["org", o, "project", p, "envs", e, "creds"] as const,
  apiKeys: (o: string, p: string) => ["org", o, "project", p, "apiKeys"] as const,
  runs: (o: string, p: string) => ["org", o, "project", p, "runs"] as const,
  run: (o: string, p: string, r: string) => ["org", o, "project", p, "run", r] as const,
  issues: (o: string, p: string, f: object) => ["org", o, "project", p, "issues", f] as const,
  issue: (o: string, p: string, i: string) => ["org", o, "project", p, "issue", i] as const,
  deployments: (o: string, p: string) => ["org", o, "project", p, "deployments"] as const,
  jobs: (o: string, p: string) => ["org", o, "project", p, "jobs"] as const,
  schedules: (o: string, p: string) => ["org", o, "project", p, "schedules"] as const,
  hosted: (o: string, p: string) => ["org", o, "project", p, "hosted"] as const,
  channels: (o: string) => ["org", o, "channels"] as const,
  deliveries: (o: string, c: string) => ["org", o, "channels", c, "deliveries"] as const,
  report: (o: string, q: string) => ["org", o, "report", q] as const,
  shares: (o: string) => ["org", o, "shares"] as const,
  members: (o: string) => ["org", o, "members"] as const,
  invites: (o: string) => ["org", o, "invites"] as const,
  audit: (o: string) => ["org", o, "audit"] as const,
};

/** Public: whether new accounts can be created without an invite */
export const useSignupOptions = () => useQuery({ queryKey: ["auth-options"], queryFn: () => api<{ signupOpen: boolean; emailVerification?: boolean; passwordReset?: boolean }>("GET", "/auth/options"), staleTime: 60_000 });
export const useMe = (enabled = true) => useQuery({ queryKey: keys.me, queryFn: () => api<{ user: User; orgs: OrgSummary[] }>("GET", "/auth/me"), enabled });
export const useOrg = (o: string) => useQuery({ queryKey: keys.org(o), queryFn: () => api<{ org: Org }>("GET", `/orgs/${o}`).then((r) => r.org) });
export const useClients = (o: string) => useQuery({ queryKey: keys.clients(o), queryFn: () => api<{ clients: Client[] }>("GET", `/orgs/${o}/clients`).then((r) => r.clients) });
export const useProjects = (o: string) => useQuery({ queryKey: keys.projects(o), queryFn: () => api<{ projects: Project[] }>("GET", `/orgs/${o}/projects`).then((r) => r.projects) });
export const useProject = (o: string, p: string) => useQuery({ queryKey: keys.project(o, p), queryFn: () => api<{ project: Project }>("GET", `/orgs/${o}/projects/${p}`).then((r) => r.project) });
export const useEnvironments = (o: string, p: string) =>
  useQuery({ queryKey: keys.envs(o, p), queryFn: () => api<{ environments: Environment[] }>("GET", `/orgs/${o}/projects/${p}/environments`).then((r) => r.environments) });
export const useVerification = (o: string, p: string, e: string, enabled: boolean) =>
  useQuery({ queryKey: keys.verification(o, p, e), queryFn: () => api<Verification>("GET", `/orgs/${o}/projects/${p}/environments/${e}/verification`), enabled });
export const useCredentials = (o: string, p: string, e: string, enabled = true) =>
  useQuery({ queryKey: keys.creds(o, p, e), queryFn: () => api<{ credentials: Credential[] }>("GET", `/orgs/${o}/projects/${p}/environments/${e}/credentials`).then((r) => r.credentials), enabled });
export const useApiKeys = (o: string, p: string, enabled = true) =>
  useQuery({ queryKey: keys.apiKeys(o, p), queryFn: () => api<{ apiKeys: ApiKey[] }>("GET", `/orgs/${o}/projects/${p}/api-keys`).then((r) => r.apiKeys), enabled });
export const useRuns = (o: string, p: string) => useQuery({ queryKey: keys.runs(o, p), queryFn: () => api<{ runs: Run[] }>("GET", `/orgs/${o}/projects/${p}/runs?limit=50`).then((r) => r.runs) });
export const useRun = (o: string, p: string, r: string) => useQuery({ queryKey: keys.run(o, p, r), queryFn: () => api<{ run: RunDetail }>("GET", `/orgs/${o}/projects/${p}/runs/${r}`).then((x) => x.run) });
export const useIssues = (o: string, p: string, f: { status: string; severity?: string }) =>
  useQuery({
    queryKey: keys.issues(o, p, f),
    queryFn: () =>
      api<{ issues: Issue[]; counts: Array<{ status: string; severity: string; n: number }> }>(
        "GET",
        `/orgs/${o}/projects/${p}/issues?status=${f.status}${f.severity ? `&severity=${f.severity}` : ""}&limit=500`,
      ),
  });
export const useIssue = (o: string, p: string, i: string | undefined) =>
  useQuery({
    queryKey: keys.issue(o, p, i ?? ""),
    queryFn: () => api<{ issue: IssueDetail }>("GET", `/orgs/${o}/projects/${p}/issues/${i}`).then((r) => r.issue),
    enabled: !!i,
  });
export const useDeployments = (o: string, p: string) =>
  useQuery({ queryKey: keys.deployments(o, p), queryFn: () => api<{ deployments: Deployment[] }>("GET", `/orgs/${o}/projects/${p}/deployments?limit=20`).then((r) => r.deployments) });
/** Polls while a job is queued or running, so the queue and the runs list update by themselves */
export const useJobs = (o: string, p: string) =>
  useQuery({
    queryKey: keys.jobs(o, p),
    queryFn: () => api<{ jobs: Job[] }>("GET", `/orgs/${o}/projects/${p}/jobs`).then((r) => r.jobs),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "queued" || j.status === "running") ? 3000 : false),
  });
export const useSchedules = (o: string, p: string) =>
  useQuery({ queryKey: keys.schedules(o, p), queryFn: () => api<{ schedules: Schedule[] }>("GET", `/orgs/${o}/projects/${p}/schedules`).then((r) => r.schedules) });
export const useHostedStatus = (o: string, p: string) =>
  useQuery({ queryKey: keys.hosted(o, p), queryFn: () => api<HostedStatus>("GET", `/orgs/${o}/projects/${p}/hosted`) });
export const useChannels = (o: string) =>
  useQuery({ queryKey: keys.channels(o), queryFn: () => api<{ channels: Channel[]; emailAvailable: boolean }>("GET", `/orgs/${o}/notifications`) });
export const useDeliveries = (o: string, c: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.deliveries(o, c),
    queryFn: () => api<{ deliveries: Delivery[] }>("GET", `/orgs/${o}/notifications/${c}/deliveries`).then((r) => r.deliveries),
    enabled,
    // Keep watching while messages are waiting or being sent
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "queued" || d.status === "sending") ? 3000 : false),
  });
export const useReport = (o: string, q: string | null) =>
  useQuery({ queryKey: keys.report(o, q ?? ""), queryFn: () => api<{ report: Report }>("GET", `/orgs/${o}/reports?${q}`).then((r) => r.report), enabled: !!q });
export const useShares = (o: string, enabled: boolean) =>
  useQuery({ queryKey: keys.shares(o), queryFn: () => api<{ shares: ReportShare[] }>("GET", `/orgs/${o}/report-shares`).then((r) => r.shares), enabled });
export const useMembers = (o: string) => useQuery({ queryKey: keys.members(o), queryFn: () => api<{ members: Member[] }>("GET", `/orgs/${o}/members`).then((r) => r.members) });
export const useInvites = (o: string, enabled: boolean) => useQuery({ queryKey: keys.invites(o), queryFn: () => api<{ invites: Invite[] }>("GET", `/orgs/${o}/invites`).then((r) => r.invites), enabled });
export const useAudit = (o: string) => useQuery({ queryKey: keys.audit(o), queryFn: () => api<{ events: AuditEvent[] }>("GET", `/orgs/${o}/audit?limit=200`).then((r) => r.events) });

/** Mutation that invalidates the given query-key prefixes on success */
export function useAction<TVars, TOut = any>(fn: (v: TVars) => Promise<TOut>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    },
  });
}
