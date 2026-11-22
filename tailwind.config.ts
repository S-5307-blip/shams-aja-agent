import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f172a",
        muted: "#64748b",
        line: "#e2e8f0",
        brand: "#b45309",
        "brand-dark": "#92400e",
      },
      fontFamily: { sans: ["IBM Plex Sans Arabic", "Arial", "sans-serif"] },
    },
  },
  plugins: [],
};
export default config;
