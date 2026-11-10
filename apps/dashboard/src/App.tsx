import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth/AuthProvider";
import { Loading } from "./components/ui";
import { AppShell } from "./layout/AppShell";
import { LoginPage } from "./pages/auth/Login";
import { SignupPage } from "./pages/auth/Signup";
import { AcceptInvitePage } from "./pages/auth/AcceptInvite";
import { ForgotPasswordPage } from "./pages/auth/ForgotPassword";
import { ResetPasswordPage } from "./pages/auth/ResetPassword";
import { VerifyEmailPage } from "./pages/auth/VerifyEmail";
import { OverviewPage } from "./pages/Overview";
import { ProjectsPage } from "./pages/Projects";
import { ProjectLayout } from "./pages/project/ProjectLayout";
import { RunsTab } from "./pages/project/RunsTab";
import { RunDetailPage } from "./pages/project/RunDetail";
import { IssuesTab } from "./pages/project/IssuesTab";
import { EnvironmentsTab } from "./pages/project/EnvironmentsTab";
import { ApiKeysTab } from "./pages/project/ApiKeysTab";
import { ProjectSettingsTab } from "./pages/project/ProjectSettings";
import { CiTab } from "./pages/project/CiTab";
import { SchedulesTab } from "./pages/project/SchedulesTab";
import { ClientsPage } from "./pages/Clients";
import { MembersPage } from "./pages/Members";
import { AuditPage } from "./pages/Audit";
import { ReportsPage } from "./pages/Reports";
import { PublicReportPage } from "./pages/PublicReport";
import { NotificationsPage } from "./pages/Notifications";
import { OrgSettingsPage } from "./pages/OrgSettings";
import { NotFoundPage, NoOrgPage } from "./pages/NotFound";
import { PrivacyPage, TermsPage } from "./pages/Legal";
import { AccountPage } from "./pages/Account";

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <Loading label="Signing you in…" />;
  if (status === "signed-out") return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function Home() {
  const { orgs } = useAuth();
  let last: string | null = null;
  try { last = localStorage.getItem("qa.lastOrg"); } catch { /* storage unavailable */ }
  const target = orgs.find((o) => o.id === last) ?? orgs[0];
  return target ? <Navigate to={`/o/${target.id}`} replace /> : <NoOrgPage />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/r/:token" element={<PublicReportPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/invite" element={<RequireAuth><AcceptInvitePage /></RequireAuth>} />
      <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
      <Route path="/o/:orgId" element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<OverviewPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<Navigate to="runs" replace />} />
          <Route path="runs" element={<RunsTab />} />
          <Route path="runs/:runId" element={<RunDetailPage />} />
          <Route path="issues" element={<IssuesTab />} />
          <Route path="issues/:issueId" element={<IssuesTab />} />
          <Route path="environments" element={<EnvironmentsTab />} />
          <Route path="api-keys" element={<ApiKeysTab />} />
          <Route path="ci" element={<CiTab />} />
          <Route path="schedules" element={<SchedulesTab />} />
          <Route path="settings" element={<ProjectSettingsTab />} />
        </Route>
        <Route path="clients" element={<ClientsPage />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="settings" element={<OrgSettingsPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
