"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { StatsSummary, fetcher } from "@/lib/api";

export function Nav() {
  const pathname = usePathname();
  const { data: stats } = useSWR<StatsSummary>("/api/stats/summary", fetcher, {
    refreshInterval: 60_000,
  });
  return (
    <header style={{ borderBottom: "1px solid var(--color-divider)" }}>
      <div className="nav mx-auto w-full max-w-[1280px]">
        <Link href="/" className="nav-brand">
          ARTURO
        </Link>
        <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
          Today
        </Link>
        <a href="#" style={{ opacity: 0.45, pointerEvents: "none" }}>
          Metrics
        </a>
        <span
          className="text-muted"
          style={{
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {stats
            ? `${stats.open_tasks} open · 7-day avg ${stats.seven_day_avg}/day`
            : "…"}
        </span>
      </div>
    </header>
  );
}
