import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../../api/client";
import { useAction } from "../../api/queries";
import { useCurrentOrg } from "../../lib/org";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ErrorAlert, Field, When } from "../../components/ui";

export function IssueDiscussion({ issueId }: { issueId: string }) {
  const { orgId, can, org } = useCurrentOrg();
  const { projectId } = useParams();
  const { user } = useAuth();
  const [body, setBody] = useState("");
  const key = ["org", orgId, "project", projectId, "discussion", issueId];
  const path = `/orgs/${orgId}/projects/${projectId}/collaboration/issues/${issueId}`;
  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<{ comments: Array<{ id: string; body: string; authorId: string; authorName: string | null; createdAt: string }>; nextBefore: string | null }>("GET", `${path}/comments${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const sync = useQuery({ queryKey: [...key, "sync"], queryFn: () => api<{ deliveries: Array<{ id: string; status: string; remoteUrl: string | null; lastError: string | null }> }>("GET", `${path}/sync`), refetchInterval: 15000 });
  const post = useAction(() => api("POST", `${path}/comments`, { body }), [key]);
  const remove = useAction((id: string) => api("DELETE", `${path}/comments/${id}`), [key]);
  const send = useAction(() => api("POST", `${path}/sync`, {}), [key]);
  return <section style={{ display: "grid", gap: 10 }} aria-label="Issue discussion">
    <h3>Discussion</h3><ErrorAlert error={q.error ?? post.error ?? remove.error} />
    {q.data?.pages.flatMap((page) => page.comments).map((c) => <article key={c.id} className="alert"><strong>{c.authorName ?? "Deleted member"}</strong> · <When at={c.createdAt} /><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.body}</p>
      {can("issues.triage") && (c.authorId === user?.id || ["owner", "admin"].includes(org?.role ?? "")) && <Button size="sm" busy={remove.isPending} onClick={() => remove.mutate(c.id)}>Delete comment</Button>}</article>)}
    {q.hasNextPage && <Button size="sm" busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Show older comments</Button>}
    {can("issues.triage") && <form className="form" onSubmit={async (e) => { e.preventDefault(); try { await post.mutateAsync(undefined); setBody(""); } catch {} }}>
      <Field label="Add a comment" hint="Visible to project members. Do not include passwords or tokens.">{(id) => <textarea id={id} className="input" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} required />}</Field>
      <Button type="submit" busy={post.isPending}>Post comment</Button>
    </form>}
    <h3>External issue</h3><ErrorAlert error={sync.error ?? send.error} />
    {sync.data?.deliveries.map((d) => <p key={d.id} className="small">{d.status}{d.remoteUrl && <> · <a href={d.remoteUrl} target="_blank" rel="noreferrer">Open external issue</a></>}{d.lastError && <> · {d.lastError}</>}</p>)}
    {can("issues.triage") && <Button busy={send.isPending} onClick={() => send.mutate(undefined)}>Sync current issue</Button>}
  </section>;
}

export function IssueIntegrationSettings() {
  const { orgId } = useCurrentOrg(); const { projectId } = useParams();
  const path = `/orgs/${orgId}/projects/${projectId}/collaboration/integration`;
  const key = ["org", orgId, "project", projectId, "issueIntegration"];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ integration: { destination: string; enabled: boolean } | null; configured: boolean }>("GET", path) });
  const [destination, setDestination] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const save = useAction(() => api("PUT", path, { destination: destination ?? q.data?.integration?.destination ?? "", enabled: enabled ?? q.data?.integration?.enabled ?? false }), [key]);
  return <section className="panel"><div className="panel-head"><h2>Issue integration</h2></div><form className="panel-body form" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
    <p className="muted">{q.data?.configured ? "Send an issue snapshot using its Sync button. Delivery retries preserve the same idempotency key." : "An administrator must configure the issue gateway before delivery is enabled."}</p>
    <Field label="Destination" hint="Repository or project identifier understood by your gateway.">{(id) => <input id={id} className="input" value={destination ?? q.data?.integration?.destination ?? ""} onChange={(e) => setDestination(e.target.value)} required maxLength={200} />}</Field>
    <label><input type="checkbox" checked={enabled ?? q.data?.integration?.enabled ?? false} onChange={(e) => setEnabled(e.target.checked)} /> Enable delivery for this project</label>
    <ErrorAlert error={q.error ?? save.error} /><Button type="submit" busy={save.isPending}>Save issue integration</Button>
  </form></section>;
}
