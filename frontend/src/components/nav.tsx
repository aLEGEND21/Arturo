"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { API_BASE, Me, api, fetcher } from "@/lib/api";
import { buttonClass } from "@/lib/ui";

// Tighter than a standalone button: the nav is a compact strip. On phones
// the labels are what has to give, so each button collapses to its icon and
// keeps its accessible name from aria-label.
const navButton = "py-[5.1px] px-[10.2px] phone:px-[6.8px]";
const navLabel = "phone:hidden";

export function Nav() {
  // The login page has no session, so nothing here would load; render
  // nothing rather than a bar full of placeholders (and no 401 bounces).
  const onLogin = usePathname() === "/login";
  const { data: me } = useSWR<Me>(onLogin ? null : "/api/auth/me", fetcher);
  if (onLogin) return null;

  async function logout() {
    try {
      await api("/api/auth/logout", "POST");
    } finally {
      // Full navigation so the SWR caches from this session are dropped.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/login";
    }
  }

  return (
    <header className="border-b border-divider">
      {/* Horizontal padding matches the dashboard grid gutter so the brand
          and buttons line up with the column edges below. */}
      <div className="mx-auto flex w-full max-w-[1280px] items-center gap-[13.6px] px-page py-[13.6px]">
        <Link
          href="/"
          className="mr-auto font-heading text-[14px] font-semibold tracking-[0.06em] text-inherit no-underline hover:text-accent"
        >
          DASHBOARD
        </Link>
        {/* The backend sets Content-Disposition, so a plain link downloads
            the file — no fetch, no blob, and it works both in dev (straight
            to the API origin) and behind the compose proxy. As a link it
            takes the link hover color on its label. */}
        <a
          href={`${API_BASE}/api/export`}
          download
          className={buttonClass({ variant: "secondary", className: `${navButton} hover:text-accent-700` })}
          aria-label="Export tasks as JSON"
          title="Download today's list and every task ever, as JSON"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12" />
            <polyline points="7 10 12 15 17 10" />
            <path d="M4 20h16" />
          </svg>
          <span className={navLabel}>Export</span>
        </a>
        {me ? (
          <button
            type="button"
            className={buttonClass({ variant: "secondary", className: navButton })}
            onClick={logout}
            aria-label={`Signed in as ${me.display_name}. Sign out`}
            title={`Signed in as @${me.username} — click to sign out`}
          >
            {me.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- Discord CDN, tiny, no optimisation needed
              <img src={me.avatar_url} alt="" width={16} height={16} className="rounded-full" />
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            )}
            <span className={navLabel}>Sign out</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}
