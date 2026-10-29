import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // R3 코드 경계: 추정기, 탐색기, 결정, 상태, 화면은 참 함수를 읽을 수 없다. 참 값은 평가 실행기(src/lib/eval)만 읽는다.
  {
    files: ["src/lib/estimate/**", "src/lib/search/**", "src/lib/decide/**", "src/lib/ledger/**", "src/lib/llm/**", "src/lib/state.ts", "src/app/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/world/truth", "**/world/truth.ts"], message: "참 함수는 평가 실행기만 읽는다 (SPEC R3)" }] }],
    },
  },
]);

export default eslintConfig;
