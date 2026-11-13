import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Flat config for the whole monorepo: server (Node/Express), client
 * (React + Vite) and the dependency-free test suite. Formatting itself is
 * Prettier's job — `eslint-config-prettier` (last) turns off every stylistic
 * rule so the two tools never disagree.
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "client-dist/**",
      "server/dist/**",
      "server/data/**",
      "playwright-report/**",
      "test-results/**",
      "**/*.py",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["server/**/*.ts", "*.ts", "*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Production code is fully typed; SQLite rows and model output are
      // described with explicit row/payload types instead of `any`.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    // Last, so it wins over the rule above: the integration suite asserts over
    // arbitrary JSON from a live HTTP API, where typing every response would
    // obscure the assertions rather than harden them.
    files: ["server/test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  prettier,
);
