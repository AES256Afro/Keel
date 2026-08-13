"use client";

import { useState } from "react";

export type Theme = "system" | "light" | "dark";

const YEAR = 60 * 60 * 24 * 365;

function apply(theme: Theme) {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
    document.cookie = "keel-theme=; path=/; max-age=0; samesite=lax";
  } else {
    document.documentElement.dataset.theme = theme;
    document.cookie = `keel-theme=${theme}; path=/; max-age=${YEAR}; samesite=lax`;
  }
}

/**
 * @param current the saved theme, read from the cookie on the server. Passing
 *   it in beats reading `document.documentElement.dataset.theme` after mount:
 *   the right button is highlighted in the very first paint, with no effect and
 *   no hydration mismatch.
 */
export default function ThemeSelect({ current = "system" }: { current?: Theme }) {
  const [theme, setTheme] = useState<Theme>(current);

  const options: { value: Theme; label: string; icon: string }[] = [
    { value: "system", label: "System", icon: "🖥️" },
    { value: "light", label: "Light", icon: "☀️" },
    { value: "dark", label: "Dark", icon: "🌙" },
  ];

  return (
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => {
            setTheme(o.value);
            apply(o.value);
          }}
          className={`rounded border px-3 py-1.5 text-sm ${
            theme === o.value
              ? "border-[var(--fg)] font-medium"
              : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)]"
          }`}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}
