import * as path from "node:path";
import {
	analysisDir,
	artifactsRoot,
	ensureArtifacts,
	isApplicationFile,
	parseLcov,
	writeJson,
} from "./lib";

type Fingerprint = {
	appBranches: number;
	appLines: number;
	branches: Set<string>;
	lines: Set<string>;
	packageName: string;
	testFile: string;
	uniqueBranches: number;
	uniqueLines: number;
};

await ensureArtifacts();
const artifacts = artifactsRoot();
const runs = (await (
	await Bun.file(path.join(artifacts, "analysis", "coverage-runs.json"))
).json()) as { path: string }[];

const fingerprints: Fingerprint[] = [];
const noCoverage: string[] = [];
for (const run of runs) {
	const directory = path.join(
		artifacts,
		"cov",
		run.path.replace(/[\\/]/g, "__")
	);
	let text: string;
	try {
		text = await Bun.file(path.join(directory, "lcov.info")).text();
	} catch {
		noCoverage.push(run.path);
		continue;
	}
	const lines = new Set<string>();
	const branches = new Set<string>();
	for (const record of parseLcov(text)) {
		const normalized = record.source.split(path.sep).join("/");
		if (!isApplicationFile(normalized)) {
			continue;
		}
		for (const line of record.lines) {
			lines.add(`${normalized}:${line}`);
		}
		for (const branch of record.branches) {
			branches.add(`${normalized}:${branch}`);
		}
	}
	fingerprints.push({
		appBranches: branches.size,
		appLines: lines.size,
		branches,
		lines,
		packageName: run.path.split("/")[1] ?? "",
		testFile: run.path,
		uniqueBranches: 0,
		uniqueLines: 0,
	});
}

const owners = (sets: readonly Set<string>[]): Map<string, number> => {
	const counts = new Map<string, number>();
	for (const set of sets) {
		for (const value of set) {
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
	}
	return counts;
};
const lineOwners = owners(fingerprints.map((entry) => entry.lines));
const branchOwners = owners(fingerprints.map((entry) => entry.branches));
for (const fingerprint of fingerprints) {
	for (const line of fingerprint.lines) {
		if (lineOwners.get(line) === 1) {
			fingerprint.uniqueLines += 1;
		}
	}
	for (const branch of fingerprint.branches) {
		if (branchOwners.get(branch) === 1) {
			fingerprint.uniqueBranches += 1;
		}
	}
}

const sorted = [...fingerprints].sort(
	(left, right) => right.appLines - left.appLines
);
const subsumption: {
	equal: boolean;
	extraBranches: number;
	extraLines: number;
	subset: string;
	superset: string;
}[] = [];
for (const superset of sorted) {
	for (const subset of sorted) {
		if (subset.testFile === superset.testFile || subset.appLines === 0) {
			continue;
		}
		let contained = true;
		for (const line of subset.lines) {
			if (!superset.lines.has(line)) {
				contained = false;
				break;
			}
		}
		if (contained) {
			for (const branch of subset.branches) {
				if (!superset.branches.has(branch)) {
					contained = false;
					break;
				}
			}
		}
		if (!contained) {
			continue;
		}
		subsumption.push({
			equal:
				superset.appLines === subset.appLines &&
				superset.appBranches === subset.appBranches,
			extraBranches: superset.appBranches - subset.appBranches,
			extraLines: superset.appLines - subset.appLines,
			subset: subset.testFile,
			superset: superset.testFile,
		});
	}
}

const equalityPairs = subsumption.filter((pair) => pair.equal);
await writeJson(
	path.join(analysisDir(), "fingerprints.json"),
	fingerprints.map((fingerprint) => ({
		appBranches: fingerprint.appBranches,
		appLines: fingerprint.appLines,
		branches: [...fingerprint.branches],
		lines: [...fingerprint.lines],
		packageName: fingerprint.packageName,
		testFile: fingerprint.testFile,
		uniqueBranches: fingerprint.uniqueBranches,
		uniqueLines: fingerprint.uniqueLines,
	}))
);
await writeJson(path.join(analysisDir(), "subsumption.json"), {
	equalityPairs,
	subsumption,
});
console.log(
	JSON.stringify(
		{
			coverageEqualityPairs: equalityPairs.length,
			distinctApplicationLines: lineOwners.size,
			fingerprinted: fingerprints.length,
			noLcov: noCoverage.length,
			subsumptionPairs: subsumption.length - equalityPairs.length,
			testsWithUniqueLines: fingerprints.filter(
				(entry) => entry.uniqueLines > 0
			).length,
			zeroApplicationCoverage: fingerprints
				.filter((entry) => entry.appLines === 0)
				.map((entry) => entry.testFile),
		},
		null,
		2
	)
);
