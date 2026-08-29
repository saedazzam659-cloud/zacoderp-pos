import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { centralDb, agentInstancesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Client } from "ssh2";
import { decryptSecret } from "./encryption.js";
import {
  withGuaranteedTransferCleanup,
  withPostSuccessCleanupWarning,
} from "./companyTransferCleanup.js";

type Agent = typeof agentInstancesTable.$inferSelect;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function transferAgent(agentId: number): Promise<Agent> {
  const [agent] = await centralDb.select().from(agentInstancesTable)
    .where(eq(agentInstancesTable.id, agentId)).limit(1);
  if (!agent || agent.status !== "active" || agent.dbStatus !== "initialized") {
    throw new Error("الوكيل غير موجود أو غير جاهز للنقل");
  }
  if (!agent.sshHost || !agent.sshUser || !agent.sshSecretEnc) {
    throw new Error(`الوكيل «${agent.name}» لا يملك اتصال SSH مهيأ لنقل المرفقات`);
  }
  if (!agent.sshHostKeyFp) {
    throw new Error(`اختبر اتصال SSH للوكيل «${agent.name}» أولًا لتثبيت بصمة الخادم`);
  }
  return agent;
}

async function withSsh<T>(agent: Agent, fn: (client: Client) => Promise<T>): Promise<T> {
  const secret = decryptSecret(agent.sshSecretEnc);
  if (!secret) throw new Error("تعذّر فك تشفير بيانات اتصال الوكيل");
  const isKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret);
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.end();
      reject(new Error("انتهت مهلة اتصال SSH بالوكيل"));
    }, 20_000);
    client.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.connect({
      host: agent.sshHost!,
      port: agent.sshPort ?? 22,
      username: agent.sshUser!,
      ...(isKey ? { privateKey: secret } : { password: secret }),
      readyTimeout: 15_000,
      hostVerifier: (key: Buffer) => {
        const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64")}`;
        return fingerprint === agent.sshHostKeyFp;
      },
    });
  });
  try {
    return await fn(client);
  } finally {
    client.end();
  }
}

async function execOnce(
  client: Client,
  command: string,
  stdin = "",
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let output = "";
      const append = (chunk: Buffer) => {
        if (output.length < 128_000) output += chunk.toString().slice(0, 128_000 - output.length);
      };
      stream.on("data", append);
      stream.stderr.on("data", append);
      stream.on("close", (code: number) => resolve({ code: code ?? 1, output }));
      stream.end(stdin);
    });
  });
}

async function execRootScript(
  client: Client,
  agent: Agent,
  script: string,
  timeoutMs = 30 * 60_000,
): Promise<string> {
  const secret = decryptSecret(agent.sshSecretEnc);
  if (!secret) throw new Error("تعذّر فك بيانات SSH");
  const isKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret);
  const run = async () => {
    if (agent.sshUser === "root") return execOnce(client, "bash -s", script);
    const probe = await execOnce(client, "sudo -n true 2>/dev/null; echo RC=$?");
    if (/RC=0/.test(probe.output)) return execOnce(client, "sudo bash -s", script);
    if (isKey) throw new Error("مستخدم SSH يحتاج NOPASSWD لتشغيل نقل المرفقات");
    return execOnce(client, "sudo -S -p '' bash -s", `${secret}\n${script}`);
  };
  const result = await Promise.race([
    run(),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("انتهت مهلة تجهيز حزمة المرفقات على الوكيل")),
      timeoutMs,
    )),
  ]);
  if (result.code !== 0) {
    throw new Error(`فشل أمر نقل المرفقات على الوكيل: ${result.output.slice(-1_000)}`);
  }
  return result.output;
}

async function sftpDownload(client: Client, remotePath: string, localPath: string): Promise<void> {
  const sftp = await new Promise<any>((resolve, reject) =>
    client.sftp((error, value) => error ? reject(error) : resolve(value)));
  await new Promise<void>((resolve, reject) =>
    sftp.fastGet(remotePath, localPath, (error: Error | undefined) => error ? reject(error) : resolve()));
  sftp.end();
}

async function sftpUpload(client: Client, localPath: string, remotePath: string): Promise<void> {
  const sftp = await new Promise<any>((resolve, reject) =>
    client.sftp((error, value) => error ? reject(error) : resolve(value)));
  await new Promise<void>((resolve, reject) =>
    sftp.fastPut(localPath, remotePath, (error: Error | undefined) => error ? reject(error) : resolve()));
  sftp.end();
}

function extractCliResult(output: string): any {
  const marker = "ZACOD_COMPANY_TRANSFER_RESULT=";
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(marker));
  if (!line) throw new Error(`لم يُرجع الوكيل نتيجة نقل صالحة: ${output.slice(-500)}`);
  return JSON.parse(Buffer.from(line.slice(marker.length), "base64").toString("utf8"));
}

export async function exportAgentPortablePackage(
  agentId: number,
  companyId: number,
  exportedBy: string | null,
): Promise<{ path: string; cleanup: () => Promise<void>; summary: { files: number; bytes: number } }> {
  const agent = await transferAgent(agentId);
  const dir = await mkdtemp(join(tmpdir(), "agent-company-export-"));
  const localPath = join(dir, "company.zacbackup");
  const remotePath = `/tmp/zacod-company-export-${randomUUID()}.zacbackup`;
  try {
    const result = await withSsh(agent, async (client) => {
      return withGuaranteedTransferCleanup(async () => {
        const output = await execRootScript(client, agent, `set -e
cd /opt/zacod/app
set -a
. /opt/zacod/app.env
set +a
node dist/companyTransferCli.mjs export ${companyId} ${shellQuote(remotePath)} ${shellQuote(exportedBy ?? "")}
chown ${shellQuote(agent.sshUser!)} ${shellQuote(remotePath)}
chmod 600 ${shellQuote(remotePath)}
`);
        const parsed = extractCliResult(output);
        await sftpDownload(client, remotePath, localPath);
        return parsed;
      }, async () => {
        await execRootScript(client, agent, `rm -f ${shellQuote(remotePath)}`, 60_000);
      });
    });
    return {
      path: localPath,
      summary: { files: Number(result.files ?? 0), bytes: Number(result.bytes ?? 0) },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreAgentPortablePackage(
  agentId: number,
  companyId: number,
  localPath: string,
): Promise<any> {
  const agent = await transferAgent(agentId);
  const remotePath = `/tmp/zacod-company-restore-${randomUUID()}.zacbackup`;
  return withSsh(agent, async (client) => {
    const settled = await withPostSuccessCleanupWarning(async () => {
      await sftpUpload(client, localPath, remotePath);
      const output = await execRootScript(client, agent, `set -e
cd /opt/zacod/app
set -a
. /opt/zacod/app.env
set +a
node dist/companyTransferCli.mjs restore ${companyId} ${shellQuote(remotePath)}
`);
      return extractCliResult(output);
    }, async () => {
      await execRootScript(client, agent, `rm -f ${shellQuote(remotePath)}`, 60_000);
    });
    return {
      ...settled.value,
      ...(settled.cleanupWarning ? { cleanupWarning: settled.cleanupWarning } : {}),
    };
  });
}

export async function assertAgentSshTransferReady(agentId: number): Promise<void> {
  const agent = await transferAgent(agentId);
  await withSsh(agent, async (client) => {
    const output = await execRootScript(client, agent, `set -e
test -f /opt/zacod/app/dist/companyTransferCli.mjs
test -f /opt/zacod/app.env
echo ZACOD_TRANSFER_READY
`, 60_000);
    if (!output.includes("ZACOD_TRANSFER_READY")) throw new Error("أداة نقل المرفقات غير جاهزة على الوكيل");
  });
}