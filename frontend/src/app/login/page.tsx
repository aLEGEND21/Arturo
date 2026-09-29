import Image from "next/image";
import { Blueprint } from "@/components/industry";
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
    <div className="login">
      <div className="login-card">
        <Blueprint>
          <div className="login-head">
            <Image src={mark} alt="" width={44} height={44} priority className="login-mark" />
            <div>
              <div className="login-brand">ARTURO</div>
              <div className="card-kicker">Accountability assistant</div>
            </div>
          </div>

          <div className="login-body">
            {message ? (
              <div role="alert" className="login-alert">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{message}</span>
              </div>
            ) : null}

            <p className="login-lede">
              Sign in with Discord to open your dashboard.
            </p>

            {/* A plain link: the backend issues the redirect to Discord and,
                on the way back, sets the session cookie. Works in dev
                (straight to the API origin) and behind the compose proxy. */}
            <a href={`${API_BASE}/api/auth/login`} className="btn btn-primary login-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.2.4c1.8.4 2.6 1 2.6 1a15 15 0 0 0-11.6 0s.8-.6 2.6-1L8.6 3a19.8 19.8 0 0 0-4.9 1.4C.7 9 0 13.3.3 17.6a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1s.2-.1.3-.2a14.3 14.3 0 0 0 12.2 0l.3.2-2 1 1.3 2a19.9 19.9 0 0 0 6-3c.4-5-.7-9.3-3.4-13.2ZM8.5 15c-1.2 0-2.1-1.1-2.1-2.4S7.3 10.2 8.5 10.2s2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4Zm7 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4Z" />
              </svg>
              Continue with Discord
            </a>
          </div>

          <div className="login-foot">
            Access is limited to approved Discord accounts.
          </div>
        </Blueprint>
      </div>
    </div>
  );
}
