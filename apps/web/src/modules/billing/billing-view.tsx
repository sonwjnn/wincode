import { ArrowUpRight, Check, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { BillingAccessGate } from "./billing-access-gate";
import { createBillingRedirect, getBillingEligibility } from "./billing-api";

type PendingAction = "checkout" | "portal" | null;
type PlanStatus = "loading" | "active" | "inactive" | "unavailable";

const planFeatures = [
	"Hosted OpenAI and Google models",
	"One rolling usage allowance",
	"Usage visible inside the WinCode CLI",
] as const;

function BillingContent() {
	const [pendingAction, setPendingAction] = useState<PendingAction>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [planStatus, setPlanStatus] = useState<PlanStatus>("loading");

	useEffect(() => {
		let mounted = true;
		getBillingEligibility()
			.then((eligible) => {
				if (mounted) {
					setPlanStatus(eligible ? "active" : "inactive");
				}
			})
			.catch(() => {
				if (mounted) {
					setPlanStatus("unavailable");
				}
			});
		return () => {
			mounted = false;
		};
	}, []);

	const openBilling = async (action: Exclude<PendingAction, null>) => {
		setPendingAction(action);
		setErrorMessage(null);
		try {
			window.location.assign(await createBillingRedirect(action));
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "Billing could not be opened."
			);
			setPendingAction(null);
		}
	};

	const isBusy = pendingAction !== null;
	const isPlanLoading = planStatus === "loading";
	let checkoutLabel = "Continue to checkout";
	if (planStatus === "active") {
		checkoutLabel = "Go is active";
	} else if (isPlanLoading) {
		checkoutLabel = "Checking plan…";
	}

	return (
		<main className="mx-auto w-full max-w-5xl px-5 py-16 sm:px-8 sm:py-24">
			<header className="max-w-2xl space-y-5">
				<p className="font-medium text-emerald-300/70 text-xs uppercase tracking-[0.28em]">
					Billing
				</p>
				<h1 className="font-semibold text-4xl text-white tracking-[-0.045em] sm:text-6xl">
					One plan. More building.
				</h1>
				<p className="max-w-xl text-base text-white/55 leading-7">
					Go funds hosted model usage across every WinCode session. Bring your
					own keys whenever you prefer—BYOK stays separate.
				</p>
			</header>

			<section
				aria-labelledby="go-plan-title"
				className="mt-14 overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.035] shadow-2xl shadow-black/20"
			>
				<div className="grid lg:grid-cols-[1.35fr_0.65fr]">
					<div className="space-y-8 p-7 sm:p-10">
						<div className="flex flex-wrap items-center gap-3">
							<h2
								className="font-semibold text-3xl tracking-[-0.035em]"
								id="go-plan-title"
							>
								Go
							</h2>
							{planStatus === "active" ? (
								<span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 font-medium text-emerald-200 text-xs">
									Current plan
								</span>
							) : null}
						</div>
						<p className="max-w-lg text-sm text-white/50 leading-6">
							Current price and allowance appear in secure checkout before you
							confirm. No surprise upgrades or usage top-ups.
						</p>
						<ul className="grid gap-4 sm:grid-cols-2">
							{planFeatures.map((feature) => (
								<li className="flex gap-3 text-sm text-white/75" key={feature}>
									<Check
										aria-hidden="true"
										className="mt-0.5 size-4 shrink-0 text-emerald-300"
									/>
									{feature}
								</li>
							))}
						</ul>
					</div>

					<div className="flex flex-col justify-between border-white/10 border-t bg-black/20 p-7 sm:p-10 lg:border-t-0 lg:border-l">
						<div className="mb-10 flex items-start gap-3 text-white/45">
							<ShieldCheck
								aria-hidden="true"
								className="mt-0.5 size-5 text-emerald-300/70"
							/>
							<p className="text-xs leading-5">
								Access activates only after secure server confirmation.
							</p>
						</div>
						<div className="space-y-3">
							<button
								aria-busy={pendingAction === "checkout"}
								className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-5 font-medium text-neutral-950 text-sm transition-colors hover:bg-emerald-200 focus-visible:outline-2 focus-visible:outline-emerald-200 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-60"
								disabled={isBusy || planStatus === "active" || isPlanLoading}
								onClick={() => openBilling("checkout")}
								type="button"
							>
								{pendingAction === "checkout" || isPlanLoading ? (
									<Loader2 aria-hidden="true" className="size-4 animate-spin" />
								) : null}
								{checkoutLabel}
								{pendingAction !== "checkout" && planStatus !== "active" ? (
									<ArrowUpRight aria-hidden="true" className="size-4" />
								) : null}
							</button>
							<button
								aria-busy={pendingAction === "portal"}
								className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-60"
								disabled={isBusy}
								onClick={() => openBilling("portal")}
								type="button"
							>
								{pendingAction === "portal" ? (
									<Loader2 aria-hidden="true" className="size-4 animate-spin" />
								) : null}
								Manage billing
							</button>
						</div>
					</div>
				</div>
			</section>

			<div
				aria-live="polite"
				className="mt-5 min-h-6"
				role={errorMessage ? "alert" : "status"}
			>
				{errorMessage ? (
					<p className="text-red-300 text-sm">{errorMessage}</p>
				) : null}
				{planStatus === "unavailable" && !errorMessage ? (
					<p className="text-sm text-white/40">
						Plan status is temporarily unavailable. Billing actions still work.
					</p>
				) : null}
			</div>
		</main>
	);
}

export function BillingView() {
	return (
		<BillingAccessGate>
			<BillingContent />
		</BillingAccessGate>
	);
}
