/**
 * Password hashing.
 *
 * bcrypt (via the pure-JS `bcryptjs`) rather than a native argon2 binding: this
 * repo has to `npm install` cleanly on Windows, macOS and Linux with no build
 * toolchain, and a native module is the most common reason a reviewer's setup
 * fails. The work factor is configurable through `BCRYPT_ROUNDS` so it can be
 * raised over time, and lowered in tests where 12 rounds per fixture user would
 * dominate the runtime.
 */
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, env.BCRYPT_ROUNDS);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash);

/**
 * A bcrypt comparison against a throwaway hash, used when the submitted email
 * does not exist. Without it, "unknown email" returns in ~1ms while "known
 * email, wrong password" takes ~200ms, which leaks account existence through
 * response timing.
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.Jw5h7sBRi7QxFDMDYGhhPYHRnLFjnFy';

export const burnPasswordComparison = async (plain: string): Promise<void> => {
  await bcrypt.compare(plain, DUMMY_HASH).catch(() => false);
};
