import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".next", "generated"],
  },
  ...nextCoreWebVitals,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // Client/server boundary guard. Client code (the Canvas island and the
    // dashboard client components) must never import from `~/server`: doing so
    // drags the server module graph (PrismaClient -> @prisma/adapter-pg -> pg
    // -> node:dns) into the browser bundle — a leak `tsc` cannot see. Domain
    // types come from `~/lib/types` and Zod schemas from `~/lib/schemas`.
    // See docs/adr/0004.
    files: ["src/app/**/_canvas/**", "src/app/_components/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/server/*", "~/server/**"],
              message:
                "Client code must not import from ~/server (it leaks the Prisma/pg/node:dns graph into the browser bundle). Use ~/lib/types for domain types and ~/lib/schemas for Zod schemas. See docs/adr/0004.",
            },
          ],
        },
      ],
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
);
