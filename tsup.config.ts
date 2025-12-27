import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'client/index': 'src/client/index.ts',
    'server/index': 'src/server/index.ts',
    'react/index': 'src/react/index.ts',
    'adapters/index': 'src/adapters/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: [
    // Solana
    '@solana/web3.js',
    '@solana/spl-token',
    '@solana/wallet-adapter-base',
    // EVM (optional - only needed for advanced usage)
    'viem',
    // React (optional)
    'react',
    'react-dom',
  ],
});
