// Leitplanken: Muster-Tabelle. Jede Regel mit mehreren blockierten Varianten und harmlosen
// Ähnlichkeiten, die NICHT blockiert werden dürfen (die Arbeit des Nutzers soll nicht leiden).
import type { GuardRule } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { classifyCommand, type GuardInput } from "../src/guard/rules.js";

const HOME = "/Users/alex";
const WT = "/Users/alex/code/nyxos/.worktrees/agent-t01";
const MAIN_CHECKOUT = "/Users/alex/code/nyxos";

const base: GuardInput = {
  tool: "Bash",
  command: "",
  cwd: WT,
  worktreeRoot: WT,
  currentBranch: "auftrag/t-01",
  env: { HOME, NYXOS_AUFTRAG: "T-01" },
  // Produktionsserver dieses Tests: Host-Alias, IP (TEST-NET) und eine Domain samt Unter-Domains.
  prodHosts: ["prod-server", "203.0.113.10", "*.shop.example"],
};

type Case = [command: string, expected: GuardRule | null, overrides?: Partial<GuardInput>];

const onMain: Partial<GuardInput> = { currentBranch: "main" };

const cases: Case[] = [
  // ── git_push ──────────────────────────────────────────────
  ["git push", "git_push"],
  ["git push origin auftrag/t-01", "git_push"],
  ["git push --force origin HEAD", "git_push"],
  ["git -C ../other push", "git_push"],
  ["pnpm test && git push", "git_push"],
  ["git commit -m x; git push -u origin HEAD", "git_push"],
  ["false || git push", "git_push"],
  ["echo ok | git push", "git_push"],
  ['bash -c "git push origin main"', "git_push"],
  ["sh -c 'cd /tmp && git push'", "git_push"],
  ['eval "git push"', "git_push"],
  ["echo $(git push)", "git_push"],
  ["echo `git push`", "git_push"],
  ["/usr/bin/git push", "git_push"],
  ["env GIT_TRACE=1 git push", "git_push"],
  ["FOO=1 git push", "git_push"],
  ["(git push)", "git_push"],
  ["bash <<'EOF'\ngit push\nEOF", "git_push"],
  ["git --no-pager -c user.name=x push", "git_push"],
  ["timeout 30 git push", "git_push"],
  ["git push origin --delete old-branch", "git_push"],
  // harmlos
  ["git push --dry-run", null],
  ["git push -n origin HEAD", null],
  ['echo "git push"', null],
  ['grep -r "git push" .', null],
  ["git log --grep=push", null],
  ['git commit -m "push-Knopf repariert"', null],
  ["git status && git diff", null],
  ["cat docs/git-push.md", null],
  ["# git push\nls", null],

  // ── merge_main ────────────────────────────────────────────
  ["git merge auftrag/t-01", "merge_main", onMain],
  ["git rebase auftrag/t-01", "merge_main", onMain],
  ["git reset --hard HEAD~1", "merge_main", onMain],
  ["git cherry-pick abc123", "merge_main", onMain],
  ["git pull", "merge_main", onMain],
  ["git checkout main && git merge auftrag/t-01", "merge_main"],
  ["git switch main; git merge --no-ff auftrag/t-01", "merge_main"],
  ["git update-ref refs/heads/main HEAD", "merge_main"],
  ["git branch -f main HEAD", "merge_main"],
  ["git branch -M main", "merge_main"],
  ["git checkout -B main", "merge_main"],
  ["git fetch . HEAD:main", "merge_main"],
  ["git rebase auftrag/t-01 main", "merge_main"],
  [`git -C ${MAIN_CHECKOUT} merge auftrag/t-01`, "merge_main"],
  [`cd ${MAIN_CHECKOUT} && git merge auftrag/t-01`, "merge_main"],
  // harmlos (Nachziehen auf dem Auftrags-Zweig, Lesen)
  ["git merge main", null],
  ["git rebase main", null],
  ["git pull origin main", null],
  ["git log main..HEAD", null],
  ["git diff main", null],
  ["git merge-tree main HEAD", null],
  ["git merge-base main HEAD", null],
  ["git checkout -b auftrag/t-02 main", null],
  ["git rebase --abort", null, onMain],
  ["git reset --hard origin/main", null],

  // ── deploy ────────────────────────────────────────────────
  ["./deploy.sh", "deploy"],
  ["scripts/deploy.sh --migrate", "deploy"],
  ["bash scripts/deploy.sh", "deploy"],
  ["docker compose up -d --build", "deploy"],
  ["docker compose -f infra/compose.yml -p nyxos down", "deploy"],
  ["docker-compose restart api", "deploy"],
  ["docker rm -f shop-api", "deploy"],
  ["docker stop nyxos-server", "deploy"],
  ["docker run --rm alpine true", "deploy"],
  ["ssh prod-server 'cd ~/shop && docker compose up -d'", "deploy"],
  ["ssh -p 2222 prod-server git pull", "deploy"],
  ["scripts/ssh.sh docker compose restart", "deploy"],
  ["ssh prod-server", "deploy"],
  ["rsync -av dist/ prod-server:/srv/nyxos/", "deploy"],
  ["scp build.tar.gz root@203.0.113.10:/tmp/", "deploy"],
  ["echo up | ssh prod-server", "deploy"],
  // harmlos
  ["cat deploy.sh", null],
  ["docker ps", null],
  ["docker compose ps", null],
  ["docker compose logs -f api", null],
  ["ssh prod-server docker logs shop-api", null],
  ["scripts/ssh.sh 'docker ps && df -h'", null],
  ["ssh prod-server tail -n 50 /var/log/syslog", null],
  ["scp prod-server:/var/log/app.log /tmp/app.log", null],
  ["rsync -av prod-server:/srv/logs/ /tmp/logs/", null],
  ["grep -n deploy scripts/deploy.sh", null],

  // ── migration ─────────────────────────────────────────────
  ["bash ~/shop/backend/deploy_db.sh", "migration"],
  ["./deploy_db.sh", "migration"],
  ["psql -h 203.0.113.10 -U nyxos -f migration.sql", "migration"],
  ["psql postgres://nyxos:pw@db.example.com:5432/nyxos -c 'select 1'", "migration"],
  ["psql --host=prod-server -d nyxos", "migration"],
  ["docker exec -i shop-postgres psql -d nyxos -f x.sql", "migration"],
  ["ssh prod-server docker exec shop-postgres psql -d dashboard -c 'select 1'", "migration"],
  ["npx drizzle-kit migrate", "migration"],
  ["pnpm --filter @nyxos/server exec drizzle-kit push", "migration"],
  ["PGHOST=203.0.113.10 psql -d nyxos", "migration"],
  // harmlos
  ["psql -h localhost -d nyxos_test -c 'select 1'", null],
  ["psql -h 127.0.0.1 -c 'select 1'", null],
  ["psql -d nyxos_test -c 'select 1'", null],
  // Seit Skript-Datei mit unbekanntem Inhalt → Freigabe
  ["scripts/backup_db.sh --label vor-p7", "unchecked"],
  ["pnpm --filter @nyxos/server exec drizzle-kit generate", null],
  ["cat apps/server/drizzle/0007_p7.sql", null],

  // ── delete_outside_worktree ───────────────────────────────
  ["rm -rf ~/code/app", "delete_outside_worktree"],
  ["rm -rf /Users/alex/Documents", "delete_outside_worktree"],
  ["rm -rf ../other-worktree", "delete_outside_worktree"],
  ["cd .. && rm -rf agent-t01", "delete_outside_worktree"],
  ["cd /Users/alex && rm notes.txt", "delete_outside_worktree"],
  ["rm -rf $TARGET", "delete_outside_worktree"],
  ["rm -rf ../*", "delete_outside_worktree"],
  ["rmdir /Users/alex/leer", "delete_outside_worktree"],
  ["unlink /Users/alex/.zshrc", "delete_outside_worktree"],
  ["find /Users/alex/code -name '*.log' -delete", "delete_outside_worktree"],
  ["find .. -name x -exec rm {} \\;", "delete_outside_worktree"],
  [`git -C ${MAIN_CHECKOUT} clean -fdx`, "delete_outside_worktree"],
  [`git worktree remove ${MAIN_CHECKOUT}/.claude/worktrees/agent-other`, "delete_outside_worktree"],
  ["git branch -D auftrag/a02-fremd", "delete_outside_worktree"],
  ["rm -rf .", "delete_outside_worktree"],
  ["sudo rm -rf /usr/local/lib/x", "delete_outside_worktree"],
  ["xargs rm < liste.txt", "delete_outside_worktree"],
  // harmlos
  ["rm -rf node_modules", null],
  ["rm -rf apps/web/dist apps/server/dist", null],
  [`rm -f ${WT}/tmp.txt`, null],
  ["rm /tmp/x", null],
  ["rm -rf /private/tmp/nyxos-test-123", null],
  ["rm -rf /var/folders/ab/cd/T/nyxos-x", null],
  ["cd apps/web && rm -rf dist", null],
  ["rm -rf *.log", null],
  ["find . -name '*.tmp' -delete", null],
  ["git clean -fdx", null],
  ["git clean -n -d ..", null],
  ["git branch -D auftrag/t-01-alt", null],
  ["echo rm -rf /", null],

  // ── session_close / entry_done ────────────────────────────
  ["curl -X POST http://127.0.0.1:47801/api/sessions/claude:abc/close", "session_close"],
  ["curl -s -XPOST -H 'content-type: application/json' localhost:47800/api/sessions/claude%3Aabc/close -d '{}'", "session_close"],
  ["wget --post-data='' http://127.0.0.1:47801/api/sessions/x/close", "session_close"],
  ['curl -X PATCH http://127.0.0.1:47801/api/entries/12 -d \'{"stage":"erledigt"}\'', "entry_done"],
  ['curl -X PATCH localhost:47801/api/entries/12 --data \'{"stage": "erledigt"}\' -H "content-type: application/json"', "entry_done"],
  ["node -e \"fetch('http://127.0.0.1:47801/api/sessions/x/close',{method:'POST'})\"", "session_close"],
  // harmlos
  ["curl -s http://127.0.0.1:47801/api/sessions", null],
  ["curl -X POST http://127.0.0.1:47801/api/sessions/x/reopen", null],
  ['echo \'{"stage":"erledigt"}\'', null],
  ["grep -rn '/close' apps/server/src", null],
];

describe("classifyCommand – Muster-Tabelle", () => {
  it("hat mindestens 60 Fälle", () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  for (const [command, expected, overrides] of cases) {
    it(`${expected ?? "erlaubt"} ← ${JSON.stringify(command)}${overrides?.currentBranch ? ` (auf ${overrides.currentBranch})` : ""}`, () => {
      const hit = classifyCommand({ ...base, ...overrides, command });
      expect(hit?.rule ?? null).toBe(expected);
      if (hit) expect(hit.reason.length).toBeGreaterThan(5);
    });
  }
});

describe("classifyCommand – Rahmen", () => {
  it("prüft nur das Werkzeug Bash", () => {
    expect(classifyCommand({ ...base, tool: "Write", command: "git push" })).toBeNull();
    expect(classifyCommand({ ...base, tool: "Edit", command: "rm -rf /" })).toBeNull();
  });

  it("ohne bekannte Worktree ist Löschen außerhalb von tmp unklar → blockiert", () => {
    expect(classifyCommand({ ...base, worktreeRoot: null, command: "rm -rf build" })?.rule).toBe("delete_outside_worktree");
    expect(classifyCommand({ ...base, worktreeRoot: null, command: "rm -rf /tmp/x" })).toBeNull();
  });

  it("stürzt bei kaputten Eingaben nicht ab", () => {
    for (const command of ['echo "offen', "echo $(", "`", "((((", "<<EOF", "git push '", "\\"]) {
      expect(() => classifyCommand({ ...base, command })).not.toThrow();
    }
  });

  it("offene Anführungszeichen verstecken git push nicht", () => {
    expect(classifyCommand({ ...base, command: "git push '" })?.rule).toBe("git_push");
  });
});

// ── Mutationen, die grün blieben, und Umgehungen ──
const hardening: Case[] = [
  // M2: fremdes git-Verzeichnis (--git-dir/--work-tree) → Zweig unbekannt
  [`git --git-dir=${MAIN_CHECKOUT}/.git merge auftrag/t-01`, "merge_main"],
  ["git --work-tree=. --git-dir ../x/.git reset --hard", "merge_main"],
  // M3: master zählt wie main
  ["git merge auftrag/t-01", "merge_main", { currentBranch: "master" }],
  ["git update-ref refs/heads/master HEAD", "merge_main"],
  // M4: tmp-Ordner selbst sind nicht löschbar
  ["rm -rf /tmp", "delete_outside_worktree"],
  ["rm -rf /private/tmp/", "delete_outside_worktree"],
  ["rm -rf /var/folders", "delete_outside_worktree"],
  // M5: Globs mit ..
  ["rm -rf */../../x", "delete_outside_worktree"],
  ["rm -rf apps/*/../../../y", "delete_outside_worktree"],
  // M8: kombinierte Schalter mit c
  ['bash -lc "git push"', "git_push"],
  ["zsh -ec 'git push'", "git_push"],
  // M9: Skript über eine Pipe
  ["echo 'git push' | bash", "git_push"],
  ["printf 'git push\\n' | sh", "git_push"],
  // M12: variabler Datenbank-Host
  ["psql -h $DBHOST -c 'select 1'", "migration"],
  ['psql --host="$H" -d x', "migration"],
  ["psql postgres://u@localhost/$DB -c 'select 1'", null],

  // gh: Merge über GitHub
  ["gh pr merge 12 --squash", "merge_main"],
  ["gh pr merge --auto --merge", "merge_main"],
  ["gh api -X PUT repos/o/r/pulls/12/merge", "merge_main"],
  ["gh api --method PATCH repos/o/r/git/refs/heads/main -f sha=abc", "merge_main"],
  ["gh pr view 12", null],
  ["gh pr list --state open", null],
  ["gh api repos/o/r/pulls/12", null],
  // Shell ohne Argumente auf dem Server
  ["ssh prod-server bash -s < x.sh", "deploy"],
  ["ssh prod-server bash", "deploy"],
  ["scripts/ssh.sh sh", "deploy"],
  // pnpm/yarn mit Programm-Name ohne exec/run
  ["pnpm drizzle-kit migrate", "migration"],
  ["yarn drizzle-kit push", "migration"],
  ["pnpm db:migrate", "migration"],
  ["pnpm test", null],
  ["pnpm vitest run apps/bridge", null],
  ["pnpm drizzle-kit generate", null],
  // git-Aliase
  ["git -c alias.p=push p", "git_push"],
  ["git config alias.x push && git x", "git_push"],
  ["git config --global alias.mm 'merge --no-ff'", "merge_main"],
  ["git config alias.sh '!git push'", "git_push"],
  ["git config alias.st status", null],
  // Seit `-c alias.*` im Aufruf gilt als nicht prüfbar
  ["git -c alias.l=log l --oneline", "unchecked"],
  // Befehl aus Variable
  ["G=git; $G push", "git_push"],
  ["export G=git && $G push origin", "git_push"],
  ["$GIT push", "git_push"],
  ["X=rm; $X -rf /Users/alex/x", "delete_outside_worktree"],
  ["$CMD merge auftrag/t-01", "merge_main"],
  ["G=git; $G status", null],
  ["$EDITOR README.md", null],
  // Code-Einzeiler
  ["python3 -c \"import subprocess; subprocess.run(['git','push'])\"", "git_push"],
  ["node -e \"require('child_process').execSync('git merge x')\"", "merge_main"],
  ["python3 -c \"import shutil; shutil.rmtree('/Users/alex/x')\"", "delete_outside_worktree"],
  ["perl -e 'unlink \"/etc/x\"'", "delete_outside_worktree"],
  ["ruby -e 'system(\"docker compose up\")'", "deploy"],
  ["python3 -c \"import os; os.system('psql -h db -c x')\"", "migration"],
  ["node -e \"require('child_process').execSync('ssh prod-server ls')\"", "deploy"],
  ['node -e "console.log(1+1)"', null],
  ["python3 -c 'import json,sys; print(json.load(sys.stdin))'", null],
  // env -S
  ["env -S 'git push'", "git_push"],
  ["env -S'git push origin'", "git_push"],
  // weitere Push-Wege
  ["git subtree push --prefix=docs origin gh-pages", "git_push"],
  ["git send-pack origin HEAD", "git_push"],
  ["git subtree split --prefix=docs", null],
  // rsync --delete / mv von außen
  ["rsync -a --delete build/ /Users/alex/Sites/app/", "delete_outside_worktree"],
  ["rsync -a --delete dist/ backup-host:/srv/x/", "delete_outside_worktree"],
  ["rsync -a --delete dist/ build/copy/", null],
  ["rsync -a dist/ /Users/alex/Desktop/", null],
  ["mv /Users/alex/Documents/wichtig.txt .", "delete_outside_worktree"],
  ["mv ../other-worktree /tmp/x", "delete_outside_worktree"],
  ["mv -t /tmp /Users/alex/a", "delete_outside_worktree"],
  ["mv a.txt b.txt", null],
  ["mv /tmp/x ./x", null],
  ["mv dist/app.zip /Users/alex/Desktop/", null],
  // API: Körper aus Datei, URL-Kodierung
  ["curl -X PATCH localhost:47801/api/entries/12 -d @patch.json", "entry_done"],
  ["curl -X PATCH localhost:47801/api/entries/12 --data-binary @-", "entry_done"],
  ["curl -X POST http://127.0.0.1:47801/api/sessions/x/%63lose", "session_close"],
  ["curl -X POST http://127.0.0.1:47801/api/sessions/x%2Fclose", "session_close"],
  ["curl -s localhost:47801/api/entries/12", null],
  ["curl -X PATCH localhost:47801/api/entries/12 -d '{\"title\":\"x\"}'", null],
  // ssh: Host aus Variable oder Option
  ["ssh $H 'docker compose up -d'", "deploy"],
  ["ssh -o HostName=203.0.113.10 box git pull", "deploy"],
  ["ssh -o HostName=10.0.0.5 box docker compose restart", "deploy"],
  ["ssh $H docker ps", null],
  ["ssh -T git@github.com", null],
];

describe("classifyCommand – Nachbesserung", () => {
  for (const [command, expected, overrides] of hardening) {
    it(`${expected ?? "erlaubt"} ← ${JSON.stringify(command)}${overrides?.currentBranch ? ` (auf ${overrides.currentBranch})` : ""}`, () => {
      expect(classifyCommand({ ...base, ...overrides, command })?.rule ?? null).toBe(expected);
    });
  }

  it("variabler Datenbank-Host wird als solcher benannt", () => {
    for (const command of ["psql -h $DBHOST -c 'select 1'", "PGHOST=$X psql -d nyxos", 'psql "host=$H dbname=x"']) {
      const h = classifyCommand({ ...base, command });
      expect(h?.rule, command).toBe("migration");
      expect(h?.reason, command).toContain("variabl");
    }
  });

  it("Fehler beim Zerlegen/Lesen → Notfall-Zweig blockiert git push, Harmloses bleibt frei", () => {
    const env = new Proxy({} as Record<string, string | undefined>, {
      get() {
        throw new Error("kaputte Umgebung");
      },
    });
    expect(classifyCommand({ ...base, env, command: "git push" })?.rule).toBe("git_push");
    expect(classifyCommand({ ...base, env, command: "ls -la" })).toBeNull();
  });
});
