import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@wincode/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@wincode/ui/components/dropdown-menu";
import { Loader2 } from "lucide-react";

import { authClient } from "@/lib/auth-client";

const NAME_PARTS_SPLIT = /\s+/;

const getInitials = (
	name: string | null | undefined,
	email: string | null | undefined
): string => {
	const normalizedName = name?.trim();

	if (normalizedName) {
		return normalizedName
			.split(NAME_PARTS_SPLIT)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("");
	}

	return email?.trim().charAt(0).toUpperCase() ?? "W";
};

export default function UserMenu() {
	const navigate = useNavigate();
	const { data: session, isPending } = authClient.useSession();

	if (isPending) {
		return (
			<div
				aria-live="polite"
				className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/35"
				role="status"
			>
				<span className="sr-only">Loading user menu</span>
				<Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
			</div>
		);
	}

	if (!session) {
		return (
			<Link
				className="inline-flex h-9 items-center rounded-full border border-white/10 bg-white/5 px-4 text-sm text-white/85 shadow-none transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
				to="/login"
			>
				Sign in
			</Link>
		);
	}

	const userName = session.user.name ?? session.user.email ?? "Wincode user";
	const userEmail = session.user.email ?? "";
	const initials = getInitials(session.user.name, session.user.email);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={`Open account menu for ${userName}`}
						className="h-9 w-9 rounded-full border-white/10 bg-white/5 p-0 text-white shadow-none hover:border-white/20 hover:bg-white/10"
						variant="outline"
					/>
				}
			>
				{session.user.image ? (
					<img
						alt={`${userName} avatar`}
						className="h-full w-full rounded-full object-cover"
						height={36}
						src={session.user.image}
						width={36}
					/>
				) : (
					<span
						aria-hidden="true"
						className="font-medium text-[11px] tracking-[0.12em]"
					>
						{initials}
					</span>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-72 border border-white/10 bg-neutral-950/95 p-2 text-white shadow-2xl shadow-black/40 backdrop-blur">
				<div className="space-y-0.5 px-2 py-1.5">
					<p className="font-medium text-sm text-white">{userName}</p>
					<p className="truncate text-white/50 text-xs">{userEmail}</p>
				</div>
				<DropdownMenuSeparator className="mx-0 my-2 bg-white/10" />
				<Button
					className="h-9 w-full justify-start rounded-none border border-white/10 bg-white/5 px-3 text-sm text-white shadow-none hover:border-white/20 hover:bg-white/10"
					onClick={async () => {
						await authClient.signOut();
						navigate({
							to: "/",
						});
					}}
					type="button"
					variant="outline"
				>
					Logout
				</Button>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
