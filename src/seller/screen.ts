import { displayHost, hostLookalike, nameMatches } from './host';
import type {
  AgentDisplay, AgentKeyHistory, KnownSeller, ScreenDecision, ScreenNotice, SellerCheck, SellerDisplay, SellerRequest,
} from './types';

export interface ScreenInput {
  request: SellerRequest;
  sessionPubkey: string;
  known: readonly KnownSeller[];
  agentKeys: readonly AgentKeyHistory[];
  liveSessionKey?: string | null;
  /** 'unavailable': R4 and R5 cannot run; relations become 'unknown', never first payment. */
  history: 'loaded' | 'unavailable';
}

/** The approval screen's decision for one request (SPEC section 2, rules R1-R5). */
export function screenSeller(check: SellerCheck, input: ScreenInput): ScreenDecision {
  const historyLoaded = input.history === 'loaded';
  const known = historyLoaded ? input.known : [];
  const agent = agentDisplay(input, historyLoaded);

  if (check.status === 'refused') {
    return {
      approve: 'refused',
      seller: { kind: 'address', relation: historyLoaded ? 'unsigned' : 'unknown', address: input.request.counterparty },
      agent,
      refusal: check.refusal,
    };
  }

  const notices: ScreenNotice[] = [];
  let seller: SellerDisplay;

  if (check.status === 'unsigned') {
    // Address only: the host a request names is never shown.
    seller = {
      kind: 'address', relation: historyLoaded ? 'unsigned' : 'unknown',
      unsignedReason: check.reason, address: input.request.counterparty,
    };
    if (historyLoaded) {
      nameNotices(notices, [input.request.appName], known, null);
      const named = [check.host, input.request.seller?.expectedHost].filter((host): host is string => !!host);
      for (const store of known) {
        if (!named.includes(store.host)) continue;
        if (check.reason === 'no_offer' && !store.addresses.includes(input.request.counterparty)) {
          notices.push({ rule: 'R5', code: 'unsigned_known_host', knownHost: store.host, knownAddresses: [...store.addresses], since: store.lastApprovedAt });
        } else if (check.reason === 'did_document_unavailable') {
          // checkSellerOffer only returns this for a known host when the quote's kid is not the one he approved.
          notices.push({ rule: 'R5', code: 'key_changed_unreadable', knownHost: store.host, since: store.lastApprovedAt });
        }
      }
    }
  } else {
    const store = known.find((entry) => entry.host === check.host);
    const display = displayHost(check.host);
    seller = {
      kind: 'website', host: check.host, mutedPrefix: display.mutedPrefix, boldDomain: display.boldDomain,
      relation: !historyLoaded ? 'unknown' : store ? 'known' : 'first-payment',
      ...(store ? { knownSince: store.firstApprovedAt } : {}),
      ...(check.source === 'saved' ? { savedKey: true } : {}),
      address: check.offer.payTo,
    };
    if (store) {
      if (store.keyThumbprint !== check.keyThumbprint) notices.push({ rule: 'R5', code: 'key_changed', knownHost: store.host, since: store.lastApprovedAt });
      if (store.addressListSha256 !== check.addressListSha256) notices.push({ rule: 'R5', code: 'addresses_changed', knownHost: store.host, since: store.lastApprovedAt });
    } else if (historyLoaded) {
      nameNotices(notices, [check.profile?.name, input.request.appName], known, check.registrableDomain);
      const others = known.filter((entry) => entry.registrableDomain !== check.registrableDomain);
      const lookalike = hostLookalike(check.host, others.map((entry) => entry.host));
      if (lookalike) notices.push({ rule: 'R4', code: 'lookalike_host', knownHost: lookalike.knownHost, matched: check.host, reason: lookalike.reason });
    }
  }

  return notices.length
    ? { approve: 'confirm', seller, agent, notices }
    : { approve: 'allowed', seller, agent, notices: [] };
}

/** R4 by name: one notice per known store whose label a supplied name matches. A store on the same registrable domain is the same owner. */
function nameNotices(notices: ScreenNotice[], names: Array<string | null | undefined>, known: readonly KnownSeller[], ownDomain: string | null): void {
  for (const store of known) {
    if (!store.label || store.registrableDomain === ownDomain) continue;
    const matched = names.find((name): name is string => !!name && nameMatches(name, store.label as string));
    if (matched && !notices.some((n) => n.rule === 'R4' && n.knownHost === store.host)) {
      notices.push({ rule: 'R4', code: 'lookalike_name', knownHost: store.host, knownLabel: store.label, matched });
    }
  }
}

function agentDisplay(input: ScreenInput, historyLoaded: boolean): AgentDisplay {
  const history = historyLoaded ? input.agentKeys.find((entry) => entry.sessionPubkey === input.sessionPubkey) : undefined;
  const live = input.liveSessionKey && input.liveSessionKey !== input.sessionPubkey ? input.liveSessionKey : null;
  const liveHistory = live && historyLoaded ? input.agentKeys.find((entry) => entry.sessionPubkey === live) : undefined;
  return {
    sessionPubkey: input.sessionPubkey,
    claimedName: input.request.appName ? input.request.appName : null,
    relation: !historyLoaded ? 'unknown' : history ? 'known' : 'new',
    ...(history ? { firstApprovedAt: history.firstApprovedAt } : {}),
    ...(live ? { replaces: { sessionPubkey: live, ...(liveHistory ? { firstApprovedAt: liveHistory.firstApprovedAt } : {}) } } : {}),
  };
}
