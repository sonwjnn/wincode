import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";

export function BillingAccessGate({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
	const { data: session, error, isPending } = authClient.useSession();

	useEffect(() => {
		if (isPending || error || session) {
			return;
		}
		navigate({ to: "/login" }).catch(() => undefined);
	}, [error, isPending, navigate, session]);

	if (isPending) {
		return (
			<main className="grid min-h-[calc(100svh-3.5rem)] place-items-center px-6">
				<div
					aria-live="polite"
					className="flex items-center gap-3 text-sm text-white/50"
					role="status"
				>
					<Loader2 aria-hidden="true" className="size-4 animate-spin" />
					Checking account…
				</div>
			</main>
		);
	}

	if (error) {
		return (
			<main className="grid min-h-[calc(100svh-3.5rem)] place-items-center px-6">
				<div className="max-w-sm space-y-4 text-center" role="alert">
					<p className="font-medium text-white">Account check failed</p>
					<p className="text-sm text-white/50 leading-6">
						Could not verify your session. Check your connection and try again.
					</p>
					<button
						className="h-10 rounded-full border border-white/15 bg-white/5 px-5 text-sm text-white transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
						onClick={() => window.location.reload()}
						type="button"
					>
						Try again
					</button>
				</div>
			</main>
		);
	}

	if (!session) {
		return (
			<main className="grid min-h-[calc(100svh-3.5rem)] place-items-center px-6">
				<p aria-live="polite" className="text-sm text-white/50" role="status">
					Redirecting to sign in…
				</p>
			</main>
		);
	}

	return children;
}
