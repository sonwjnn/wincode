import { z } from "zod";

export const billingSuccessSearchSchema = z.object({
	checkout_id: z.string().min(1).optional(),
});
