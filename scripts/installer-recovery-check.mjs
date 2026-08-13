#!/usr/bin/env node
// Regression checks for the narrowly scoped Keel 1.2.1 installer repair.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareDatabase, testPrisma } from "./test-db.mjs";
import { recoverV121InstallerEnv } from "./recover-v121-installer-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "keel installer recovery "));
const templateDatabase = path.join(scratch, "database template with spaces.db");
const templateUrl = `file:${templateDatabase.split(path.sep).join("/")}`;

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const shellInstaller = fs.readFileSync(path.join(root, "install.sh"), "utf8");
const powershellInstaller = fs.readFileSync(path.join(root, "install.ps1"), "utf8");

function exerciseShellRestartFailure(manager) {
  if (process.platform === "win32") return "skipped";
  const start = shellInstaller.indexOf("restart_stopped_managed_service() {");
  const endMarker = "\n}\n\non_installer_exit()";
  const end = shellInstaller.indexOf(endMarker, start);
  if (start < 0 || end < 0) return "function-not-found";
  const restartFunction = shellInstaller.slice(start, end + 3);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `${restartFunction}
ok() { :; }
launchctl() { return 41; }
systemctl() { return 42; }
STOPPED_MANAGED_SERVICE=${manager}
STOPPED_MANAGED_PLIST=/tmp/keel-test.plist
restart_stopped_managed_service
status=$?
printf '%s|%s' "$status" "$STOPPED_MANAGED_SERVICE"
`,
    ],
    { encoding: "utf8" },
  );
  return result.stdout;
}

console.log("\nManaged-service update boundary\n");
check(
  "the shell installer stops a verified manager before changing dependencies",
  shellInstaller.indexOf("stop_managed_service_for_update") < shellInstaller.indexOf("npm ci --no-audit --no-fund"),
);
check(
  "the shell installer verifies launchd and systemd working directories",
  shellInstaller.includes("Print :WorkingDirectory") &&
    shellInstaller.includes("--property=WorkingDirectory --value") &&
    shellInstaller.includes('managed_dir" = "$target_dir'),
);
check(
  "the shell installer restores a stopped service after failure",
  shellInstaller.includes("trap 'on_installer_exit $?' EXIT") &&
    shellInstaller.includes("attempting to restore the previously running service") &&
    shellInstaller.includes('if ! launchctl load -w "$STOPPED_MANAGED_PLIST"') &&
    shellInstaller.includes("if ! systemctl --user start keel.service"),
);
check(
  "a failed launchd restart is reported and remains recoverable",
  exerciseShellRestartFailure("launchd") === (process.platform === "win32" ? "skipped" : "1|launchd"),
);
check(
  "a failed systemd restart is reported and remains recoverable",
  exerciseShellRestartFailure("systemd") === (process.platform === "win32" ? "skipped" : "1|systemd"),
);
check(
  "the PowerShell installer verifies the scheduled task action and working directory",
  powershellInstaller.includes('$taskExecutable -ieq "cmd.exe"') &&
    powershellInstaller.includes("[string]::Equals($targetDir, $taskDir") &&
    powershellInstaller.includes("Stop-ScheduledTask -TaskName \"Keel\""),
);
check(
  "a successful PowerShell -Service update replaces the stopped task without first restarting it",
  powershellInstaller.includes(
    "if ($stoppedManagedTask -and (-not $installSucceeded -or -not $Service))",
  ) &&
    !powershellInstaller.includes("Unregister-ScheduledTask -TaskName $taskName") &&
    powershellInstaller.includes('-Description "Keel workspace server" -Force'),
);
check(
  "every PowerShell service-preparation failure restores the preserved task definition",
  powershellInstaller.includes('$stoppedManagedTaskXml = Export-ScheduledTask -TaskName "Keel"') &&
    powershellInstaller.indexOf('try {\n    Say "Registering the startup task"') <
      powershellInstaller.indexOf('$npmCmd   = (Get-Command npm -ErrorAction Stop).Source') &&
    powershellInstaller.includes(
      'Register-ScheduledTask -TaskName "Keel" -Xml $stoppedManagedTaskXml -Force',
    ),
);
check(
  "the PowerShell installer always attempts to restore the stopped task",
  powershellInstaller.includes("} finally {") &&
    powershellInstaller.includes("Start-ScheduledTask -TaskName \"Keel\""),
);

function legacyEnv(databaseUrl, options = {}) {
  const {
    installer = "install.sh",
    newline = "\n",
    bom = "",
    owner = "owner@example.test",
    accessComments = [
      "# Only these accounts may sign in, and no new sign-ups. Remove both lines to",
      "# open the instance up.",
    ],
    databaseLine = `DATABASE_URL="${databaseUrl}"`,
  } = options;
  return bom + [
    `# Generated by ${installer} on 2026-08-12T12:34:56Z`,
    "",
    databaseLine,
    "PORT=3000",
    "",
    "# Who runs this instance. Gates the admin portal, the sign-in allowlist and the",
    "# tunnel - this is NOT the same as owning a workspace (every account owns one).",
    `KEEL_OWNER_EMAIL="${owner}"`,
    "",
    ...accessComments,
    `KEEL_ALLOWED_EMAILS="${owner}"`,
    "KEEL_DISABLE_SIGNUP=1",
    "",
    "# Passphrase for encrypted backups. Keep a copy somewhere safe - without it an",
    "# encrypted backup cannot be restored.",
    "KEEL_BACKUP_PASSPHRASE=\"0123456789abcdefghijklmnopqrstuv\"",
    "",
    `KEEL_BACKUP_DIR="${path.join(scratch, "backups with spaces")}"`,
    "",
  ].join(newline);
}

function caseFiles(name, databaseSource = templateDatabase) {
  const directory = path.join(scratch, name);
  fs.mkdirSync(directory, { recursive: true });
  const database = path.join(directory, "keel data with spaces.db");
  if (databaseSource) fs.copyFileSync(databaseSource, database);
  return {
    directory,
    database,
    databaseUrl: `file:${database.split(path.sep).join("/")}`,
    envFile: path.join(directory, ".env"),
  };
}

async function expectUnchanged(name, contents, files) {
  fs.writeFileSync(files.envFile, contents, { mode: 0o600 });
  const before = fs.readFileSync(files.envFile);
  const result = await recoverV121InstallerEnv(files.envFile);
  const after = fs.readFileSync(files.envFile);
  check(name, result.status === "unchanged" && before.equals(after), result.reason);
}

try {
  prepareDatabase(root, templateUrl);

  console.log("\nExact Keel 1.2.1 recovery\n");
  {
    const files = caseFiles("shell path with spaces");
    const secret = "KEEL_BACKUP_PASSPHRASE=\"0123456789abcdefghijklmnopqrstuv\"";
    const contents = legacyEnv(files.databaseUrl);
    fs.writeFileSync(files.envFile, contents, { mode: 0o640 });
    const beforeMode = fs.statSync(files.envFile).mode & 0o777;
    const result = await recoverV121InstallerEnv(files.envFile);
    const repaired = fs.readFileSync(files.envFile, "utf8");
    const afterMode = fs.statSync(files.envFile).mode & 0o777;
    check("the exact shell-installer template is repaired", result.status === "repaired", result.reason);
    check("the owner allowlist remains", repaired.includes('KEEL_ALLOWED_EMAILS="owner@example.test"'));
    check("the unconditional signup stop is removed", !repaired.includes("KEEL_DISABLE_SIGNUP"));
    check("the repaired access comment matches the new behavior", repaired.includes("Only this account may register or sign in"));
    check("backup secrets remain byte-for-byte intact", repaired.includes(secret));
    check("the secret file mode is preserved", beforeMode === afterMode, `${beforeMode.toString(8)} -> ${afterMode.toString(8)}`);
    check(
      "the atomic replacement leaves no sibling temporary file",
      fs.readdirSync(files.directory).every((entry) => !entry.includes(".keel-recovery-")),
    );
    const second = await recoverV121InstallerEnv(files.envFile);
    check("a repaired file is idempotently left alone", second.status === "unchanged", second.reason);
  }

  {
    const files = caseFiles("powershell CRLF and BOM");
    fs.writeFileSync(files.envFile, legacyEnv(files.databaseUrl, {
      installer: "install.ps1",
      newline: "\r\n",
      bom: "\uFEFF",
    }), { mode: 0o600 });
    const result = await recoverV121InstallerEnv(files.envFile);
    const repaired = fs.readFileSync(files.envFile, "utf8");
    check("the exact PowerShell template with CRLF and BOM is repaired", result.status === "repaired", result.reason);
    check("PowerShell newline and BOM encoding are preserved", repaired.startsWith("\uFEFF") && !/(^|[^\r])\n/.test(repaired));
  }

  {
    const files = caseFiles("relative database path with spaces");
    const relativeUrl = "file:keel data with spaces.db";
    fs.writeFileSync(files.envFile, legacyEnv(relativeUrl), { mode: 0o600 });
    const result = await recoverV121InstallerEnv(files.envFile);
    check(
      "a quoted relative SQLite path is resolved from the install directory",
      result.status === "repaired",
      result.reason,
    );
  }

  console.log("\nFail-closed recognition\n");
  {
    const files = caseFiles("current intentional hard stop");
    await expectUnchanged(
      "a current intentional hard stop is untouched",
      legacyEnv(files.databaseUrl, {
        accessComments: [
          "# Registration and sign-in are restricted to the instance administrator.",
          "# This hard stop was intentionally added after bootstrap.",
        ],
      }),
      files,
    );
  }
  {
    const files = caseFiles("modified legacy comment");
    await expectUnchanged(
      "a modified legacy access block is untouched",
      legacyEnv(files.databaseUrl).replace("Remove both lines", "Remove these lines"),
      files,
    );
  }
  {
    const files = caseFiles("missing provenance");
    await expectUnchanged(
      "a file without installer provenance is untouched",
      legacyEnv(files.databaseUrl).replace(/^# Generated[^\n]+\n/, "# Hand configured\n"),
      files,
    );
  }
  {
    const files = caseFiles("unquoted sqlite");
    await expectUnchanged(
      "an unquoted SQLite URL is untouched",
      legacyEnv(files.databaseUrl, { databaseLine: `DATABASE_URL=${files.databaseUrl}` }),
      files,
    );
  }
  {
    const files = caseFiles("single quoted sqlite");
    await expectUnchanged(
      "a single-quoted SQLite URL is untouched",
      legacyEnv(files.databaseUrl, { databaseLine: `DATABASE_URL='${files.databaseUrl}'` }),
      files,
    );
  }
  {
    const files = caseFiles("postgresql");
    await expectUnchanged(
      "a PostgreSQL URL is untouched",
      legacyEnv("postgresql://owner:secret@localhost/keel", {
        databaseLine: 'DATABASE_URL="postgresql://owner:secret@localhost/keel"',
      }),
      files,
    );
  }
  {
    const files = caseFiles("missing database", null);
    await expectUnchanged(
      "a missing SQLite database is untouched",
      legacyEnv(files.databaseUrl),
      files,
    );
  }
  {
    const files = caseFiles("nonempty database");
    const prisma = await testPrisma(root, files.databaseUrl);
    try {
      await prisma.user.create({ data: { email: "existing@example.test", name: "Existing" } });
    } finally {
      await prisma.$disconnect();
    }
    await expectUnchanged(
      "a database with an existing user is untouched",
      legacyEnv(files.databaseUrl),
      files,
    );
  }
  {
    const files = caseFiles("unmigrated database", null);
    fs.writeFileSync(files.database, "");
    await expectUnchanged(
      "an unmigrated database is untouched",
      legacyEnv(files.databaseUrl),
      files,
    );
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const failure of failures) console.log(`  \x1b[31m✗\x1b[0m ${failure}`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
