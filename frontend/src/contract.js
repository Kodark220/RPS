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
// Update these after deploying the fixed contract on each network
const CONTRACTS = {
  studionet: '0x5A41a0DF2C8B0FbFEF512800DF12A90086c58C2e',
  'testnet-bradbury': '0xbf379a40eaa9a13eb7d637cbfc8e105b1018662a',
};

// Network names used by client.connect()
const CONNECT_NAMES = {
  studionet: 'studionet',
  'testnet-bradbury': 'testnetBradbury',
};

// ============================================================
// Wallet provider detection
// ============================================================

let activeProvider = null;

function getProvider() {
  if (activeProvider) return activeProvider;
  // Check for any EIP-1193 provider
  if (typeof window !== 'undefined' && window.ethereum) return window.ethereum;
  return null;
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
let currentNetwork = 'studionet';
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

  // Create write client with wallet provider
  writeClient = createClient({
    chain: CHAINS[currentNetwork],
    account: walletAddress,
    provider: provider,
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
    writeClient = createClient({
      chain: CHAINS[network],
      account: walletAddress,
      provider: provider,
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
