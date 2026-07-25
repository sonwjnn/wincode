import { createFileRoute } from "@tanstack/react-router";
import { BillingView } from "@/modules/billing";

export const Route = createFileRoute("/billing")({ component: BillingView });
