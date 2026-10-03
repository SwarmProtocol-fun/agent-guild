import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "dist/**",
      "*.config.js",
      "*.config.mjs",
      // Vendored dimOS DimSim (built by its own Vite config into public/dimsim)
      "mods/*/dimsim/**",
      "public/dimsim/**"
    ]
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "no-undef": "off"
    }
  }
);
