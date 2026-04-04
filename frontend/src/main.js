/**
 * main.js — UI logic for RPS Arena frontend
 */
import * as contract from './contract.js';
import * as storage from './storage.js';
import './style.css';

// ============================================================
// Constants
// ============================================================

const MOVE_EMOJIS = ['🪨', '📄', '✂️'];
const MOVE_NAMES = ['Rock', 'Paper', 'Scissors'];

// What each move beats: rock(0)->scissors(2), paper(1)->rock(0), scissors(2)->paper(1)
const BEATS = { 0: 2, 1: 0, 2: 1 };
const LOSES_TO = { 0: 1, 1: 2, 2: 0 };

// ============================================================
// DOM Helpers
// ============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function shortAddr(addr) {
  if (!addr) return '—';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// ============================================================
// State
// ============================================================

let activeRoom = null;
let roomPollTimer = null;
let cachedPlayerStats = null;

// ============================================================
// Toast Notifications
// ============================================================

function showToast(message, type = 'info') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// ============================================================
// Loading Overlay
// ============================================================

function showLoading(text = 'Processing...') {
  $('#loading-text').textContent = text;
  show($('#loading-overlay'));
}

function hideLoading() {
  hide($('#loading-overlay'));
}

// ============================================================
// Tab Navigation
// ============================================================

function setupTabs() {
  $$('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;

      $$('.nav-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      $$('.tab-content').forEach((s) => s.classList.remove('active'));
      $(`#${target}`).classList.add('active');

      if (target === 'stats') loadAllStats();
      if (target === 'rooms' && activeRoom) refreshRoomView();
    });
  });
}

// ============================================================
// Network Selector
// ============================================================

function setupNetworkSelect() {
  $('#network-select').addEventListener('change', async (e) => {
    const network = e.target.value;
    try {
      showLoading('Switching network...');
      await contract.switchNetwork(network);
      storage.saveNetwork(network);
      updateContractInfo();
      loadAllStats();
      showToast(`Switched to ${network}`, 'info');
    } catch (err) {
      showToast(`Network switch failed: ${err.message}`, 'error');
    } finally {
      hideLoading();
    }
  });
}

// ============================================================
// Wallet Connection
// ============================================================

function setupWallet() {
  $('#connect-btn').addEventListener('click', onConnect);
  $('#disconnect-btn').addEventListener('click', onDisconnect);

  // Listen for wallet events
  contract.onAccountsChanged((addr) => {
    if (addr) {
      updateWalletUI(addr);
      showToast('Account changed', 'info');
    } else {
      onDisconnect();
    }
  });

  contract.onChainChanged(() => {
    showToast('Chain changed in wallet — please verify network', 'warning');
  });
}

async function onConnect() {
  try {
    showLoading('Connecting wallet...');
    const network = $('#network-select').value;
    const addr = await contract.connectWallet(network);
    storage.saveWallet(addr);
    storage.saveNetwork(network);
    updateWalletUI(addr);
    showToast('Wallet connected!', 'success');
    loadAllStats();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    hideLoading();
  }
}

function onDisconnect() {
  contract.disconnectWallet();
  storage.clearWallet();
  hide($('#wallet-info'));
  show($('#connect-btn'));
  cachedPlayerStats = null;
  updatePlayerStatsUI(null);
  showToast('Wallet disconnected', 'info');
}

function updateWalletUI(addr) {
  hide($('#connect-btn'));
  show($('#wallet-info'));
  $('#wallet-address').textContent = shortAddr(addr);
}

// ============================================================
// Solo Play
// ============================================================

function setupSoloPlay() {
  $$('.move-card').forEach((btn) => {
    btn.addEventListener('click', () => onPlaySolo(parseInt(btn.dataset.move)));
  });
}

async function onPlaySolo(move) {
  if (!contract.isWalletConnected()) {
    showToast('Connect your wallet to play', 'warning');
    return;
  }

  // Disable buttons
  $$('.move-card').forEach((b) => (b.disabled = true));

  // Show battle arena
  const arena = $('#battle-arena');
  const result = $('#solo-result');
  hide(result);
  show(arena);

  // Set player move
  $('#player-move-display').textContent = MOVE_EMOJIS[move];
  $('#player-move-display').className = 'arena__hand';

  // AI is thinking
  const aiDisplay = $('#ai-move-display');
  aiDisplay.textContent = '❓';
  aiDisplay.className = 'arena__hand arena__hand--thinking';
  $('#battle-status').textContent = 'VS';

  showLoading('Waiting for validator consensus...');

  // Use cached stats as the "before" snapshot (avoids a blocking pre-play RPC read)
  const statsBefore = cachedPlayerStats || { wins: 0, losses: 0, draws: 0, solo_wins: 0, solo_losses: 0 };

  try {
    // Execute the play — this is the only critical call
    await contract.playSolo(move);
    hideLoading();

    // Fetch updated stats (non-critical — if this fails, show generic success)
    let statsAfter = null;
    try {
      statsAfter = await contract.getPlayerStats(contract.getWalletAddress());
      cachedPlayerStats = statsAfter;
      storage.saveCachedStats(contract.getWalletAddress(), statsAfter);
    } catch (statsErr) {
      console.warn('Could not fetch post-play stats:', statsErr);
    }

    // Determine outcome by comparing stats
    let outcome, aiMove;
    if (statsAfter) {
      if (statsAfter.solo_wins > statsBefore.solo_wins) {
        outcome = 'win';
        aiMove = BEATS[move];
      } else if (statsAfter.solo_losses > statsBefore.solo_losses) {
        outcome = 'lose';
        aiMove = LOSES_TO[move];
      } else {
        outcome = 'draw';
        aiMove = move;
      }
    } else {
      outcome = 'unknown';
    }

    // Reveal AI move
    aiDisplay.className = 'arena__hand';
    if (outcome !== 'unknown') {
      aiDisplay.textContent = MOVE_EMOJIS[aiMove];
    } else {
      aiDisplay.textContent = '❓';
    }

    // Highlight winner
    if (outcome === 'win') {
      $('#player-move-display').classList.add('arena__hand--win');
      aiDisplay.classList.add('arena__hand--lose');
    } else if (outcome === 'lose') {
      $('#player-move-display').classList.add('arena__hand--lose');
      aiDisplay.classList.add('arena__hand--win');
    } else if (outcome === 'draw') {
      $('#player-move-display').classList.add('arena__hand--draw');
      aiDisplay.classList.add('arena__hand--draw');
    }

    // Show result banner
    show(result);
    if (outcome === 'win') {
      result.className = 'result-banner win';
      result.textContent = `🎉 You WIN! ${MOVE_NAMES[move]} beats ${MOVE_NAMES[aiMove]}`;
    } else if (outcome === 'lose') {
      result.className = 'result-banner lose';
      result.textContent = `😞 You LOSE! ${MOVE_NAMES[aiMove]} beats ${MOVE_NAMES[move]}`;
    } else if (outcome === 'draw') {
      result.className = 'result-banner draw';
      result.textContent = `🤝 DRAW! Both chose ${MOVE_NAMES[move]}`;
    } else {
      result.className = 'result-banner';
      result.textContent = '✅ Move submitted! Refresh to see result.';
    }

    // Update quick stats
    if (statsAfter) {
      updateQuickStats(statsAfter);
    }

    // Save to local history
    if (outcome !== 'unknown') {
      storage.addGameRecord({
        type: 'solo',
        playerMove: move,
        aiMove,
        outcome,
        network: contract.getCurrentNetwork(),
      });
    }
  } catch (err) {
    hideLoading();
    console.error('playSolo transaction failed:', err);
    showToast(`Play failed: ${err.message}`, 'error');
    hide(arena);
  } finally {
    $$('.move-card').forEach((b) => (b.disabled = false));
  }
}

function updateQuickStats(stats) {
  if (!stats) return;
  $('#qs-wins').textContent = stats.wins;
  $('#qs-losses').textContent = stats.losses;
  $('#qs-draws').textContent = stats.draws;
}

// ============================================================
// Room Management
// ============================================================

function setupRooms() {
  $('#create-room-btn').addEventListener('click', onCreateRoom);
  $('#join-room-btn').addEventListener('click', onJoinRoom);
  $('#view-room-btn').addEventListener('click', onViewRoom);
  $('#close-room-btn').addEventListener('click', closeRoomView);
}

async function onCreateRoom() {
  if (!contract.isWalletConnected()) {
    showToast('Connect your wallet first', 'warning');
    return;
  }

  const code = $('#create-code').value.trim().toUpperCase();
  const maxPlayers = parseInt($('#create-max').value);
  const rounds = parseInt($('#create-rounds').value);

  if (code.length < 3 || code.length > 10) {
    showToast('Room code must be 3-10 characters', 'warning');
    return;
  }

  try {
    showLoading('Creating room... waiting for consensus');
    await contract.createRoom(code, maxPlayers, rounds);
    hideLoading();
    showToast(`Room "${code}" created!`, 'success');
    activeRoom = code;
    storage.saveRoom(code);
    await refreshRoomView();
    show($('#room-panel'));
  } catch (err) {
    hideLoading();
    showToast(`Create room failed: ${err.message}`, 'error');
  }
}

async function onJoinRoom() {
  if (!contract.isWalletConnected()) {
    showToast('Connect your wallet first', 'warning');
    return;
  }

  const code = $('#join-code').value.trim().toUpperCase();
  if (!code) {
    showToast('Enter a room code', 'warning');
    return;
  }

  try {
    showLoading('Joining room... waiting for consensus');
    await contract.joinRoom(code);
    hideLoading();
    showToast(`Joined room "${code}"!`, 'success');
    activeRoom = code;
    storage.saveRoom(code);
    await refreshRoomView();
    show($('#room-panel'));
  } catch (err) {
    hideLoading();
    showToast(`Join room failed: ${err.message}`, 'error');
  }
}

async function onViewRoom() {
  const code = $('#view-code').value.trim().toUpperCase();
  if (!code) {
    showToast('Enter a room code', 'warning');
    return;
  }

  try {
    activeRoom = code;
    storage.saveRoom(code);
    await refreshRoomView();
    show($('#room-panel'));
  } catch (err) {
    showToast(`Room not found: ${err.message}`, 'error');
    activeRoom = null;
  }
}

function closeRoomView() {
  hide($('#room-panel'));
  activeRoom = null;
  storage.saveRoom(null);
  stopRoomPoll();
}

async function refreshRoomView() {
  if (!activeRoom) return;

  try {
    const [info, scores] = await Promise.all([
      contract.getRoomInfo(activeRoom),
      contract.getRoomScores(activeRoom),
    ]);

    renderRoomView(info, scores);
  } catch (err) {
    showToast(`Error loading room: ${err.message}`, 'error');
  }
}

function renderRoomView(info, scores) {
  // Header
  $('#room-code-display').textContent = info.code;

  // State badge
  const stateBadge = $('#room-state-badge');
  stateBadge.textContent = info.state;
  stateBadge.className = `status-badge ${info.state}`;

  // Round info
  const roundBadge = $('#room-round-badge');
  if (info.state === 'playing') {
    roundBadge.textContent = `Round ${info.current_round}/${info.total_rounds}`;
  } else if (info.state === 'finished') {
    roundBadge.textContent = `${info.total_rounds} rounds`;
  } else {
    roundBadge.textContent = `${info.total_rounds} rounds planned`;
  }

  // Meta chips
  $('#room-host').textContent = shortAddr(info.host);
  $('#room-players-count').innerHTML = `<span>${info.player_count} / ${info.max_players} players</span>`;

  // Scores leaderboard
  const tbody = $('#scores-body');
  tbody.innerHTML = '';
  scores.forEach((p) => {
    const row = document.createElement('div');
    const isHost = p.address.toLowerCase() === info.host.toLowerCase();
    const isMe = contract.getWalletAddress() &&
      p.address.toLowerCase() === contract.getWalletAddress().toLowerCase();

    row.className = `leaderboard__row${p.eliminated ? ' leaderboard__row--eliminated' : ''}`;
    row.innerHTML = `
      <div class="leaderboard__addr">
        ${shortAddr(p.address)}
        ${isHost ? '<span class="leaderboard__tag leaderboard__tag--host">HOST</span>' : ''}
        ${isMe ? '<span class="leaderboard__tag leaderboard__tag--you">YOU</span>' : ''}
      </div>
      <div class="leaderboard__score">${p.score}</div>
      <div class="leaderboard__status">${p.eliminated ? '❌' : '✅'}</div>
    `;
    tbody.appendChild(row);
  });

  // Action area
  renderRoomActions(info, scores);

  // Start polling if game is in progress
  if (info.state === 'playing') {
    startRoomPoll();
  } else {
    stopRoomPoll();
  }
}

function renderRoomActions(info, scores) {
  const area = $('#room-action-area');
  area.innerHTML = '';

  const wallet = contract.getWalletAddress();
  if (!wallet) {
    area.innerHTML = '<p class="room-msg">Connect wallet to interact with this room</p>';
    return;
  }

  const isHost = wallet.toLowerCase() === info.host.toLowerCase();
  const isPlayer = scores.some((p) => p.address.toLowerCase() === wallet.toLowerCase());

  if (info.state === 'waiting') {
    if (isHost) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-success btn-full';
      btn.textContent = `Start Game (${info.player_count} players)`;
      btn.addEventListener('click', onStartRoom);
      if (info.player_count < 2) {
        btn.disabled = true;
        btn.textContent = 'Need at least 2 players to start';
      }
      area.appendChild(btn);
    } else if (!isPlayer) {
      const p = document.createElement('p');
      p.className = 'room-msg';
      p.textContent = 'Waiting for more players to join...';
      area.appendChild(p);
    } else {
      const p = document.createElement('p');
      p.className = 'room-msg';
      p.textContent = 'Waiting for host to start the game...';
      area.appendChild(p);
    }
  } else if (info.state === 'playing') {
    if (isPlayer) {
      // Move submission area
      const label = document.createElement('p');
      label.textContent = `Round ${info.current_round} — Choose your move:`;
      label.style.textAlign = 'center';
      label.style.marginBottom = '8px';
      area.appendChild(label);

      const btnWrap = document.createElement('div');
      btnWrap.className = 'room-move-buttons';
      [0, 1, 2].forEach((m) => {
        const btn = document.createElement('button');
        btn.className = 'room-move-btn';
        btn.textContent = `${MOVE_EMOJIS[m]} ${MOVE_NAMES[m]}`;
        btn.addEventListener('click', () => onSubmitRoomMove(m));
        btnWrap.appendChild(btn);
      });
      area.appendChild(btnWrap);
    }

    if (isHost) {
      const resolveBtn = document.createElement('button');
      resolveBtn.className = 'btn btn-primary btn-full';
      resolveBtn.textContent = 'Resolve Round';
      resolveBtn.style.marginTop = '8px';
      resolveBtn.addEventListener('click', onResolveRound);
      area.appendChild(resolveBtn);
    }
  } else if (info.state === 'finished') {
    const banner = document.createElement('div');
    banner.className = 'winner-banner';
    banner.textContent = `🏆 Winner: ${shortAddr(info.winner)}`;
    area.appendChild(banner);
  }

  // Refresh button
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn btn-ghost btn-full';
  refreshBtn.textContent = '🔄 Refresh Room';
  refreshBtn.style.marginTop = '8px';
  refreshBtn.addEventListener('click', refreshRoomView);
  area.appendChild(refreshBtn);
}

async function onStartRoom() {
  try {
    showLoading('Starting game... waiting for consensus');
    await contract.startRoom(activeRoom);
    hideLoading();
    showToast('Game started!', 'success');
    await refreshRoomView();
  } catch (err) {
    hideLoading();
    showToast(`Start failed: ${err.message}`, 'error');
  }
}

async function onSubmitRoomMove(move) {
  try {
    showLoading('Submitting move... waiting for consensus');
    await contract.submitMove(activeRoom, move);
    hideLoading();
    showToast(`Move submitted: ${MOVE_NAMES[move]}`, 'success');
    await refreshRoomView();
  } catch (err) {
    hideLoading();
    showToast(`Submit move failed: ${err.message}`, 'error');
  }
}

async function onResolveRound() {
  try {
    showLoading('Resolving round... waiting for consensus');
    await contract.resolveRound(activeRoom);
    hideLoading();
    showToast('Round resolved!', 'success');
    await refreshRoomView();
  } catch (err) {
    hideLoading();
    showToast(`Resolve failed: ${err.message}`, 'error');
  }
}

function startRoomPoll() {
  stopRoomPoll();
  roomPollTimer = setInterval(refreshRoomView, 10000);
}

function stopRoomPoll() {
  if (roomPollTimer) {
    clearInterval(roomPollTimer);
    roomPollTimer = null;
  }
}

// ============================================================
// Stats
// ============================================================

async function loadAllStats() {
  loadGameStats();
  if (contract.isWalletConnected()) {
    loadPlayerStats();
  }
  updateContractInfo();
}

async function loadGameStats() {
  try {
    const stats = await contract.getGameStats();
    $('#stat-total-games').textContent = stats.total_games;
    $('#stat-total-rooms').textContent = stats.total_rooms;
  } catch (err) {
    // Silently fail — network might be down
  }
}

async function loadPlayerStats() {
  try {
    const stats = await contract.getPlayerStats(contract.getWalletAddress());
    cachedPlayerStats = stats;
    storage.saveCachedStats(contract.getWalletAddress(), stats);
    updatePlayerStatsUI(stats);
    updateQuickStats(stats);
  } catch (err) {
    // Show cached stats if available
    const cached = storage.getCachedStats(contract.getWalletAddress());
    if (cached) {
      cachedPlayerStats = cached;
      updatePlayerStatsUI(cached);
      updateQuickStats(cached);
    }
  }
}

function updatePlayerStatsUI(stats) {
  const el = $('#player-stats-content');
  if (!stats) {
    el.innerHTML = `<div class="stat-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z"/></svg>
      <p>Connect wallet to view your stats</p>
    </div>`;
    return;
  }

  const total = stats.wins + stats.losses + stats.draws;
  const winPct = total > 0 ? Math.round((stats.wins / total) * 100) : 0;
  const lossPct = total > 0 ? Math.round((stats.losses / total) * 100) : 0;

  el.innerHTML = `
    <div class="stat-hero-grid">
      <div class="stat-hero stat-hero--win">
        <span class="stat-hero__num">${stats.wins}</span>
        <span class="stat-hero__label">Wins</span>
      </div>
      <div class="stat-hero stat-hero--loss">
        <span class="stat-hero__num">${stats.losses}</span>
        <span class="stat-hero__label">Losses</span>
      </div>
      <div class="stat-hero stat-hero--draw">
        <span class="stat-hero__num">${stats.draws}</span>
        <span class="stat-hero__label">Draws</span>
      </div>
    </div>
    <div class="stat-bar-wrap">
      <div class="stat-bar-label"><span>Win Rate</span><span>${computeWinRate(stats)}</span></div>
      <div class="stat-bar"><div class="stat-bar__fill stat-bar__fill--win" style="width:${winPct}%"></div></div>
    </div>
    <div class="stat-bar-wrap">
      <div class="stat-bar-label"><span>Loss Rate</span><span>${lossPct}%</span></div>
      <div class="stat-bar"><div class="stat-bar__fill stat-bar__fill--loss" style="width:${lossPct}%"></div></div>
    </div>
    <div class="stat-row">
      <div class="stat-row__left"><span>Solo Wins</span></div>
      <span class="stat-value">${stats.solo_wins}</span>
    </div>
    <div class="stat-row">
      <div class="stat-row__left"><span>Solo Losses</span></div>
      <span class="stat-value">${stats.solo_losses}</span>
    </div>
  `;
}

function computeWinRate(stats) {
  const total = stats.wins + stats.losses + stats.draws;
  if (total === 0) return '—';
  return Math.round((stats.wins / total) * 100) + '%';
}

function updateContractInfo() {
  $('#stat-network').textContent = contract.getCurrentNetwork();
  $('#stat-contract').textContent = contract.getContractAddress();
}

// ============================================================
// Initialization
// ============================================================

async function init() {
  // Restore saved preferences
  const savedNetwork = storage.getSavedNetwork();
  contract.initReadClient(savedNetwork);
  $('#network-select').value = savedNetwork;

  // Setup all UI handlers
  setupTabs();
  setupNetworkSelect();
  setupWallet();
  setupSoloPlay();
  setupRooms();

  // Load initial data
  updateContractInfo();
  loadGameStats();

  // Show cached stats instantly while chain loads
  const savedWallet = storage.getSavedWallet();
  if (savedWallet) {
    const cached = storage.getCachedStats(savedWallet);
    if (cached) {
      updatePlayerStatsUI(cached);
      updateQuickStats(cached);
    }
  }

  // Restore active room if any
  const savedRoom = storage.getSavedRoom();
  if (savedRoom) {
    activeRoom = savedRoom;
    try {
      await refreshRoomView();
      show($('#room-panel'));
      // Switch to rooms tab
      $$('.nav-tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-content').forEach((s) => s.classList.remove('active'));
      $('[data-tab="rooms"]').classList.add('active');
      $('#rooms').classList.add('active');
    } catch {
      activeRoom = null;
      storage.saveRoom(null);
    }
  }

  // Auto-reconnect if any wallet is already connected
  const provider = contract.getProvider();
  if (provider) {
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      if (accounts && accounts.length > 0) {
        await contract.connectWallet(savedNetwork);
        storage.saveWallet(accounts[0]);
        updateWalletUI(accounts[0]);
        loadPlayerStats();
      }
    } catch {
      // Not connected yet — that's fine
    }
  }
}

init();
