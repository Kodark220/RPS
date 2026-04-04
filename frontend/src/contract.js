/**
 * contract.js — GenLayer SDK wrapper for RPS Arena
 *
 * Handles client creation, wallet connection, and all contract calls.
 */
import { createClient } from 'genlayer-js';
import { studionet, testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';

// ============================================================
// Configuration
// ============================================================

const CHAINS = {
  studionet,
  'testnet-bradbury': testnetBradbury,
};

// Contract addresses per network (must be EIP-55 checksummed)
const CONTRACTS = {
  studionet: '0x13FBf85D01ab0AeD4aBFD902FA458Fb6f4Dce101',
  'testnet-bradbury': '0xbC5724AB9A1E7F7D994f874F8275800C32e6e2F7',
};

// Network names used by client.connect()
const CONNECT_NAMES = {
  studionet: 'studionet',
  'testnet-bradbury': 'testnetBradbury',
};

// ============================================================
// Wallet provider detection (supports multiple wallets)
// ============================================================

let activeProvider = null;

/**
 * Detect any available EIP-1193 wallet provider.
 * Supports MetaMask, OKX, Coinbase, Trust, Phantom, Rabby,
 * and any wallet injecting window.ethereum (including EIP-6963 multi-wallet).
 */
export function getProvider() {
  if (activeProvider) return activeProvider;
  if (typeof window === 'undefined') return null;

  // EIP-6963: some wallets expose multiple providers in an array
  if (window.ethereum?.providers?.length) {
    // Prefer non-MetaMask-like providers first (they tend to be the one the user installed)
    // but fall back to whatever is available
    return window.ethereum.providers[0];
  }

  return (
    window.ethereum ||
    window.okxwallet ||
    window.coinbaseWalletExtension ||
    window.phantom?.ethereum ||
    window.trustwallet ||
    window.rabby ||
    null
  );
}

/**
 * Wraps a wallet provider to strip fields that cause issues on ZKSync-based
 * chains (Bradbury). Wallets handle type, nonce, gasPrice, and chainId
 * better when they manage these themselves.
 */
function wrapProvider(rawProvider) {
  return {
    ...rawProvider,
    request: async ({ method, params }) => {
      if (method === 'eth_sendTransaction' && params && params[0]) {
        const tx = { ...params[0] };
        // Let the wallet determine these — avoids ZKSync/legacy conflicts
        delete tx.type;
        delete tx.nonce;
        delete tx.chainId;
        delete tx.gasPrice;
        return rawProvider.request({ method, params: [tx] });
      }
      return rawProvider.request({ method, params });
    },
    on: rawProvider.on?.bind(rawProvider),
    removeListener: rawProvider.removeListener?.bind(rawProvider),
  };
}

// ============================================================
// Chain switching helper (works with any EIP-1193 wallet)
// ============================================================

async function switchWalletChain(network) {
  const provider = getProvider();
  if (!provider) return;

  const chain = CHAINS[network];
  const chainIdHex = `0x${chain.id.toString(16)}`;

  const currentChainId = await provider.request({ method: 'eth_chainId' });
  if (currentChainId === chainIdHex) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (switchError) {
    // Chain not added yet — add it first
    if (switchError.code === 4902 || switchError.code === -32603) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: chainIdHex,
          chainName: chain.name,
          rpcUrls: chain.rpcUrls.default.http,
          nativeCurrency: chain.nativeCurrency,
          blockExplorerUrls: [chain.blockExplorers?.default?.url].filter(Boolean),
        }],
      });
    } else {
      throw switchError;
    }
  }
}

async function safeConnect(network) {
  try {
    // Try SDK connect (includes Snap installation)
    await writeClient.connect(CONNECT_NAMES[network]);
  } catch (err) {
    // If wallet_getSnaps or Snap install fails, fall back to manual chain switching
    console.warn('SDK connect failed, using manual chain switch:', err.message);
    await switchWalletChain(network);
  }
}

// ============================================================
// State
// ============================================================

let readClient = null;
let writeClient = null;
let currentNetwork = 'testnet-bradbury';
let walletAddress = null;

// ============================================================
// Getters
// ============================================================

export function getContractAddress() {
  return CONTRACTS[currentNetwork];
}

export function getCurrentNetwork() {
  return currentNetwork;
}

export function getWalletAddress() {
  return walletAddress;
}

export function isWalletConnected() {
  return walletAddress !== null && writeClient !== null;
}

// ============================================================
// Client management
// ============================================================

/**
 * HTTP-only provider that always goes through the chain RPC URL.
 * Prevents the SDK from routing gen_call through window.ethereum,
 * which wallets don't understand.
 */
function makeHttpProvider(chain) {
  const rpcUrl = chain.rpcUrls.default.http[0];
  return {
    request: async ({ method, params }) => {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const json = await res.json();
      if (json.error) throw json.error;
      return json.result;
    },
  };
}

export function initReadClient(network) {
  currentNetwork = network;
  readClient = createClient({
    chain: CHAINS[network],
    provider: makeHttpProvider(CHAINS[network]),
  });
}

export async function connectWallet(network) {
  const provider = getProvider();
  if (!provider) {
    throw new Error('No wallet detected. Please install MetaMask, Coinbase Wallet, or any EVM-compatible wallet.');
  }

  activeProvider = provider;
  currentNetwork = network || currentNetwork;

  // Request accounts
  const accounts = await provider.request({
    method: 'eth_requestAccounts',
  });

  if (!accounts || accounts.length === 0) {
    throw new Error('No accounts found. Please unlock your wallet.');
  }

  walletAddress = accounts[0];

  // Create write client with wrapped provider for ZKSync compatibility
  const wrapped = wrapProvider(provider);
  writeClient = createClient({
    chain: CHAINS[currentNetwork],
    account: walletAddress,
    provider: wrapped,
  });

  // Switch wallet to the correct network
  await safeConnect(currentNetwork);

  return walletAddress;
}

export function disconnectWallet() {
  writeClient = null;
  walletAddress = null;
  activeProvider = null;
}

export async function switchNetwork(network) {
  currentNetwork = network;

  // Recreate read client with HTTP-only provider
  readClient = createClient({
    chain: CHAINS[network],
    provider: makeHttpProvider(CHAINS[network]),
  });

  // Recreate write client if wallet is connected
  const provider = getProvider();
  if (walletAddress && provider) {
    const wrapped = wrapProvider(provider);
    writeClient = createClient({
      chain: CHAINS[network],
      account: walletAddress,
      provider: wrapped,
    });
    await safeConnect(network);
  }
}

// ============================================================
// Read methods (view)
// ============================================================

export async function getGameStats() {
  const result = await readClient.readContract({
    address: CONTRACTS[currentNetwork],
    functionName: 'get_game_stats',
    args: [],
  });
  return JSON.parse(result);
}

export async function getPlayerStats(address) {
  const result = await readClient.readContract({
    address: CONTRACTS[currentNetwork],
    functionName: 'get_player_stats',
    args: [address],
  });
  return JSON.parse(result);
}

export async function getRoomInfo(roomCode) {
  const result = await readClient.readContract({
    address: CONTRACTS[currentNetwork],
    functionName: 'get_room_info',
    args: [roomCode],
  });
  return JSON.parse(result);
}

export async function getRoomScores(roomCode) {
  const result = await readClient.readContract({
    address: CONTRACTS[currentNetwork],
    functionName: 'get_room_scores',
    args: [roomCode],
  });
  return JSON.parse(result);
}

// ============================================================
// Write methods (transactions)
// ============================================================

async function executeWrite(functionName, args) {
  if (!writeClient) {
    throw new Error('Wallet not connected. Please connect your wallet first.');
  }

  const txHash = await writeClient.writeContract({
    address: CONTRACTS[currentNetwork],
    functionName,
    args,
    value: BigInt(0),
  });

  // Wait for the transaction to be accepted by consensus
  const receipt = await readClient.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
  });

  return receipt;
}

export async function playSolo(move) {
  return executeWrite('play_solo', [move]);
}

export async function createRoom(roomCode, maxPlayers, totalRounds) {
  return executeWrite('create_room', [roomCode, maxPlayers, totalRounds]);
}

export async function joinRoom(roomCode) {
  return executeWrite('join_room', [roomCode]);
}

export async function startRoom(roomCode) {
  return executeWrite('start_room', [roomCode]);
}

export async function submitMove(roomCode, move) {
  return executeWrite('submit_move', [roomCode, move]);
}

export async function resolveRound(roomCode) {
  return executeWrite('resolve_round', [roomCode]);
}

// ============================================================
// Wallet event listeners (works with any EIP-1193 provider)
// ============================================================

export function onAccountsChanged(callback) {
  const provider = getProvider();
  if (provider && provider.on) {
    provider.on('accountsChanged', (accounts) => {
      if (accounts.length === 0) {
        disconnectWallet();
        callback(null);
      } else {
        walletAddress = accounts[0];
        if (writeClient) {
          const wrapped = wrapProvider(provider);
          writeClient = createClient({
            chain: CHAINS[currentNetwork],
            account: walletAddress,
            provider: wrapped,
          });
        }
        callback(walletAddress);
      }
    });
  }
}

export function onChainChanged(callback) {
  const provider = getProvider();
  if (provider && provider.on) {
    provider.on('chainChanged', () => {
      callback();
    });
  }
}
