import * as path from "node:path";
import { analysisDir, ensureArtifacts, readJson, writeJson } from "./lib";

type Row = {
	executedNames: string[];
	exitCode: number;
	file: string;
	line: number;
	lines: number[];
	matched: number;
	name: string;
	suite: string;
	wallMs: number;
};

type ClusterAnalysis = {
	clusters: {
		members: { file: string; line: number; name: string }[];
		size: number;
	}[];
};

await ensureArtifacts();
const directory = analysisDir();
const rows: Row[] = (
	await Bun.file(path.join(directory, "per-test-fingerprints.jsonl")).text()
)
	.split("\n")
	.filter((entry) => entry.length > 0)
	.map((entry) => JSON.parse(entry) as Row);
const lineIndex = await readJson<string[]>(
	path.join(directory, "per-test-line-index.json")
);
const { clusters } = await readJson<ClusterAnalysis>(
	path.join(directory, "ast-clusters.json")
);

const key = (row: Row): string => `${row.file}:${row.line}:${row.name}`;
const owners = new Map<number, number>();
for (const row of rows) {
	for (const id of row.lines) {
		owners.set(id, (owners.get(id) ?? 0) + 1);
	}
}
const uniqueLines = new Map<string, number>();
for (const row of rows) {
	let unique = 0;
	for (const id of row.lines) {
		if (owners.get(id) === 1) {
			unique += 1;
		}
	}
	uniqueLines.set(key(row), unique);
}

const byDigest = new Map<string, number[]>();
rows.forEach((row, position) => {
	const sorted = [...row.lines].sort((left, right) => left - right);
	const digest = Bun.CryptoHasher.hash(
		"sha256",
		new Uint8Array(new Uint32Array(sorted).buffer),
		"hex"
	) as unknown as string;
	byDigest.set(digest, [...(byDigest.get(digest) ?? []), position]);
});
const coverageEqualityGroups = [...byDigest.values()]
	.filter((bucket) => bucket.length > 1)
	.map((bucket) =>
		bucket.map((position) => {
			const row = rows[position];
			return row === undefined
				? undefined
				: {
						file: row.file,
						id: key(row),
						line: row.line,
						lines: row.lines.length,
						name: row.name,
					};
		})
	)
	.filter((group) =>
		group.every((entry) => entry !== undefined && entry.lines > 0)
	);

const rowByKey = new Map(rows.map((row) => [key(row), row]));
const overlap = (
	left: readonly number[],
	right: readonly number[]
): { identical: boolean; jaccard: number } => {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size === 0 || rightSet.size === 0) {
		return { identical: false, jaccard: 0 };
	}
	let shared = 0;
	for (const id of leftSet) {
		if (rightSet.has(id)) {
			shared += 1;
		}
	}
	return {
		identical: leftSet.size === rightSet.size && shared === leftSet.size,
		jaccard: shared / (leftSet.size + rightSet.size - shared),
	};
};

const clusterCoverage = clusters.map((cluster) => {
	const members = cluster.members.map((member) => {
		const row = rowByKey.get(`${member.file}:${member.line}:${member.name}`);
		return {
			...member,
			ambiguous: (row?.matched ?? 1) !== 1,
			appLines: row?.lines.length ?? 0,
			uniqueLines:
				uniqueLines.get(`${member.file}:${member.line}:${member.name}`) ?? 0,
			rows: row,
		};
	});
	const pairOverlaps: {
		identical: boolean;
		jaccard: number;
		left: string;
		right: string;
	}[] = [];
	for (let index = 0; index < members.length; index += 1) {
		for (let other = index + 1; other < members.length; other += 1) {
			const left = members[index];
			const right = members[other];
			if (left?.rows === undefined || right?.rows === undefined) {
				continue;
			}
			pairOverlaps.push({
				left: `${left.file}:${left.line}`,
				right: `${right.file}:${right.line}`,
				...overlap(left.rows.lines, right.rows.lines),
			});
		}
	}
	return {
		identicalPairs: pairOverlaps.filter((pair) => pair.identical).length,
		members: members.map(({ rows: _rows, ...rest }) => rest),
		pairOverlaps,
		size: members.length,
	};
});

const protectedFiles = new Map<string, number>();
for (const [id, count] of owners) {
	if (count !== 1) {
		continue;
	}
	const lineKey = lineIndex[id];
	if (lineKey !== undefined) {
		const file = lineKey.slice(0, lineKey.lastIndexOf(":"));
		protectedFiles.set(file, (protectedFiles.get(file) ?? 0) + 1);
	}
}

const sortedRows = rows
	.map((row) => ({
		ambiguous: row.matched !== 1,
		appLines: row.lines.length,
		file: row.file,
		id: key(row),
		line: row.line,
		name: row.name,
		uniqueLines: uniqueLines.get(key(row)) ?? 0,
	}))
	.sort((left, right) => right.uniqueLines - left.uniqueLines);

await writeJson(path.join(directory, "coverage-analysis.json"), {
	clusterCoverage,
	coverageEqualityGroups,
	distinctAppLines: lineIndex.length,
	linesCoveredByOneTest: [...owners.values()].filter((count) => count === 1)
		.length,
	linesCoveredByTwoOrMore: [...owners.values()].filter((count) => count > 1)
		.length,
	protectedSourceFiles: [...protectedFiles.entries()]
		.sort((left, right) => right[1] - left[1])
		.slice(0, 25),
	ambiguousTests: rows.filter((row) => row.matched !== 1).length,
	tests: rows.length,
	testsWithZeroAppLines: rows
		.filter((row) => row.lines.length === 0)
		.map((row) => ({ file: row.file, id: key(row), name: row.name })),
	topUniqueOwners: sortedRows.slice(0, 20),
	weakestOwners: sortedRows.slice(-20).reverse(),
});

console.log(
	JSON.stringify(
		{
			clusterPairsCompared: clusterCoverage.reduce(
				(sum, cluster) => sum + cluster.pairOverlaps.length,
				0
			),
			clustersWithIdenticalCoverage: clusterCoverage.filter(
				(cluster) => cluster.identicalPairs > 0
			).length,
			distinctAppLines: lineIndex.length,
			exactCoverageEqualityGroups: coverageEqualityGroups.length,
			ambiguousTests: rows.filter((row) => row.matched !== 1).length,
			exactEqualityGroupSizes: coverageEqualityGroups.map(
				(group) => group.length
			),
			linesCoveredByOneTest: [...owners.values()].filter((count) => count === 1)
				.length,
			tests: rows.length,
			zeroCoverageTests: rows.filter((row) => row.lines.length === 0).length,
		},
		null,
		2
	)
);
