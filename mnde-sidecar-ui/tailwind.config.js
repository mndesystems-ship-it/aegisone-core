/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#101215",
        panel2: "#16191d",
        line: "#2b3036",
        ink: "#d5d9de",
        muted: "#8f98a3",
        safe: "#2bb673",
        warn: "#c7972a",
        danger: "#d15a4a",
        idle: "#68717b",
        signal: "#aeb6bf"
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "Arial", "sans-serif"],
        mono: ["Cascadia Mono", "SFMono-Regular", "Consolas", "monospace"]
      },
      boxShadow: {
        operational: "none"
      }
    }
  },
  plugins: []
};
