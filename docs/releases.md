# Publishing x402

Releases use GitHub Actions and npm trusted publishing. Merge the release changes into `main`, then push `v<package-version>`. The workflow tests the source, builds once, packs once, and installs that archive into a fresh consumer to check Tab and MCP behavior.

After those checks pass, approve the `x402-npm-production` deployment in GitHub. That is the release approval. The protected job publishes the tested archive using GitHub OIDC, checks npm's integrity and distribution tag, and tests a fresh installation from the registry. It then records a GitHub release. Stable versions use `latest`; prereleases use `next`.

The workflow also supports **Run workflow** on an existing version tag. Running it on a branch is rejected. A retry accepts an already-published version only when its integrity matches the tested archive. A mismatched version or distribution tag fails without overwriting a package or moving a tag backward.

## Publisher configuration

Configure npm's trusted publisher for `@dexterai/x402` with:

| Setting | Value |
| --- | --- |
| Organization | `Dexter-DAO` |
| Repository | `dexter-x402-sdk` |
| Workflow filename | `publish.yml` |
| GitHub environment | `x402-npm-production` |
| Allowed action | Direct `npm publish` |

Protect the GitHub environment with the release approver and allow release tags. The workflow uses GitHub-hosted Ubuntu, Node 24 and npm 11.19.1. Only the protected publish job has `id-token: write`. npm publishes the archive with lifecycle scripts disabled and provenance enabled.

This follows [npm's trusted publishing configuration](https://docs.npmjs.com/trusted-publishers/). Newly configured publishers must explicitly allow direct publishing; stage-only publishing would add a separate approval step.

## Package evidence

The build artifact contains the tarball, `proof.json` and `release.json`. The publish artifact records the registry's version, integrity and distribution tag. The fresh-install checks exercise local fixtures; chain settlement and production delivery require their own evidence.

Run the package qualification locally after building:

```sh
npm ci --ignore-scripts
npm run build
npm run verify:tab:package
```

Set `DEXTER_X402_PACKAGE_PROOF_DIR` to an empty directory to choose where the tarball, consumer and proof are saved. The workflow uses that option to upload the same archive it tested. An optional positional Vault archive is available for local prerelease qualification; the installed Vault version must match the exact peer dependency.
