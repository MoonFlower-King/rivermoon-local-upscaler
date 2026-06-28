import { defineConfig } from "vitest/config";

// 独立于 vite.config.ts（后者把 root 设为 src/renderer，会干扰测试文件解析）。
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node"
  }
});
