import { PrismaClient } from "@prisma/client";

const createClient = () => new PrismaClient({ omit: { operator: { passwordHash: true } } });
const globalForPrisma = global as unknown as { prisma?: ReturnType<typeof createClient> };

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
