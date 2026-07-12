import alchemy from "alchemy";
import { TanStackStart } from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/web/.env" });
config({ path: "../../apps/server/.env" });

const app = await alchemy("wincode");

// biome-ignore-start lint/style/noNonNullAssertion: env vars are validated at runtime
export const web = await TanStackStart("web", {
	cwd: "../../apps/web",
	bindings: {
		VITE_SERVER_URL: alchemy.env.VITE_SERVER_URL!,
		DATABASE_URL: alchemy.secret.env.DATABASE_URL!,
		CORS_ORIGIN: alchemy.env.CORS_ORIGIN!,
		BETTER_AUTH_SECRET: alchemy.secret.env.BETTER_AUTH_SECRET!,
		BETTER_AUTH_URL: alchemy.env.BETTER_AUTH_URL!,
		GITHUB_CLIENT_ID: alchemy.secret.env.GITHUB_CLIENT_ID!,
		GITHUB_CLIENT_SECRET: alchemy.secret.env.GITHUB_CLIENT_SECRET!,
		GOOGLE_GENERATIVE_AI_API_KEY:
			alchemy.secret.env.GOOGLE_GENERATIVE_AI_API_KEY!,
		WINCODE_API_KEY_PEPPER: alchemy.secret.env.WINCODE_API_KEY_PEPPER!,
		GOOGLE_CLIENT_ID: alchemy.secret.env.GOOGLE_CLIENT_ID!,
		GOOGLE_CLIENT_SECRET: alchemy.secret.env.GOOGLE_CLIENT_SECRET!,
	},
});
// biome-ignore-end lint/style/noNonNullAssertion: env vars are validated at runtime

console.log(`Web    -> ${web.url}`);

await app.finalize();
