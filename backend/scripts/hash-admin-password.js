#!/usr/bin/env node
import { hashPassword } from '../src/admin/passwords.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const fromArgs = process.argv.slice(2).join(' ');
const password = fromArgs || (process.stdin.isTTY ? '' : await readStdin());

if (!password) {
  console.error(
    'Usage: node backend/scripts/hash-admin-password.js <password>\n' +
      '   or: printf %s "<password>" | node backend/scripts/hash-admin-password.js',
  );
  process.exit(1);
}

console.log(await hashPassword(password));
