/**
 * Creates the platform's first owner account. Refuses to run if an owner already exists.
 *   BOOTSTRAP_OWNER_NAME="..." BOOTSTRAP_OWNER_EMAIL="..." BOOTSTRAP_OWNER_PASSWORD="..." npm run bootstrap:owner
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword, PASSWORD_MIN_LENGTH } from "../src/lib/password";

const db = new PrismaClient();

async function main() {
  const name = process.env.BOOTSTRAP_OWNER_NAME?.trim();
  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD ?? "";
  if (!name || !email) throw new Error("Set BOOTSTRAP_OWNER_NAME and BOOTSTRAP_OWNER_EMAIL.");
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`BOOTSTRAP_OWNER_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (await db.operator.findFirst({ where: { role: "owner" } })) throw new Error("An owner already exists. Add more people from the Team page.");
  const owner = await db.operator.create({ data: { name, email, role: "owner", passwordHash: await hashPassword(password) } });
  await db.auditLog.create({ data: { operatorId: owner.id, action: "operator.bootstrap_owner", targetType: "operator", targetId: owner.id } });
  console.log(`Owner created: ${email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
