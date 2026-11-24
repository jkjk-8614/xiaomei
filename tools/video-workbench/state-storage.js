import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';

export function createSerialQueue() {
  let tail = Promise.resolve();
  return (work) => {
    const current = tail.catch(() => {}).then(work);
    tail = current;
    return current;
  };
}

export function createAtomicJsonWriter(filePath) {
  const enqueue = createSerialQueue();
  return (value) => {
    const snapshot = JSON.stringify(value, null, 2);
    return enqueue(async () => {
      const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, snapshot, 'utf8');
        await fs.rename(temporary, filePath);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
  };
}
