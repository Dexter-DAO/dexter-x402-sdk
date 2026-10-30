// ---- constants
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SELLER_PROFILE_TYPE = 'DexterSellerProfile';
export const SELLER_PROFILE_VERSION = 'dexter-seller-profile/v1';
export const ADDRESS_PROOF_TYPE = 'dexter-seller-address/v1';
export const SELLER_BINDING_VERSION = 'dexter-seller-binding/v1';
export const SELLER_BINDING_DOMAIN = 'DEXTER_SELLER_BINDING_V1';
export const MAX_OFFER_LIFETIME_SECONDS = 600;
export const CLOCK_SKEW_SECONDS = 60;
export const DID_DOCUMENT_MAX_BYTES = 65_536;
export const DID_FETCH_TIMEOUT_MS = 5_000;

// ---- inputs
export interface Ed25519PublicJwk { kty: 'OKP'; crv: 'Ed25519'; x: string }
export interface SignedOfferJws { format: 'jws'; signature: string }
export interface OfferPayloadV1 { version: 1; resourceUrl: string; scheme: string; network: string; asset: string; payTo: string; amount: string; validUntil: number }
export interface SellerAddress { network: string; asset: string; address: string; proof: string }
export interface SellerProfileV1 { v: 'dexter-seller-profile/v1'; name: string; hosts: string[]; signingKeys: string[]; payTo: SellerAddress[] }

export interface SellerRequest {
  counterparty: string;                   // SpendGrantRequest.counterparty
  appName: string;                        // SpendGrantRequest.app.name: the requester's own claim; R4 input, and shown only as AgentDisplay.claimedName
  seller?: { calledUrl: string; offer?: SignedOfferJws; expectedHost?: string };
  scheme: 'tab'; network: typeof SOLANA_MAINNET; asset: typeof USDC_MINT;
}
/** Default: fetch(url, {redirect:'error', credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer',
 *  headers:{accept:'application/did+json, application/json'}, signal: timeout 5 s}); 200 only; body streamed with a 64 KiB cap. */
export type FetchDidDocument = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;

export interface KnownSeller {               // the owner's own history, one entry per exact host
  host: string; registrableDomain: string; did: string; kid: string; key: Ed25519PublicJwk; keyThumbprint: string;
  didDocumentSha256: string;                // the file hash recorded at that approval (the saved path reports it)
  addresses: string[]; addressListSha256: string; label: string | null;
  firstApprovedAt: number; lastApprovedAt: number; lastRegisterTx: string;
}
export interface AgentKeyHistory { sessionPubkey: string; firstApprovedAt: number; lastApprovedAt: number }
export interface SellerHistoryEntry { binding: Uint8Array; salt: Uint8Array; ceremonyNonce: Uint8Array; registerTx: string; registeredAt: number }

// ---- outcomes
export type R1Code =
  | 'called_url_invalid' | 'offer_format_unsupported' | 'offer_malformed' | 'offer_alg_unsupported'
  | 'kid_not_did_url' | 'did_method_unsupported' | 'resource_url_invalid' | 'resource_host_mismatch'
  | 'did_not_registrable_domain' | 'offer_terms_mismatch' | 'offer_validity_missing' | 'offer_expired'
  | 'offer_validity_too_long' | 'did_document_invalid' | 'host_not_listed' | 'kid_not_listed'
  | 'key_invalid' | 'signature_invalid';
export type R2Code = 'payto_mismatch' | 'payto_not_listed' | 'address_proof_invalid';
export type R3Code = 'expected_host_mismatch';
export type SellerRefusal =
  | { rule: 'R1'; code: R1Code; detail: string }
  | { rule: 'R2'; code: R2Code; detail: string }
  | { rule: 'R3'; code: R3Code; detail: string };
export type UnsignedReason = 'no_offer' | 'did_document_unavailable';

export interface SignedSeller {
  status: 'signed'; source: 'live' | 'saved'; checkedAt: number;
  calledUrl: string; host: string; registrableDomain: string; did: string; kid: string;
  key: Ed25519PublicJwk; keyThumbprint: string;
  didDocument: Uint8Array | null;          // exact bytes; null when source = 'saved'
  didDocumentSha256: string;               // when source = 'saved', the hash recorded at the owner's last approval
  profile: SellerProfileV1 | null;         // null when source = 'saved'
  addresses: string[]; addressListSha256: string;
  offerJws: string; offerJwsSha256: string; offer: OfferPayloadV1;
}
export type SellerCheck =
  | SignedSeller
  | { status: 'unsigned'; reason: UnsignedReason; calledUrl: string | null; host: string | null; checkedAt: number }
  | { status: 'refused'; refusal: SellerRefusal; claimedHost: string | null; checkedAt: number };


// ---- the screen rules
export type ScreenNotice =
  | { rule: 'R4'; code: 'lookalike_name'; knownHost: string; knownLabel: string; matched: string }
  | { rule: 'R4'; code: 'lookalike_host'; knownHost: string; matched: string; reason: 'confusable' | 'edit_distance' | 'embedded_domain' }
  | { rule: 'R5'; code: 'key_changed' | 'addresses_changed' | 'key_changed_unreadable'; knownHost: string; since: number }
  | { rule: 'R5'; code: 'unsigned_known_host'; knownHost: string; knownAddresses: string[]; since: number };
export interface SellerDisplay {
  kind: 'website' | 'address';                                // 'address' for every unsigned outcome: the host a request names is never shown
  host?: string; mutedPrefix?: string; boldDomain?: string;   // signed outcomes only; ASCII only; never decoded from punycode
  relation: 'known' | 'first-payment' | 'unsigned' | 'unknown'; knownSince?: number;   // 'unknown': history did not load; never shown as first payment
  unsignedReason?: UnsignedReason; savedKey?: boolean;
  address: string;                                            // always shown
}
export interface AgentDisplay {
  sessionPubkey: string;
  claimedName: string | null;   // request.app.name: rendered only as a muted quoted claim under the key; never a headline, never in or above the seller block
  relation: 'known' | 'new' | 'unknown'; firstApprovedAt?: number;   // 'unknown': history did not load
  replaces?: { sessionPubkey: string; firstApprovedAt?: number };
}
export type ScreenDecision =
  | { approve: 'allowed'; seller: SellerDisplay; agent: AgentDisplay; notices: [] }
  | { approve: 'confirm'; seller: SellerDisplay; agent: AgentDisplay; notices: ScreenNotice[] }
  | { approve: 'refused'; seller: SellerDisplay; agent: AgentDisplay; refusal: SellerRefusal };


// ---- history, binding, commitment
/** Admits an entry only if its binding decodes strictly, binding.vault equals options.vault, and
 *  sellerBindingNonce(binding, salt) equals its ceremonyNonce. Everything else is skipped, never "known". */

// ---- after the fact (proof page, verify script)
export interface SellerEvidenceCheck {
  name: 'binding_bytes' | 'registration_match' | 'commitment' | 'did_document_hash' | 'did_document_valid'
      | 'key_listed' | 'host_listed' | 'offer_signature' | 'offer_terms' | 'payto_listed' | 'address_proofs';
  ok: boolean; detail: string;
}

// ---- helpers used by stores, tools and the page
export interface SellerBindingV1 {
  v: 'dexter-seller-binding/v1';
  vault: string;                 // owner's vault PDA (base58); equals challenge bytes 96-128
  counterparty: string;          // equals the registration's allowed_counterparty
  sessionPubkey: string;         // equals the registration's session_pubkey (the agent key)
  calledUrl: string;
  host: string;                  // ASCII host of resourceUrl
  registrableDomain: string;
  did: string;                   // did:web:<registrableDomain>
  kid: string;
  key: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  keyThumbprint: string;         // RFC 7638 SHA-256, base64url
  didDocumentSha256: string;     // hex, over the exact bytes fetched
  addresses: string[];           // the profile's payTo addresses for this network and asset, sorted
  addressListSha256: string;     // hex SHA-256 of RFC8785 of the payTo entries without proofs, sorted by (network, asset, address)
  offerJwsSha256: string;        // hex SHA-256 of the JWS compact string's ASCII bytes
  offer: { version: 1; resourceUrl: string; scheme: string; network: string; asset: string; payTo: string; amount: string; validUntil: number };
  label: string | null;          // the profile's `name`, recorded only as a label for later lookalike notices
  source: 'live' | 'saved';      // saved = the website's file was unreadable; checked against the owner's last approval
  relation: 'known' | 'first-payment' | 'unknown';   // 'unknown': his history did not load at approval
  notices: Array<{ rule: 'R4' | 'R5'; code: string; knownHost: string; confirmed: true }>;   // codes as ScreenNotice (section 2)
  checkedAt: number;             // unix seconds, the final check just before the passkey prompt
  checker: string;               // '@dexterai/x402@<version>/seller'
  page: string;                  // 'dexter-fe@<sourceCommit>': the release build's existing DEXTER_FE_SOURCE_COMMIT (already its Next build id,
                                 // next.config.js:46), exposed to the bundle through next.config `env`; 'dexter-fe@dev' in local builds
}
