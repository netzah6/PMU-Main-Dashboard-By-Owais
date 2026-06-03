import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        teal: {
          50: "#e6faf9",
          100: "#b3f0ed",
          200: "#80e6e1",
          300: "#4ddcd5",
          400: "#26d2ca",
          500: "#00B4A6",
          600: "#009d90",
          700: "#00857a",
          800: "#006e64",
          900: "#00574e",
        },
        navy: {
          50: "#e8ebf2",
          100: "#c5ccdf",
          200: "#9eaacb",
          300: "#7788b7",
          400: "#5a6fa8",
          500: "#3d5699",
          600: "#334d8d",
          700: "#274280",
          800: "#1a2744",
          900: "#111b32",
        },
      },
    },
  },
  plugins: [],
};
export default config;
