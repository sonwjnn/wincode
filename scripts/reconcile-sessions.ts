import { Pool } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
const sessionIds = [
	"ses_0711fcbcaffex6QwhruS7bvRIs",
	"ses_0671499dcffe6SLXMz3jlS3b1k",
	"ses_0671470f1ffeB3AGHQL4onbOPl",
	"ses_0671470afffe3Wq64hXL3venpk",
	"ses_067134cb0ffeE8Hb0zpilbA1j3",
	"ses_067134b64ffe23Dm51ym9XZgrA",
	"ses_0671348afffeix4YnK6w3yPc1D",
	"ses_0671347f9ffeuMygqdzELp7zr7",
	"ses_067105da6ffeL6xXbCz9LQNYfk",
	"ses_067100db6ffe1dTSsls5tFqOFx",
	"ses_0670f0b3dffeEMkxiGKPU0Zb7f",
	"ses_0670eb701ffepZYxg1eATzSx4j",
	"ses_0670cb5a4ffe5D9HgOBTSUsEs6",
];

async function main() {
	const pool = new Pool({ connectionString: DATABASE_URL });
	const client = await pool.connect();

	const idsList = sessionIds.map((id) => `'${id}'`).join(",");

	// Search across all text-type columns in all tables for any match
	const tables = await client.query(`
		SELECT table_name, column_name 
		FROM information_schema.columns 
		WHERE table_schema = 'public' 
		  AND (data_type = 'text' OR data_type = 'character varying')
		ORDER BY table_name, column_name
	`);

	for (const { table_name, column_name } of tables.rows) {
		try {
			const q = `SELECT "${column_name}" FROM "${table_name}" WHERE "${column_name}" IN (${idsList}) LIMIT 1`;
			const result = await client.query(q);
			if (result.rows.length > 0) {
				console.log(
					`FOUND in ${table_name}.${column_name}: ${result.rows[0][column_name]}`
				);
			}
		} catch {
			// Skip incompatible columns
		}
	}

	await client.release();
	await pool.end();
}

main().catch((err) => {
	console.error("Failed:", err);
	process.exit(1);
});
