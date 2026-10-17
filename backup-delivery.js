import fs from 'fs-extra';
import path from 'node:path';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export const s3Configured = config => !!(config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKey);
export function createS3Client(config, timeoutMs = 60000) {
  return new S3Client({ endpoint: config.s3Endpoint, region: config.s3Region,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey }, forcePathStyle: true,
    requestHandler: { connectionTimeout: Math.min(10000, timeoutMs), requestTimeout: timeoutMs }, maxAttempts: 2 });
}
export async function rotateS3Backups(client, config) {
  const items = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: 'nodeimage/backup-', ...(token ? { ContinuationToken: token } : {}) }));
    items.push(...(page.Contents || []));
    if (!page.IsTruncated) break;
    if (!page.NextContinuationToken || page.NextContinuationToken === token) throw new Error('Invalid S3 continuation token');
    token = page.NextContinuationToken;
  } while (true);
  items.sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0));
  for (const item of items.slice(config.keepCount)) await client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: item.Key }));
}
export async function deliverBackup(filePath, stamp, config, { timeoutMs = 60000 } = {}) {
  const s3 = async () => {
    if (!s3Configured(config)) return { type: 's3', skipped: true };
    const client = createS3Client(config, timeoutMs);
    const stream = fs.createReadStream(filePath);
    const task = new Upload({ client, params: { Bucket: config.s3Bucket, Key: `nodeimage/backup-${stamp}.tar.gz`, Body: stream, ContentType: 'application/gzip' } });
    const timer = setTimeout(() => { task.abort().catch(() => {}); stream.destroy(new Error('S3 backup timeout')); }, timeoutMs);
    try { await task.done(); await rotateS3Backups(client, config); return { type: 's3', success: true }; }
    finally { clearTimeout(timer); stream.destroy(); client.destroy(); }
  };
  const webhook = async () => {
    if (!config.webhookUrl) return { type: 'webhook', skipped: true };
    const stream = fs.createReadStream(filePath);
    try {
      const response = await fetch(config.webhookUrl, { method: 'POST', body: stream, duplex: 'half', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/gzip', 'X-Backup-Filename': `nodeimage-backup-${stamp}.tar.gz`, 'X-Backup-Timestamp': stamp } });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
      return { type: 'webhook', success: true };
    } finally { stream.destroy(); }
  };
  const settled = await Promise.allSettled([s3(), webhook()]);
  return settled.map((item, i) => item.status === 'fulfilled' ? item.value : { type: i ? 'webhook' : 's3', success: false, error: item.reason?.message || 'Backup delivery failed' });
}
export async function rotateLocalBackups(directory, keepCount) {
  const files = [];
  for (const name of await fs.readdir(directory)) {
    if (!name.startsWith('backup-') || !name.endsWith('.tar.gz')) continue;
    const filename = path.join(directory, name);
    const stat = await fs.stat(filename);
    if (stat.isFile()) files.push({ filename, modified: stat.mtimeMs });
  }
  files.sort((a, b) => b.modified - a.modified || b.filename.localeCompare(a.filename));
  for (const file of files.slice(keepCount)) await fs.remove(file.filename);
}
