// PG: Adapter für P5 (Git). `dbGitProvider` (I5-Zusammenbau) liest die echten P5-Tabellen
// (Commits, Zweige); `gitSource(provider)` hängt in `defaultGraphSources` ein.
import type { GraphLink } from "@nyxos/shared";
import type { Db } from "../../db/client.js";
import { desc, sql } from "drizzle-orm";
import { gitBranches, gitCommits } from "../../db/schema.js";
import type { GraphSource, SourceNode, SourceResult } from "../build.js";
import { sessionNodeId } from "./sessions.js";

export interface CommitRecord {
  sha: string;
  repo: string;
  subject: string;
  committedAt: string;
  branch?: string | null;
  /** Session-Schlüssel (`claude:<uuid>`), die diesen Commit erzeugt haben. */
  sessionKeys: string[];
}

export interface BranchRecord {
  name: string;
  repo: string;
}

export interface GitProvider {
  list(): Promise<{ commits: CommitRecord[]; branches?: BranchRecord[] }>;
}

export const commitNodeId = (repo: string, sha: string) => `commit:${repo}:${sha}`;
export const branchNodeId = (repo: string, name: string) => `branch:${repo}:${name}`;

export function gitSource(provider: GitProvider): GraphSource {
  return {
    name: "git",
    async load(): Promise<SourceResult> {
      const { commits, branches = [] } = await provider.list();
      const nodes: SourceNode[] = [];
      const links: GraphLink[] = [];
      const seenBranches = new Set<string>();
      const addBranch = (repo: string, name: string) => {
        const id = branchNodeId(repo, name);
        if (seenBranches.has(id)) return id;
        seenBranches.add(id);
        nodes.push({ id, type: "branch", label: name, group: repo, ref: { kind: "branch", name, repo } });
        return id;
      };
      for (const b of branches) addBranch(b.repo, b.name);
      for (const c of commits) {
        const id = commitNodeId(c.repo, c.sha);
        nodes.push({ id, type: "commit", label: `${c.sha.slice(0, 7)} ${c.subject}`, group: c.repo, ts: c.committedAt, ref: { kind: "commit", sha: c.sha, repo: c.repo } });
        if (c.branch) links.push({ source: id, target: addBranch(c.repo, c.branch), kind: "commit", weight: 1 });
        for (const key of c.sessionKeys) links.push({ source: sessionNodeId(key), target: id, kind: "commit", weight: 1 });
      }
      return { nodes, links };
    },
  };
}

/**
 * I5-Zusammenbau: echter `GitProvider` über die P5-Tabellen `git_commits`/`git_branches`. `repo` =
 * `git_repos.id` (stabiler, sprechender Schlüssel wie "app"/"worktree:notifications"/"nyxos",
 * s. Kommentar an `gitRepos` in db/schema.ts) — dieselbe Zeichenkette wie in P5s eigenen Routen.
 * `sessionKeys` kommt jetzt aus der Commit→Session-Zuordnung (git/attribution.ts), aber nur
 * bei „sicher“/„wahrscheinlich“ — eine bloße Vermutung zieht im Gehirn keine Linie. Seit die Brücke
 * 90 Tage Historie aller Zweige schickt, nur die jüngsten `GRAPH_COMMITS` Commits (das Gehirn soll
 * nicht in Hunderten Commit-Punkten ertrinken).
 */
const GRAPH_COMMITS = 300;

export function dbGitProvider(db: Db): GitProvider {
  return {
    async list() {
      const commitRows = await db
        .select({ sha: gitCommits.sha, repoId: gitCommits.repoId, subject: gitCommits.subject, authorDate: gitCommits.authorDate, branch: gitCommits.branch, sessionKey: gitCommits.sessionKey, confidence: gitCommits.sessionConfidence })
        .from(gitCommits)
        .orderBy(desc(sql`coalesce(${gitCommits.committedAt}, ${gitCommits.authorDate})`))
        .limit(GRAPH_COMMITS);
      const branchRows = await db.select({ repoId: gitBranches.repoId, name: gitBranches.name }).from(gitBranches);
      const linked = (c: { sessionKey: string | null; confidence: string | null }) => (c.sessionKey && (c.confidence === "sicher" || c.confidence === "wahrscheinlich") ? [c.sessionKey] : []);
      return {
        commits: commitRows.map((c) => ({ sha: c.sha, repo: c.repoId, subject: c.subject, committedAt: c.authorDate, branch: c.branch, sessionKeys: linked(c) })),
        branches: branchRows.map((b) => ({ repo: b.repoId, name: b.name })),
      };
    },
  };
}
