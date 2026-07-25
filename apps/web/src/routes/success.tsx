import { createFileRoute } from "@tanstack/react-router";
import {
	BillingSuccessView,
	billingSuccessSearchSchema,
} from "@/modules/billing";

export const Route = createFileRoute("/success")({
	component: SuccessPage,
	validateSearch: billingSuccessSearchSchema,
});

function SuccessPage() {
	return <BillingSuccessView />;
}
