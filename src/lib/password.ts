import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Same scrypt profile as the office app: 32 MiB per operation.
const COST = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
// Unknown accounts still run the same expensive operation; the dummy hash never authenticates.
const DUMMY = `scrypt-v1$${"00".repeat(16)}$${"00".repeat(64)}`;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt, "hex"), 64, COST, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string | null) {
  const validFormat = Boolean(encoded && /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded));
  const [, salt, hash] = (validFormat ? encoded! : DUMMY).split("$");
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(hash, "hex")) && validFormat;
}

export const PASSWORD_MIN_LENGTH = 12;
