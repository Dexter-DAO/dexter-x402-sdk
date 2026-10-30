# Case three copycat

This copies W2's Dexter Bookstore page for the case-three demonstration. The copycat holds no money and delivers nothing. Its routes only return quotes. POST returns 405 and unknown books return 404. The Innovator's Dilemma and The Sovereign Individual are the shelf's demonstration editions, with no text and no shipment.

V1 signs its own website and receiving address. V2 claims books.dexter.cash but signs with the copycat key, which the real website does not list. V4 has no signature. W9 constructs V3 by pairing the real quote with the copycat address, and V5 by naming the real website without a quote. The signed variants expire after 600 seconds. Functions set their response headers directly; Pages `_headers` applies to the static document.

The public receiving address and quote key are in `.well-known/did.json`. Private keys stay outside Git. `IMPOSTOR_QUOTE_JWK` is the only secret binding. `lib/payment.js` uses the installed upstream x402 offer and extension encoders with a WebCrypto Ed25519 signer. No new package is required.

The page was copied from W2's `booksStoreHtml` and six-item catalog because the public bookstore returned 404 during implementation. Compare with `GET https://books.dexter.cash/` once Claude releases W2. Only the footer is changed.

Local commands, from this folder:

```sh
# Create a mode-600 .dev.vars file locally with IMPOSTOR_QUOTE_JWK.
# Read the JWK file into it without printing the private value. Never commit it.
nice -n 10 npx wrangler@3 pages dev .
```

On the shared EC2 server, run builds and browser checks under the common lock:

```sh
flock /home/branchmanager/worktrees/briefs/case-three/.heavy.lock nice -n 19 ionice -c3 npx wrangler@3 pages dev . --ip 127.0.0.1 --port 8798
```

Run `verify.mjs` with Node 22, the W1 combined seller build and W4's generated real document. This tests the actual local HTTP routes, signed terms, byte-identical header/body, address proof, R1/R2 refusals and unsigned variants. `--live` fetches both public documents and the real quote; it fails if those are unavailable.

```sh
nice -n 10 node verify.mjs --origin http://127.0.0.1:8798 --checker /home/branchmanager/worktrees/case-three-seller-check/dist/seller/index.js --real-document /home/branchmanager/worktrees/briefs/case-three/results/dexter.cash.did.json
nice -n 10 node verify.mjs --origin https://dexter-bookstore.pages.dev --checker /home/branchmanager/worktrees/case-three-seller-check/dist/seller/index.js --live
```

Claude runs the following after review. These commands create the project, upload its secret from stdin, and deploy from this folder so Wrangler finds `functions/`. Codex does not run them.

```sh
cd /home/branchmanager/worktrees/case-three-impostor
flock /home/branchmanager/worktrees/briefs/case-three/.heavy.lock nice -n 19 ionice -c3 npm ci --ignore-scripts
export CLOUDFLARE_API_KEY="$CLOUDFLARE_GLOBAL_API_KEY" CLOUDFLARE_EMAIL CLOUDFLARE_ACCOUNT_ID=87c7525e4e3a2a6f7d240c9894590cc5
cd /home/branchmanager/worktrees/case-three-impostor/examples/case-three-impostor
nice -n 10 npx wrangler@3 pages project create dexter-bookstore --production-branch main
nice -n 10 npx wrangler@3 pages secret put IMPOSTOR_QUOTE_JWK --project-name dexter-bookstore < /home/branchmanager/.config/dexter/case-three/impostor-quote-key.jwk.json
flock /home/branchmanager/worktrees/briefs/case-three/.heavy.lock nice -n 19 ionice -c3 npx wrangler@3 pages deploy . --project-name dexter-bookstore --branch main
nice -n 10 curl -sD - https://dexter-bookstore.pages.dev/.well-known/did.json -o /dev/null
nice -n 10 curl -s -o /dev/null -w '%{http_code}\n' https://dexter-bookstore.pages.dev/books/the-innovators-dilemma
```

Expected: DID HTTP 200, `application/did+json`, `no-store`, `Access-Control-Allow-Origin: *`; book HTTP 402. No website or address is established as trustworthy merely by signing its own quote. A fresh buyer can approve V1. After the buyer has approved the real store, W1 requires a separate confirmation for V1, V4 and V5; V2 and V3 are refused.
