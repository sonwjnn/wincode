import { createFileRoute, useSearch } from "@tanstack/react-router";
import { Button } from "@wincode/ui/components/button";
import { useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/oauth/consent")({
	component: RouteComponent,
	validateSearch: (search: Record<string, unknown>) => ({
		client_id:
			typeof search.client_id === "string" ? search.client_id : undefined,
		scope: typeof search.scope === "string" ? search.scope : undefined,
	}),
});

function RouteComponent() {
	const [isSubmitting, setIsSubmitting] = useState(false);
	const { client_id: clientId, scope } = useSearch({ from: "/oauth/consent" });

	const submitConsent = async (accept: boolean) => {
		setIsSubmitting(true);
		const { data, error } = await authClient.oauth2.consent({ accept });
		if (error) {
			toast.error(error.message || error.statusText);
			setIsSubmitting(false);
			return;
		}
		window.location.assign(data.url);
	};

	return (
		<main className="mx-auto mt-10 w-full max-w-md space-y-6 p-6">
			<div className="space-y-2 text-center">
				<h1 className="font-bold text-3xl">Authorize Wincode CLI</h1>
				<p className="text-muted-foreground">
					{clientId ?? "this application"} requests access to your account.
				</p>
			</div>
			{scope ? (
				<p className="rounded-md border p-3 text-sm">Scopes: {scope}</p>
			) : null}
			<div className="flex gap-3">
				<Button
					disabled={isSubmitting}
					onClick={() => submitConsent(false)}
					variant="outline"
				>
					Deny
				</Button>
				<Button disabled={isSubmitting} onClick={() => submitConsent(true)}>
					Allow
				</Button>
			</div>
		</main>
	);
}
