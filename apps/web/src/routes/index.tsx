import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

function HomeComponent() {
	return (
		<main className="mx-auto flex min-h-[calc(100svh-3.5rem)] w-full max-w-6xl items-center px-4 py-16 sm:px-6 lg:px-8">
			<section className="max-w-xl space-y-6">
				<div className="space-y-3">
					<p className="font-medium text-white/35 text-xs uppercase tracking-[0.3em]">
						Wincode
					</p>
					<h1 className="font-semibold text-4xl text-white tracking-[-0.04em] sm:text-5xl">
						Quiet workspace.
					</h1>
					<p className="max-w-md text-sm text-white/55 leading-6">
						Minimal shell, focused routes, no noise.
					</p>
				</div>
			</section>
		</main>
	);
}
