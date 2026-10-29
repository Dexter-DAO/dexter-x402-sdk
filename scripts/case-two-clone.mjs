#!/usr/bin/env node
// Clone-only setup. Never loads a production private key or a saved customer.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, SYSVAR_CLOCK_PUBKEY, AddressLookupTableProgram } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync } from '@solana/spl-token';
import * as sdk from '@dexterai/vault';
import * as ix from '@dexterai/vault/instructions';
import { buildSecp256r1VerifyInstruction } from '@dexterai/vault/precompile';
import { readVaultFull } from '@dexterai/vault/reader';
import { loadKey } from './case-two-refusal.mjs';

export const PROGRAM = new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
export const SWIG = new PublicKey('swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB');
export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const GRAPH = 'E7stJVEzf2VMk72KkLJET35Ub7VKx8QuJpWbkauK6WmU';
const stringify = (x) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const save = (p, x) => writeFileSync(p, stringify(x) + '\n', { mode: 0o600 });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (x) => createHash('sha256').update(x).digest();
function writeAccount(out, pubkey, account, data = account.data) {
  const target=join(out,pubkey.toBase58()+'.json');
  const dumped={pubkey:pubkey.toBase58(),account:{lamports:account.lamports,data:[data.toString('base64'),'base64'],owner:account.owner.toBase58(),executable:account.executable,
    rentEpoch:Number.isSafeInteger(account.rentEpoch)?account.rentEpoch:JSON.rawJSON('18446744073709551615')}};
  writeFileSync(target,JSON.stringify(dumped),{mode:0o600});return target;
}
function localRpc(rpc) { if (!['127.0.0.1','localhost','[::1]'].includes(new URL(rpc).hostname)) throw new Error('clone harness accepts only loopback RPC'); }
export async function send(connection, payer, instructions, signers = [payer]) {
  localRpc(connection.rpcEndpoint);
  const block = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: block.blockhash, instructions }).compileToV0Message());
  tx.sign(signers.filter((k) => tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).some((p) => p.equals(k.publicKey))));
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
  const result = await connection.confirmTransaction({ signature, ...block }, 'confirmed');
  if (result.value.err) throw new Error(`clone tx ${signature}: ${JSON.stringify(result.value.err)}`);
  return signature;
}
export function softwareOwner(file) {
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  const priv = createPrivateKey({ key: Buffer.from(stored.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-65);
  const pubkey = Buffer.concat([Buffer.from([raw[64] & 1 ? 3 : 2]), raw.subarray(1,33)]);
  return { pubkey, userHandle: Buffer.from(stored.userHandle,'hex'), signChallenge(challenge) {
    const authenticatorData = Buffer.concat([sha('dexter.cash'), Buffer.from([5]), Buffer.alloc(4)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(challenge).toString('base64url'), origin: 'https://dexter.cash', crossOrigin: false }));
    const message = Buffer.concat([authenticatorData, sha(clientDataJSON)]);
    const signature = sign('sha256', message, { key: priv, dsaEncoding: 'ieee-p1363' });
    const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
    const s = BigInt('0x' + signature.subarray(32).toString('hex'));
    if (s > n/2n) Buffer.from((n-s).toString(16).padStart(64,'0'),'hex').copy(signature,32);
    return { authenticatorData, clientDataJSON, signature, precompile: buildSecp256r1VerifyInstruction(pubkey, signature, message) };
  } };
}
export async function ceremony(connection, owner, vault, operationMessage, nonce) {
  const state = nonce === undefined ? await sdk.fetchPasskeyAuthorizationState(connection, vault) : null;
  const challenge = sdk.buildPasskeyAuthorizationChallenge({ vault, nonce: nonce ?? state.nonce,
    operationHash: sha(operationMessage), ceremonyNonce: randomBytes(32) });
  return owner.signChallenge(challenge);
}
async function launch(state) {
  const connection = new Connection(state.rpc,'confirmed');
  let listening = false; try { await connection.getVersion(); listening = true; } catch {}
  if (listening) throw new Error(`RPC ${state.rpc} already answers; refusing to replace another validator`);
  const log = openSync(join(state.out,'validator.log'),'a',0o600);
  const env = state.virtualTimeSeconds ? { ...process.env, LD_PRELOAD: state.clockLibrary, FAKETIME: `+${state.virtualTimeSeconds}s` } : process.env;
  const validatorArgs=state.validatorArgs.map((a)=>a==='__MAINNET_READ_RPC__'?readFileSync(state.mainnetRpcFile,'utf8').trim():a);
  const child = spawn(state.validator, validatorArgs, { stdio: ['ignore',log,log], detached:true, env });
  child.unref(); state.validatorPid = child.pid; save(join(state.out,'state.json'),state);
  for (let n=0;n<120;n++) {
    try { process.kill(child.pid,0); } catch { throw new Error('validator exited; inspect validator.log'); }
    try { await connection.getVersion(); return; } catch { await delay(500); }
  }
  throw new Error('clone did not become healthy within 60 seconds');
}
async function boot({out,fixtures,validator,mainnetRpcFile,port}) {
  if(existsSync(out) && readdirSync(out).length) throw new Error('clone output directory must be new or empty');
  mkdirSync(out,{ recursive:true,mode:0o700 });
  if (existsSync(join(out,'state.json'))) throw new Error('state.json already exists; use a new output directory');
  const state = { out, rpc:`http://127.0.0.1:${port}`, validator, sourceFixtures:fixtures, mainnetRpcFile };
  for (const name of ['authority','feePayer','merchant','mintAuthority']) {
    const k=Keypair.generate(); state[`${name}KeyPath`]=join(out,`${name}.json`); save(state[`${name}KeyPath`],Array.from(k.secretKey));
  }
  const owner=generateKeyPairSync('ec',{ namedCurve:'prime256v1' });
  state.softwareOwnerPath=join(out,'owner.json');
  save(state.softwareOwnerPath,{ pkcs8:owner.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),userHandle:randomBytes(16).toString('hex') });
  const graphRaw=readFileSync(join(fixtures,'graph-config.mainnet.json'),'utf8');
  const graph=JSON.parse(graphRaw);
  const graphData=Buffer.from(graph.account.data[0],'base64');
  const oldAdmin=Buffer.from(graphData.subarray(10,42)); loadKey(state.feePayerKeyPath).publicKey.toBuffer().copy(graphData,10);
  writeFileSync(join(out,'graph.json'),graphRaw.replace(JSON.stringify(graph.account.data[0]),JSON.stringify(graphData.toString('base64'))));
  const mintRaw=readFileSync(join(fixtures,'usdc-mint.mainnet.json'),'utf8');
  const mint=JSON.parse(mintRaw);
  const mintData=Buffer.from(mint.account.data[0],'base64'); loadKey(state.mintAuthorityKeyPath).publicKey.toBuffer().copy(mintData,4);
  writeFileSync(join(out,'usdc.json'),mintRaw.replace(JSON.stringify(mint.account.data[0]),JSON.stringify(mintData.toString('base64'))));
  const swig=Buffer.from(readFileSync(join(fixtures,'swig-live.so'))), fresh=loadKey(state.feePayerKeyPath).publicKey.toBuffer();
  for (let chunk=0;chunk<32;chunk+=8) {
    const hits=[];
    for(let i=0;i<swig.length-16;i++) if(swig[i]===0x18 && swig.subarray(i+4,i+8).equals(oldAdmin.subarray(chunk,chunk+4)) && swig.subarray(i+12,i+16).equals(oldAdmin.subarray(chunk+4,chunk+8))) hits.push(i);
    if(hits.length!==1) throw new Error(`Swig allowlist chunk ${chunk} has ${hits.length} matches`);
    fresh.subarray(chunk,chunk+4).copy(swig,hits[0]+4); fresh.subarray(chunk+4,chunk+8).copy(swig,hits[0]+12);
  }
  writeFileSync(join(out,'swig-clone.so'),swig);
  state.fixtureChanges={ graphAdmin: 'fresh local payer', usdcMintAuthority: 'fresh local mint key', swig: 'only one authorized CPI signer replaced with fresh local payer',
    vault: 'mainnet ELF and authority preserved; clone ProgramData deployment slot 1',swigOriginalSha256:sha(readFileSync(join(fixtures,'swig-live.so'))).toString('hex'),swigCloneSha256:sha(swig).toString('hex') };
  const mainnetRpc=readFileSync(mainnetRpcFile,'utf8').trim();
  const remote=new Connection(mainnetRpc,'confirmed');
  const vaultAccount=await remote.getAccountInfo(PROGRAM);
  const programDataAddress=new PublicKey(vaultAccount.data.subarray(4,36));
  const vaultData=await remote.getAccountInfo(programDataAddress);
  state.fixtureChanges.vaultSha256=sha(vaultData.data.subarray(45)).toString('hex');
  state.fixtureChanges.vaultDeploymentSlot=vaultData.data.readBigUInt64LE(4).toString();
  state.initialMainnetSlot=await remote.getSlot('finalized');
  const localProgramData=Buffer.from(vaultData.data);localProgramData.writeBigUInt64LE(1n,4);
  const programFile=writeAccount(out,PROGRAM,vaultAccount),programDataFile=writeAccount(out,programDataAddress,vaultData,localProgramData);
  state.fixtureChanges.vaultProgramData={originalMainnetDeploymentSlot:state.fixtureChanges.vaultDeploymentSlot,cloneDeploymentSlot:'1',upgradeAuthority:'original public authority unchanged',rawSha256:sha(localProgramData).toString('hex'),reason:'deployment must be an ancestor in the local bank fork'};
  state.validatorArgs=['--ledger',join(out,'ledger'),'--rpc-port',String(port),'--faucet-port',String(port+3),'--gossip-port',String(port+10),'--dynamic-port-range',`${port+20}-${port+70}`,'--bind-address','127.0.0.1',
    '--url','__MAINNET_READ_RPC__','--clone-feature-set','--upgradeable-program',SWIG.toBase58(),join(out,'swig-clone.so'),'none','--account',PROGRAM.toBase58(),programFile,'--account',programDataAddress.toBase58(),programDataFile,
    '--account',GRAPH,join(out,'graph.json'),'--account',USDC.toBase58(),join(out,'usdc.json'),'--quiet','--warp-slot','1'];
  await launch(state);
  // Don't print the read RPC credential carried in validatorArgs.
  console.log(stringify({ rpc:state.rpc,stateFile:join(out,'state.json'),validatorPid:state.validatorPid,fixtureChanges:state.fixtureChanges }));
}
async function birth(state) {
  if(state.vault) throw new Error('this clone owner is already born');
  localRpc(state.rpc); const connection=new Connection(state.rpc,'confirmed');
  const payer=loadKey(state.feePayerKeyPath), authority=loadKey(state.authorityKeyPath), owner=softwareOwner(state.softwareOwnerPath);
  for(const k of [payer,authority]) { const sig=await connection.requestAirdrop(k.publicKey,50_000_000_000); await connection.confirmTransaction(sig,'confirmed'); }
  const {pda:vault}=ix.deriveVaultPda(owner.userHandle);
  const hmacKey=authority.secretKey.subarray(0,32), swigId=ix.deriveSwigId(owner.userHandle,hmacKey);
  const [swig]=PublicKey.findProgramAddressSync([Buffer.from('swig'),swigId],SWIG);
  const [wallet]=PublicKey.findProgramAddressSync([Buffer.from('swig-wallet-address'),swig.toBuffer()],SWIG);
  const spend={spendLimitAtomic:0n,sessionTtlSeconds:2_592_000n,spendMode:0};
  const operation=ix.buildSetSwigAtomicOperationMessageFromIdentity({vaultPda:vault,feePayer:payer.publicKey,dexterMasterPubkey:authority.publicKey,identitySeed:owner.userHandle,hmacKey,...spend});
  const signed=await ceremony(connection,owner,vault,operation,0n);
  const identityClaim=new Uint8Array(32); identityClaim.set(owner.userHandle);
  const prep=[ComputeBudgetProgram.setComputeUnitLimit({units:800_000}),ix.buildInitializeVaultInstruction({vaultPda:vault,payer:payer.publicKey,dexterAuthority:authority.publicKey,passkeyPubkey:owner.pubkey,coolingOffSeconds:0,identityClaim}),
    ix.buildInitializePasskeyAuthorizationInstruction({payer:payer.publicKey,vaultPda:vault})];
  const preparationTx=(await connection.getAccountInfo(vault)) ? (await connection.getSignaturesForAddress(vault,{limit:1}))[0].signature : await send(connection,payer,prep,[payer,authority]);
  const birthTx=await send(connection,payer,[ComputeBudgetProgram.setComputeUnitLimit({units:800_000}),signed.precompile,
    ix.buildSetSwigAtomicFromIdentity({vaultPda:vault,feePayer:payer.publicKey,dexterMasterPubkey:authority.publicKey,identitySeed:owner.userHandle,hmacKey,clientDataJSON:signed.clientDataJSON,authenticatorData:signed.authenticatorData,...spend})],[payer,authority]);
  const ata=await getOrCreateAssociatedTokenAccount(connection,payer,USDC,wallet,true);
  await mintTo(connection,payer,USDC,ata.address,loadKey(state.mintAuthorityKeyPath),10_000_000n);
  await send(connection,payer,[(await import('@solana/web3.js')).SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:wallet,lamports:2_000_000})]);
  const merchant=loadKey(state.merchantKeyPath).publicKey;
  await getOrCreateAssociatedTokenAccount(connection,payer,USDC,merchant);
  const [sessionPda]=sdk.deriveSessionPda(vault,merchant);
  Object.assign(state,{vault:vault.toBase58(),swig:swig.toBase58(),wallet:wallet.toBase58(),walletUsdcAta:ata.address.toBase58(),seller:merchant.toBase58(),sessionPda:sessionPda.toBase58(),preparationTx,birthTx});
  save(join(state.out,'state.json'),state);
  console.log(stringify({rpc:state.rpc,vault:state.vault,swig:state.swig,wallet:state.wallet,seller:state.seller,agentKeyPath:state.agentKeyPath,preparationTx,birthTx,state:await readVaultFull(connection,vault)}));
}
async function stopOwned(state) {
  const cmdline=readFileSync(`/proc/${state.validatorPid}/cmdline`,'utf8');
  if(!cmdline.includes(state.out) || !cmdline.includes('solana-test-validator')) throw new Error('saved pid is not this clone validator');
  process.kill(state.validatorPid,'SIGTERM');
  for(let n=0;n<100;n++){ try {process.kill(state.validatorPid,0);}catch{return;} await delay(100); }
  throw new Error('owned validator did not stop');
}
async function advanceTime(state, seconds, library) {
  localRpc(state.rpc);
  if(!Number.isSafeInteger(seconds) || seconds<=0 || !existsSync(library)) throw new Error('positive integer seconds and clock library required');
  const connection=new Connection(state.rpc,'confirmed');
  const accounts=new Map();
  for(const owner of [PROGRAM,SWIG,new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),AddressLookupTableProgram.programId]) {
    for(const {pubkey,account}of await connection.getProgramAccounts(owner,'confirmed')) accounts.set(pubkey.toBase58(),account);
  }
  for(const [name,file]of Object.entries(state)) if(name.endsWith('KeyPath')) {
    const key=loadKey(file).publicKey,account=await connection.getAccountInfo(key);if(account)accounts.set(key.toBase58(),account);
  }
  const wallet=new PublicKey(state.wallet);accounts.set(state.wallet,await connection.getAccountInfo(wallet));
  for(const program of [PROGRAM,SWIG]) {
    const account=await connection.getAccountInfo(program);const dataKey=new PublicKey(account.data.subarray(4,36));
    accounts.set(program.toBase58(),account);accounts.set(dataKey.toBase58(),await connection.getAccountInfo(dataKey));
  }
  const snapshot=join(state.out,'expiry-account-snapshots');mkdirSync(snapshot,{mode:0o700});
  const files=[...accounts].map(([pubkey,account])=>({pubkey,path:writeAccount(snapshot,new PublicKey(pubkey),account),beforeSha256:sha(account.data).toString('hex')}));
  const beforeClock=(await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)).data.readBigInt64LE(32).toString();
  const previousLedger=state.validatorArgs[state.validatorArgs.indexOf('--ledger')+1];
  await stopOwned(state);
  const args=[...state.validatorArgs];args[args.indexOf('--ledger')+1]=join(state.out,'ledger-after-expiry');
  if(existsSync(args[args.indexOf('--ledger')+1]))throw new Error('future ledger already exists; inspect preserved state');
  for(let i=args.length-1;i>=0;i--) {
    if(args[i]==='--account')args.splice(i,3);
    else if(args[i]==='--upgradeable-program')args.splice(i,4);
  }
  const warp=args.indexOf('--warp-slot');if(warp>=0)args.splice(warp,2);args.push('--warp-slot','1');
  for(const file of files)args.push('--account',file.pubkey,file.path);
  state.validatorArgs=args;state.virtualTimeSeconds=seconds;state.clockLibrary=library;state.previousLedger=previousLedger;
  await launch(state);
  const restored=await connection.getMultipleAccountsInfo(files.map((file)=>new PublicKey(file.pubkey)));
  const preserved=files.map((file,i)=>({pubkey:file.pubkey,beforeSha256:file.beforeSha256,afterSha256:restored[i]?sha(restored[i].data).toString('hex'):null}));
  if(preserved.some((file)=>file.beforeSha256!==file.afterSha256))throw new Error('snapshot restore changed account data');
  const afterClock=(await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)).data.readBigInt64LE(32).toString();
  const session=await sdk.fetchSessionAccount(connection,new PublicKey(state.vault),new PublicKey(state.seller));
  const proof={previousLedger,newLedger:args[args.indexOf('--ledger')+1],processOffsetSeconds:seconds,hostUnix:Math.floor(Date.now()/1000),beforeClockUnix:beforeClock,afterClockUnix:afterClock,approvedExpiresAt:session.session.expiresAt,
    approvedNonce:session.session.nonce,spentAtomic:session.session.spent.toString(),allAccountDataUnchanged:true,preserved};
  save(join(state.out,'time-advance-proof.json'),proof);
  if(BigInt(afterClock)<=BigInt(session.session.expiresAt))throw new Error('actual validator Clock has not crossed approved expiry');
  console.log(stringify(proof));
}
async function main() {
  const {positionals,values:v}=parseArgs({allowPositionals:true,options:{out:{type:'string'},fixtures:{type:'string'},validator:{type:'string'},'mainnet-rpc-file':{type:'string'},port:{type:'string',default:'27899'},slot:{type:'string'},seconds:{type:'string'},'clock-library':{type:'string'}}});
  if(!v.out) throw new Error('--out required'); const out=resolve(v.out);
  if(positionals[0]==='boot') return boot({out,fixtures:resolve(v.fixtures),validator:resolve(v.validator),mainnetRpcFile:resolve(v['mainnet-rpc-file']),port:Number(v.port)});
  const state=JSON.parse(readFileSync(join(out,'state.json'),'utf8'));
  if(positionals[0]==='birth') return birth(state);
  if(positionals[0]==='start') return launch(state);
  if(positionals[0]==='stop') { await stopOwned(state);return; }
  if(positionals[0]==='advance-time') return advanceTime(state,Number(v.seconds),resolve(v['clock-library']));
  if(positionals[0]==='warp') {
    if(!v.slot || !/^\d+$/.test(v.slot)) throw new Error('--slot required');
    await stopOwned(state);
    const previousWarp=state.validatorArgs.indexOf('--warp-slot');
    if(previousWarp>=0) state.validatorArgs.splice(previousWarp,2);
    state.validatorArgs.push('--warp-slot',v.slot); await launch(state); console.log(`clone warped to slot ${v.slot}`); return;
  }
  throw new Error('command must be boot, birth, start, warp, or advance-time');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch((e)=>{console.error(e.logs??'',e);process.exitCode=1;});
