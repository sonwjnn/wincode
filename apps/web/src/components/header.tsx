import { Link } from "@tanstack/react-router";

import UserMenu from "./user-menu";

export default function Header() {
	return (
		<header className="border-white/10 border-b bg-neutral-950/90 backdrop-blur">
			<div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
				<div className="flex items-center gap-6">
					<Link
						aria-label="Wincode home"
						className="font-medium text-sm text-white/90 uppercase tracking-[0.22em] transition-colors hover:text-white"
						to="/"
					>
						Wincode
					</Link>
				</div>
				<UserMenu />
			</div>
		</header>
	);
}
