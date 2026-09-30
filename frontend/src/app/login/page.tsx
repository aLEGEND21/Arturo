import Image from "next/image";
import { Blueprint } from "@/components/industry";
import { buttonClass, kickerClass } from "@/lib/ui";
import mark from "../icon.png";

// Same default as lib/api.ts, repeated here because that module pulls in
// SWR, which cannot be imported from a Server Component.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Reasons the backend can bounce back with (?error=...), see auth.py.
const ERRORS: Record<string, string> = {
  not_allowed: "That Discord account isn't on the allowlist for this dashboard.",
  cancelled: "Discord sign-in was cancelled.",
  state: "Sign-in expired or was tampered with. Try again.",
  discord: "Discord didn't complete the sign-in. Try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? ERRORS[error] ?? "Sign-in failed." : null;

  return (
    // Full-viewport stage with a faint drafting grid, so the one blueprint
    // frame on it reads as intentional rather than as a lonely card. Fixed
    // to the viewport rather than sized in flow: the layout's <main> caps
    // content at 1280px, which would cut the grid off on wide screens (and
    // 100vw would include the scrollbar, scrolling sideways on Windows).
    <div className="fixed inset-0 grid place-items-center overflow-y-auto bg-[image:linear-gradient(var(--color-grid)_1px,transparent_1px),linear-gradient(90deg,var(--color-grid)_1px,transparent_1px)] bg-[length:28px_28px] bg-center px-page py-[27.2px]">
      <div className="w-full max-w-[380px]">
        <Blueprint>
          <div className="flex items-center gap-3.5 border-b border-divider px-6 pt-[22px] pb-[18px]">
            <Image src={mark} alt="" width={44} height={44} priority className="size-11 flex-none" />
            <div>
              <div className="mb-1 font-heading text-[22px] leading-none font-semibold tracking-[0.08em]">
                ARTURO
              </div>
              <div className={kickerClass}>Accountability assistant</div>
            </div>
          </div>

          <div className="grid gap-4 px-6 py-[22px]">
            {message ? (
              <div
                role="alert"
                className="flex items-start gap-[9px] border-l-[3px] border-danger bg-danger-bg px-3 py-2.5 text-[13px] leading-[1.4] text-danger"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                  className="mt-0.5 flex-none"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{message}</span>
              </div>
            ) : null}

            <p className="m-0 text-[14px] text-label">Sign in with Discord to open your dashboard.</p>

            {/* A plain link: the backend issues the redirect to Discord and,
                on the way back, sets the session cookie. Works in dev
                (straight to the API origin) and behind the compose proxy. */}
            <a
              href={`${API_BASE}/api/auth/login`}
              className={buttonClass({ variant: "primary", className: "w-full gap-[9px] py-[11px] text-[15px]" })}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.2.4c1.8.4 2.6 1 2.6 1a15 15 0 0 0-11.6 0s.8-.6 2.6-1L8.6 3a19.8 19.8 0 0 0-4.9 1.4C.7 9 0 13.3.3 17.6a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1s.2-.1.3-.2a14.3 14.3 0 0 0 12.2 0l.3.2-2 1 1.3 2a19.9 19.9 0 0 0 6-3c.4-5-.7-9.3-3.4-13.2ZM8.5 15c-1.2 0-2.1-1.1-2.1-2.4S7.3 10.2 8.5 10.2s2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4Zm7 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4Z" />
              </svg>
              Continue with Discord
            </a>
          </div>

          <div className="border-t border-divider px-6 py-[11px] text-center text-[12px] leading-[1.4] text-faint">
            Access is limited to approved Discord accounts.
          </div>
        </Blueprint>
      </div>
    </div>
  );
}
