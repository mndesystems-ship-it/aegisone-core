/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#101418",
        panel2: "#151a20",
        line: "#252c34",
        ink: "#d7dde4",
        muted: "#89939f",
        safe: "#2bb673",
        warn: "#c7972a",
        danger: "#d15a4a",
        idle: "#68717b",
        signal: "#2dd4bf"
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "Arial", "sans-serif"],
        mono: ["Cascadia Mono", "SFMono-Regular", "Consolas", "monospace"]
      },
      boxShadow: {
        operational: "0 12px 42px rgba(0,0,0,0.35)"
      }
    }
  },
  plugins: []
};
