import { PrismaClient } from "@prisma/client";

// A single shared Prisma instance - avoids opening a new DB connection per request.
export const prisma = new PrismaClient();
