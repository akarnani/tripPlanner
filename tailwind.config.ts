import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";

export default {
  content: ["./index.html", "./app/src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: "var(--surface)",
        card: "var(--card)",
        hairline: "var(--border)",
        "hairline-input": "var(--border-input)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        accent: "var(--accent)",
        data: "var(--data)",
        ok: "var(--ok)",
        caution: "var(--caution)",
        danger: "var(--danger)",
        olive: "var(--olive)",
      },
      fontFamily: {
        sans: ["Instrument Sans", ...defaultTheme.fontFamily.sans],
        mono: ["B612 Mono", ...defaultTheme.fontFamily.mono],
      },
    },
  },
  plugins: [],
} satisfies Config;
