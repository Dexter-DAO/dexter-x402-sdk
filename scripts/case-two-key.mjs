import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

export function readKey(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
      throw new Error('Agent key must be an owned regular file with mode 600');
    }
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(fd, 'utf8'))));
  } finally { closeSync(fd); }
}
