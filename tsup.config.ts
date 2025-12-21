import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'client/index': 'src/client/index.ts',
    'server/index': 'src/server/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ['@solana/web3.js', '@solana/spl-token', '@solana/wallet-adapter-base'],
});

