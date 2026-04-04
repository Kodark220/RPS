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

// Contract addresses per network
const CONTRACTS = {
  studionet: '0x13FBf85D01ab0AeD4aBFD902FA458Fb6f4Dce101',
  'testnet-bradbury': '0x9F80595e166d9B5a244084cEd255B42bcFbAA0A6',
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

function getProvider() {
  if (activeProvider) return activeProvider;
  if (typeof window === 'undefined') return null;
  // Check common provider injection points
  return window.ethereum || window.okxwallet || window.coinbaseWalletExtension || window.trustwallet || null;
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

export function initReadClient(network) {
  currentNetwork = network;
  readClient = createClient({
    chain: CHAINS[network],
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

  // Recreate read client
  readClient = createClient({
    chain: CHAINS[network],
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

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWrite(functionName, args) {
  if (!writeClient) {
    throw new Error('Wallet not connected. Please connect your wallet first.');
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
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
    } catch (err) {
      lastError = err;
      // Only retry on network/timeout errors, not user rejections
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('user rejected') || msg.includes('user denied') || msg.includes('invalid move')) {
        throw err;
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastError;
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
          writeClient = createClient({
            chain: CHAINS[currentNetwork],
            account: walletAddress,
            provider: provider,
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
