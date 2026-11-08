import { defineConfig } from 'vitest/config';
// Unit tests (no emulator). Rules and functions integration tests have their own configs.
export default defineConfig({ test: { include: ['shared/**/*.test.ts', 'src/**/*.test.ts'] } });
