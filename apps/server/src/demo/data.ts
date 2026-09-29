// Demo mode: the complete invented workspace as plain data (no database). `seed.ts` writes it;
// tests use it to check what the demo contains.
import type { Lang } from "@nyxos/shared";
import { buildSessions, type BuiltSession } from "./build-sessions.js";
import { buildGit, type DemoGit } from "./data-git.js";
import {
  demoAgents,
  demoHaikuCalls,
  demoMemory,
  demoMemorySuggestion,
  demoProfile,
  demoSchedules,
  demoSessionAudits,
  demoSkills,
  demoSkillSuggestion,
  demoThreads,
  demoVault,
} from "./data-nyx.js";
import { buildUsage } from "./data-usage.js";
import {
  demoApprovals,
  demoBuilds,
  demoConflictEvents,
  demoDeploys,
  demoEntries,
  demoEntryLinks,
  demoInbox,
  demoReservations,
  demoRules,
  demoSortRules,
} from "./data-work.js";

export function buildDemoData(now: number, lang: Lang) {
  const sessions: BuiltSession[] = buildSessions(now, lang);
  const git: DemoGit = buildGit(now, sessions, lang);
  return {
    now,
    lang,
    sessions,
    sortRules: demoSortRules(),
    entries: demoEntries(),
    entryLinks: demoEntryLinks(),
    inbox: demoInbox(),
    approvals: demoApprovals(),
    builds: demoBuilds(lang),
    deploys: demoDeploys(),
    reservations: demoReservations(),
    conflictEvents: demoConflictEvents(),
    rules: demoRules(lang),
    git,
    usage: buildUsage(now, sessions),
    threads: demoThreads(),
    memory: demoMemory(),
    memorySuggestion: demoMemorySuggestion(),
    schedules: demoSchedules(),
    profile: demoProfile(lang),
    vault: demoVault(lang),
    agents: demoAgents(lang),
    skills: demoSkills(lang),
    skillSuggestion: demoSkillSuggestion(lang),
    sessionAudits: demoSessionAudits(lang),
    haikuCalls: demoHaikuCalls(),
  };
}

export type DemoData = ReturnType<typeof buildDemoData>;
