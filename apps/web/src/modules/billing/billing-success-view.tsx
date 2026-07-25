import { Link } from "@tanstack/react-router";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { BillingAccessGate } from "./billing-access-gate";
import { getBillingEligibility } from "./billing-api";

const CONFIRMATION_POLL_MS = 2500;
type ConfirmationState = "processing" | "active" | "error";

function BillingSuccessContent() {
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<ConfirmationState>("processing");

	useEffect(() => {
		let mounted = true;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		if (attempt > 0) {
			setState("processing");
		}
		const confirmEntitlement = async () => {
			try {
				const eligible = await getBillingEligibility();
				if (!mounted) {
					return;
				}
				if (eligible) {
					setState("active");
					return;
				}
				setState("processing");
				timeout = setTimeout(confirmEntitlement, CONFIRMATION_POLL_MS);
			} catch {
				if (mounted) {
					setState("error");
				}
			}
		};

		confirmEntitlement().catch(() => undefined);
		return () => {
			mounted = false;
			if (timeout) {
				clearTimeout(timeout);
			}
		};
	}, [attempt]);

	const isActive = state === "active";
	return (
		<main className="grid min-h-[calc(100svh-3.5rem)] place-items-center px-5 py-16">
			<section
				aria-labelledby="confirmation-title"
				className="w-full max-w-lg text-center"
			>
				<div className="mx-auto mb-8 grid size-16 place-items-center rounded-full border border-emerald-300/20 bg-emerald-300/10 text-emerald-200">
					{isActive ? (
						<Check aria-hidden="true" className="size-7" />
					) : (
						<Loader2
							aria-hidden="true"
							className={`size-6 ${state === "processing" ? "animate-spin" : ""}`}
						/>
					)}
				</div>
				<p className="mb-3 font-medium text-emerald-300/70 text-xs uppercase tracking-[0.28em]">
					Go checkout
				</p>
				<h1
					className="font-semibold text-4xl tracking-[-0.045em]"
					id="confirmation-title"
				>
					{isActive ? "Go is active." : "Confirming your access."}
				</h1>
				<div
					aria-live="polite"
					className="mx-auto mt-5 max-w-md text-sm text-white/50 leading-6"
					role={state === "error" ? "alert" : "status"}
				>
					{isActive
						? "Server confirmation is complete. Hosted usage is now available in the WinCode CLI."
						: null}
					{state === "processing"
						? "Checkout returned. Secure server confirmation can take a moment—this page does not grant access by itself."
						: null}
					{state === "error"
						? "Confirmation status could not be checked. Your checkout is not lost; try checking again."
						: null}
				</div>
				<div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
					{state === "error" ? (
						<button
							className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-emerald-300 px-5 font-medium text-neutral-950 text-sm transition-colors hover:bg-emerald-200 focus-visible:outline-2 focus-visible:outline-emerald-200 focus-visible:outline-offset-2"
							onClick={() => {
								setAttempt((current) => current + 1);
							}}
							type="button"
						>
							<RotateCcw aria-hidden="true" className="size-4" />
							Check again
						</button>
					) : null}
					<Link
						className="inline-flex h-11 items-center justify-center rounded-full border border-white/15 bg-white/5 px-5 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
						to="/billing"
					>
						Back to billing
					</Link>
				</div>
			</section>
		</main>
	);
}

export function BillingSuccessView() {
	return (
		<BillingAccessGate>
			<BillingSuccessContent />
		</BillingAccessGate>
	);
}
