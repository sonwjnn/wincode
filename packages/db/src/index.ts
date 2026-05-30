import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@wincode/env/server";

import { PrismaClient } from "../prisma/generated/client";

export type { Prisma } from "../prisma/generated/client";

export function createPrismaClient() {
	const adapter = new PrismaPg({
		connectionString: env.DATABASE_URL,
	});

	return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();
export default prisma;

export type { Mode as ModeEnum } from "../prisma/generated/enums";
// biome-ignore lint/performance/noBarrelFile: stable re-export required by project convention
export { Mode } from "../prisma/generated/enums";
