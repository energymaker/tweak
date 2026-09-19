// A log file that never grows past max bytes: when it would, the oldest whole
// lines are dropped so the newest ones fit.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function appendCapped(file, text, max = 1024 * 1024) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text);
  const { size } = await fs.stat(file);
  if (size <= max) return;
  const buf = await fs.readFile(file);
  const cut = buf.indexOf(10, buf.length - max); // first newline inside the last max bytes
  await fs.writeFile(file, cut < 0 ? '' : buf.subarray(cut + 1));
}
