/**
 * wave-resolver.js — Standalone WAVE name resolver for the Radiant blockchain.
 *
 * WAVE names (e.g. `satoshi.rxd`) are human-readable names backed by mutable
 * Glyph NFTs on Radiant. The name's owner can point it at any payment address,
 * so resolving a name is the recommended way to look up "where do I send RXD to
 * pay <name>?". Registration is first-registration-wins: the indexer always
 * returns the *canonical* (earliest) registration of a name.
 *
 * This module is dependency-free ESM and works in any environment with a global
 * `fetch` (modern browsers, Deno, and Node.js 18+). Copy it into your dapp.
 *
 * It talks to the public RXinDexer REST API, which already does the on-chain
 * work for you: it finds the WAVE singleton NFT, follows it to its current UTXO,
 * and reads the latest `target` address from the NFT's metadata.
 *
 * @example <caption>Resolve a name, then send RXD to it</caption>
 * import { resolveWaveName } from './wave-resolver.js';
 *
 * const hit = await resolveWaveName('satoshi.rxd');
 * if (!hit) {
 *   console.log('Name is not registered — nothing to pay.');
 * } else {
 *   console.log('Pay this address:', hit.address); // e.g. "1Rxd...address"
 *   // hit.ref   -> "txid_vout" of the canonical registration NFT
 *   // hit.owner -> 32-byte hex scripthash of the current holder
 *
 *   // With radiantjs (https://github.com/Radiant-Core/radiantjs):
 *   const tx = new radiant.Transaction()
 *     .from(utxos)
 *     .to(hit.address, 100_000_000) // photons (1 RXD = 1e8 photons)
 *     .change(myChangeAddress)
 *     .sign(myPrivateKey);
 *   await electrum.broadcast(tx.toString());
 * }
 *
 * @example <caption>Check availability before registering</caption>
 * import { isWaveAvailable } from './wave-resolver.js';
 * if (await isWaveAvailable('myhandle')) {
 *   // Free — register it in Photonic Wallet (https://photonic-wallet.com/)
 * }
 */

/** Default public RXinDexer REST base. Override via the `apiBase` argument. */
export const DEFAULT_API_BASE = 'https://radiantcore.org/api';

/**
 * Normalize a WAVE name to its canonical lookup form: trimmed, lower-cased, and
 * with an optional trailing `.rxd` domain stripped. So `"Satoshi.RXD"`, `" satoshi "`,
 * and `"satoshi"` all resolve identically.
 *
 * @param {string} name - The raw name, with or without a `.rxd` suffix.
 * @returns {string} The normalized bare name (no domain suffix).
 * @throws {TypeError} If `name` is not a string.
 */
export function normalizeWaveName(name) {
  if (typeof name !== 'string') throw new TypeError('WAVE name must be a string');
  let n = name.trim().toLowerCase();
  if (n.endsWith('.rxd')) n = n.slice(0, -4);
  return n;
}

/** Fetch JSON, throwing on transport / HTTP errors (e.g. 503 = index offline). */
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`WAVE API returned HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Resolve a WAVE name to its current payment address.
 *
 * Returns `null` when the name is simply unregistered. Network failures and
 * indexer errors (e.g. the WAVE index being offline) throw — that way a caller
 * can tell "this name has no owner" apart from "I couldn't reach the indexer".
 *
 * @param {string} name - WAVE name, e.g. `"satoshi"` or `"satoshi.rxd"`.
 * @param {string} [apiBase=DEFAULT_API_BASE] - RXinDexer REST base URL.
 * @returns {Promise<{address: string, ref: string|null, owner: string|null}|null>}
 *   The current `address` to pay, the canonical registration `ref` (`"txid_vout"`),
 *   and the holder's `owner` scripthash — or `null` if the name is unregistered.
 * @throws {Error} On network failure or a non-OK HTTP response.
 */
export async function resolveWaveName(name, apiBase = DEFAULT_API_BASE) {
  const bare = normalizeWaveName(name);
  if (!bare) return null;
  const base = apiBase.replace(/\/+$/, '');
  const data = await getJson(`${base}/wave/resolve/${encodeURIComponent(bare)}`);

  // Unregistered names come back as { available: true, resolved: false }.
  if (!data || data.available || data.resolved === false) return null;

  // `target` is the mutable payment address; fall back to the zone record.
  const address = data.target || (data.zone && data.zone.address) || null;
  if (!address) return null;

  return { address, ref: data.ref ?? null, owner: data.owner ?? null };
}

/**
 * Check whether a WAVE name is available to register (i.e. not yet claimed).
 *
 * @param {string} name - WAVE name, e.g. `"myhandle"` or `"myhandle.rxd"`.
 * @param {string} [apiBase=DEFAULT_API_BASE] - RXinDexer REST base URL.
 * @returns {Promise<boolean>} `true` if the name is free, `false` if taken.
 * @throws {Error} On network failure or a non-OK HTTP response.
 */
export async function isWaveAvailable(name, apiBase = DEFAULT_API_BASE) {
  const bare = normalizeWaveName(name);
  if (!bare) return false;
  const base = apiBase.replace(/\/+$/, '');
  const data = await getJson(`${base}/wave/available/${encodeURIComponent(bare)}`);
  return Boolean(data && data.available);
}

/**
 * Lazily iterate over every canonical (first-registration) WAVE name, following
 * the `/wave/names` cursor pagination automatically so the caller never has to
 * manage cursors. Yields one entry at a time; stops when the indexer reports no
 * more pages. Requires `URL` (available in modern browsers and Node.js 18+).
 *
 * @param {string} [apiBase=DEFAULT_API_BASE] - RXinDexer REST base URL.
 * @param {number} [pageSize=1000] - Names requested per page (server max 2000).
 * @yields {{name: string, domain: string, full_name: string, target: string,
 *   ref: string, height: number, spent: boolean, canonical: boolean}}
 * @returns {AsyncGenerator<object, void, void>}
 * @throws {Error} On network failure or a non-OK HTTP response.
 *
 * @example <caption>Build a name → address directory</caption>
 * import { listWaveNames } from './wave-resolver.js';
 * const directory = {};
 * for await (const n of listWaveNames()) directory[n.full_name] = n.target;
 */
export async function* listWaveNames(apiBase = DEFAULT_API_BASE, pageSize = 1000) {
  const base = apiBase.replace(/\/+$/, '');
  let cursor = null;
  do {
    const url = new URL(`${base}/wave/names`);
    url.searchParams.set('limit', String(pageSize));
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await getJson(url.toString());
    for (const entry of page.names || []) yield entry;
    cursor = page.next_cursor || null;
  } while (cursor);
}
