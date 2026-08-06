import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "data/**", "web/vendor/**"],
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // web/ 是浏览器端免构建 ESM：不声明浏览器全局的话，window/document/
  // setInterval 等会全部报 no-undef，真问题会被淹没在假错误里。
  {
    files: ["web/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        location: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        Audio: "readonly",
        Image: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        Blob: "readonly",
        FileReader: "readonly",
        performance: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
      },
    },
  },
);
