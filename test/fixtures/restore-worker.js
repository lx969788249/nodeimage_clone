// Isolated fault-injection worker. This file is never copied into the image.
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { BackupManager } from '../../backup.js';
import { OperationGate } from '../../safety.js';
const [root, archive, phase] = process.argv.slice(2);
let connection;
const manager = new BackupManager({ storageRoot: root, dataFile: path.join(root, 'data/db.sqlite'), uploadDir: path.join(root, 'uploads'),
  gate: new OperationGate(),
  getSqlite: async () => connection ||= await open({ filename: path.join(root, 'data/db.sqlite'), driver: sqlite3.Database }),
  resetSqlite: async () => { if (connection) await connection.close(); connection = null; },
  onPhase: at => { if (at === phase) process.kill(process.pid, 'SIGKILL'); }
});
await manager.restore(archive);
await manager.resetSqlite();
process.exit(2); // Reaching here means the fault was not injected.
