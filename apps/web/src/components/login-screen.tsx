import { useNavigate } from "@tanstack/react-router";
import { Button } from "@wincode/ui/components/button";
import { Code2, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

type SocialProvider = "github" | "google";

export default function LoginScreen() {
	const navigate = useNavigate();
	const { data: session, isPending } = authClient.useSession();
	const [pendingProvider, setPendingProvider] = useState<SocialProvider | null>(
		null
	);
	const isOAuthFlow =
		typeof window !== "undefined" &&
		new URLSearchParams(window.location.search).has("sig");

	const renderProviderIcon = (provider: SocialProvider): ReactNode => {
		if (pendingProvider === provider) {
			return <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />;
		}

		if (provider === "github") {
			return (
				<span
					aria-hidden="true"
					className="flex h-4 w-4 items-center justify-center rounded-full border border-white/30 font-semibold text-[9px] text-white/85 leading-none tracking-[-0.1em]"
				>
					GH
				</span>
			);
		}

		return (
			<span
				aria-hidden="true"
				className="flex h-4 w-4 items-center justify-center rounded-full border border-white/30 font-semibold text-[10px] text-white/85 leading-none"
			>
				G
			</span>
		);
	};

	useEffect(() => {
		if (session && !isOAuthFlow) {
			navigate({ to: "/", replace: true });
		}
	}, [isOAuthFlow, navigate, session]);

	const handleSocialSignIn = async (
		provider: SocialProvider
	): Promise<void> => {
		setPendingProvider(provider);
		try {
			await authClient.signIn.social(
				{
					callbackURL: window.location.href,
					provider,
				},
				{
					onError: (error) => {
						toast.error(error.error.message || error.error.statusText);
					},
				}
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Sign in failed");
		} finally {
			setPendingProvider(null);
		}
	};

	if (isPending || (session && !isOAuthFlow)) {
		return (
			<main className="fixed inset-0 z-50 grid place-items-center overflow-hidden bg-black text-white">
				<div className="relative flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70">
					<Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
					<span>{session ? "Redirecting" : "Checking session"}</span>
				</div>
			</main>
		);
	}

	return (
		<main className="fixed inset-0 z-50 overflow-hidden bg-black text-white">
			<section
				aria-labelledby="login-title"
				className="relative mx-auto flex min-h-svh w-full max-w-md items-center justify-center px-6"
			>
				<div className="flex w-full max-w-[19rem] flex-col items-center gap-6 text-center">
					<div
						aria-hidden="true"
						className="flex h-9 w-9 items-center justify-center border border-white/15 bg-[#0b0b0b] text-white/85"
					>
						<Code2 className="h-4 w-4" />
					</div>

					<h1 className="sr-only" id="login-title">
						Sign in
					</h1>

					<div className="flex w-full flex-col gap-3">
						<Button
							aria-label="Continue with GitHub"
							className="h-11 w-full border border-white/15 bg-transparent font-medium text-[14px] text-white shadow-none hover:border-white/25 hover:bg-white/5 hover:text-white"
							disabled={pendingProvider !== null}
							onClick={async () => {
								await handleSocialSignIn("github");
							}}
							type="button"
							variant="outline"
						>
							<span className="inline-flex items-center justify-center gap-2">
								{renderProviderIcon("github")}
								<span>Continue with GitHub</span>
							</span>
						</Button>

						<Button
							aria-label="Continue with Google"
							className="h-11 w-full border border-white/15 bg-transparent font-medium text-[14px] text-white shadow-none hover:border-white/25 hover:bg-white/5 hover:text-white"
							disabled={pendingProvider !== null}
							onClick={async () => {
								await handleSocialSignIn("google");
							}}
							type="button"
							variant="outline"
						>
							<span className="inline-flex items-center justify-center gap-2">
								{renderProviderIcon("google")}
								<span>Continue with Google</span>
							</span>
						</Button>
					</div>
				</div>
			</section>
		</main>
	);
}
