# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
from dataclasses import dataclass
import json
import os
import hashlib


# ============================================================
# Helper: Seeded random for deterministic consensus
# ============================================================

def _get_random_seed() -> bytes:
    f = os.fdopen(0, 'rb', buffering=0, closefd=False)
    f.seek(0)
    hash_obj = hashlib.sha256()
    while True:
        chunk = f.read(8192)
        if not chunk:
            return hash_obj.digest()
        hash_obj.update(chunk)


def _seeded_choice(seed: bytes, choices: u32) -> u32:
    val = u32(seed[0]) * u32(256) + u32(seed[1])
    return val % choices


# ============================================================
# Constants
# ============================================================

ROCK = u32(0)
PAPER = u32(1)
SCISSORS = u32(2)
MOVE_NAMES = ["rock", "paper", "scissors"]

# Room states
ROOM_WAITING = u32(0)
ROOM_PLAYING = u32(1)
ROOM_FINISHED = u32(2)

MAX_PLAYERS = u32(20)


# ============================================================
# Storage Dataclasses
# ============================================================

@allow_storage
@dataclass
class PlayerStats:
    wins: u32
    losses: u32
    draws: u32
    solo_wins: u32
    solo_losses: u32


@allow_storage
@dataclass
class RoomPlayer:
    address: Address
    move: u32        # 0=rock, 1=paper, 2=scissors, 99=not submitted
    score: u32
    eliminated: bool


@allow_storage
@dataclass
class Room:
    code: str
    host: Address
    state: u32           # 0=waiting, 1=playing, 2=finished
    max_players: u32
    current_round: u32
    total_rounds: u32
    player_count: u32
    winner: Address


# ============================================================
# RPS Arena Contract
# ============================================================

class RPSArena(gl.Contract):

    # Global stats per player address
    stats: TreeMap[Address, PlayerStats]

    # Room data: room_code -> Room
    rooms: TreeMap[str, Room]

    # Room players: "room_code:index" -> RoomPlayer
    room_players: TreeMap[str, RoomPlayer]

    # Total games played
    total_games: u32

    # Total rooms created
    total_rooms: u32

    def __init__(self):
        pass

    # ========================================================
    # SOLO MODE: Play against AI
    # ========================================================

    @gl.public.write
    def play_solo(self, move: u32) -> str:
        if move > u32(2):
            raise gl.vm.UserError("Invalid move. Use 0=rock, 1=paper, 2=scissors")

        # Generate AI move using seeded random
        seed = _get_random_seed()
        ai_move = _seeded_choice(seed, u32(3))

        player = gl.message.sender_address

        # Get or create stats
        default = PlayerStats(u32(0), u32(0), u32(0), u32(0), u32(0))
        player_stats = self.stats.get(player, default)

        self.total_games = self.total_games + u32(1)

        # Determine winner
        if move == ai_move:
            player_stats.draws = player_stats.draws + u32(1)
            self.stats[player] = player_stats
            return f"Draw! Both chose {MOVE_NAMES[move]}"
        elif (move == ROCK and ai_move == SCISSORS) or \
             (move == PAPER and ai_move == ROCK) or \
             (move == SCISSORS and ai_move == PAPER):
            player_stats.wins = player_stats.wins + u32(1)
            player_stats.solo_wins = player_stats.solo_wins + u32(1)
            self.stats[player] = player_stats
            return f"You win! You: {MOVE_NAMES[move]} vs AI: {MOVE_NAMES[ai_move]}"
        else:
            player_stats.losses = player_stats.losses + u32(1)
            player_stats.solo_losses = player_stats.solo_losses + u32(1)
            self.stats[player] = player_stats
            return f"You lose! You: {MOVE_NAMES[move]} vs AI: {MOVE_NAMES[ai_move]}"

    # ========================================================
    # ROOM MODE: Create, join, and play in rooms
    # ========================================================

    @gl.public.write
    def create_room(self, room_code: str, max_players: u32, total_rounds: u32) -> str:
        if max_players < u32(2) or max_players > MAX_PLAYERS:
            raise gl.vm.UserError("Max players must be between 2 and 20")
        if total_rounds < u32(1) or total_rounds > u32(10):
            raise gl.vm.UserError("Total rounds must be between 1 and 10")
        if len(room_code) < 3 or len(room_code) > 10:
            raise gl.vm.UserError("Room code must be 3-10 characters")

        # Check room doesn't exist or is finished
        default_room = Room("", Address(bytes(20)), ROOM_FINISHED, u32(0), u32(0), u32(0), u32(0), Address(bytes(20)))
        existing = self.rooms.get(room_code, default_room)
        if existing.state != ROOM_FINISHED and existing.code != "":
            raise gl.vm.UserError("Room code already in use")

        host = gl.message.sender_address

        # Create room
        room = Room(
            room_code,
            host,
            ROOM_WAITING,
            max_players,
            u32(0),
            total_rounds,
            u32(1),
            Address(bytes(20))
        )
        self.rooms[room_code] = room

        # Add host as first player
        player_key = f"{room_code}:0"
        self.room_players[player_key] = RoomPlayer(
            host,
            u32(99),  # no move yet
            u32(0),
            False
        )

        self.total_rooms = self.total_rooms + u32(1)
        return f"Room '{room_code}' created! Share this code with friends. ({max_players} max players, {total_rounds} rounds)"

    @gl.public.write
    def join_room(self, room_code: str) -> str:
        default_room = Room("", Address(bytes(20)), ROOM_FINISHED, u32(0), u32(0), u32(0), u32(0), Address(bytes(20)))
        room = self.rooms.get(room_code, default_room)

        if room.code == "":
            raise gl.vm.UserError("Room not found")
        if room.state != ROOM_WAITING:
            raise gl.vm.UserError("Room is not accepting players")
        if room.player_count >= room.max_players:
            raise gl.vm.UserError("Room is full")

        player = gl.message.sender_address

        # Check if already in room
        i = u32(0)
        while i < room.player_count:
            key = f"{room_code}:{i}"
            rp = self.room_players[key]
            if rp.address == player:
                raise gl.vm.UserError("You are already in this room")
            i = i + u32(1)

        # Add player
        idx = room.player_count
        player_key = f"{room_code}:{idx}"
        self.room_players[player_key] = RoomPlayer(
            player,
            u32(99),
            u32(0),
            False
        )
        room.player_count = idx + u32(1)
        self.rooms[room_code] = room

        return f"Joined room '{room_code}'! ({room.player_count}/{room.max_players} players)"

    @gl.public.write
    def start_room(self, room_code: str) -> str:
        default_room = Room("", Address(bytes(20)), ROOM_FINISHED, u32(0), u32(0), u32(0), u32(0), Address(bytes(20)))
        room = self.rooms.get(room_code, default_room)

        if room.code == "":
            raise gl.vm.UserError("Room not found")
        if room.host != gl.message.sender_address:
            raise gl.vm.UserError("Only the host can start the game")
        if room.state != ROOM_WAITING:
            raise gl.vm.UserError("Room already started or finished")
        if room.player_count < u32(2):
            raise gl.vm.UserError("Need at least 2 players to start")

        room.state = ROOM_PLAYING
        room.current_round = u32(1)
        self.rooms[room_code] = room

        return f"Game started in room '{room_code}'! Round 1 of {room.total_rounds}. All players submit your moves!"

    @gl.public.write
    def submit_move(self, room_code: str, move: u32) -> str:
        if move > u32(2):
            raise gl.vm.UserError("Invalid move. Use 0=rock, 1=paper, 2=scissors")

        default_room = Room("", Address(bytes(20)), ROOM_FINISHED, u32(0), u32(0), u32(0), u32(0), Address(bytes(20)))
        room = self.rooms.get(room_code, default_room)

        if room.code == "":
            raise gl.vm.UserError("Room not found")
        if room.state != ROOM_PLAYING:
            raise gl.vm.UserError("Game is not in progress")

        player = gl.message.sender_address

        # Find player index
        player_idx = u32(999)
        i = u32(0)
        while i < room.player_count:
            key = f"{room_code}:{i}"
            rp = self.room_players[key]
            if rp.address == player:
                player_idx = i
                break
            i = i + u32(1)

        if player_idx == u32(999):
            raise gl.vm.UserError("You are not in this room")

        player_key = f"{room_code}:{player_idx}"
        rp = self.room_players[player_key]

        if rp.eliminated:
            raise gl.vm.UserError("You have been eliminated")
        if rp.move != u32(99):
            raise gl.vm.UserError("You already submitted a move for this round")

        rp.move = move
        self.room_players[player_key] = rp

        return f"Move submitted for round {room.current_round}!"

    @gl.public.write
    def resolve_round(self, room_code: str) -> str:
        default_room = Room("", Address(bytes(20)), ROOM_FINISHED, u32(0), u32(0), u32(0), u32(0), Address(bytes(20)))
        room = self.rooms.get(room_code, default_room)

        if room.code == "":
            raise gl.vm.UserError("Room not found")
        if room.host != gl.message.sender_address:
            raise gl.vm.UserError("Only the host can resolve rounds")
        if room.state != ROOM_PLAYING:
            raise gl.vm.UserError("Game is not in progress")

        # Check all active players have submitted moves
        active_count = u32(0)
        i = u32(0)
        while i < room.player_count:
            key = f"{room_code}:{i}"
            rp = self.room_players[key]
            if not rp.eliminated:
                if rp.move == u32(99):
                    raise gl.vm.UserError("Not all players have submitted moves yet")
                active_count = active_count + u32(1)
            i = i + u32(1)

        # Count moves among active players
        rock_count = u32(0)
        paper_count = u32(0)
        scissors_count = u32(0)

        i = u32(0)
        while i < room.player_count:
            key = f"{room_code}:{i}"
            rp = self.room_players[key]
            if not rp.eliminated:
                if rp.move == ROCK:
                    rock_count = rock_count + u32(1)
                elif rp.move == PAPER:
                    paper_count = paper_count + u32(1)
                else:
                    scissors_count = scissors_count + u32(1)
            i = i + u32(1)

        # Determine winning move(s) - standard RPS logic
        # If all same or all three present = draw round
        all_same = (rock_count == active_count) or (paper_count == active_count) or (scissors_count == active_count)
        all_three = (rock_count > u32(0)) and (paper_count > u32(0)) and (scissors_count > u32(0))

        round_result = ""

        if all_same or all_three:
            round_result = f"Round {room.current_round}: Draw! No points awarded."
        else:
            # Determine winning move
            winning_move = u32(99)
            if rock_count > u32(0) and scissors_count > u32(0) and paper_count == u32(0):
                winning_move = ROCK
            elif paper_count > u32(0) and rock_count > u32(0) and scissors_count == u32(0):
                winning_move = PAPER
            elif scissors_count > u32(0) and paper_count > u32(0) and rock_count == u32(0):
                winning_move = SCISSORS

            # Award points to winners
            if winning_move != u32(99):
                i = u32(0)
                while i < room.player_count:
                    key = f"{room_code}:{i}"
                    rp = self.room_players[key]
                    if not rp.eliminated and rp.move == winning_move:
                        rp.score = rp.score + u32(1)
                        self.room_players[key] = rp
                    i = i + u32(1)

                round_result = f"Round {room.current_round}: {MOVE_NAMES[winning_move]} wins!"

        # Reset moves for next round
        i = u32(0)
        while i < room.player_count:
            key = f"{room_code}:{i}"
            rp = self.room_players[key]
            if not rp.eliminated:
                rp.move = u32(99)
                self.room_players[key] = rp
            i = i + u32(1)

        # Check if game is over
        if room.current_round >= room.total_rounds:
            room.state = ROOM_FINISHED

            # Find winner (highest score)
            best_score = u32(0)
            winner_addr = Address(bytes(20))
            i = u32(0)
            while i < room.player_count:
                key = f"{room_code}:{i}"
                rp = self.room_players[key]
                if rp.score > best_score:
                    best_score = rp.score
                    winner_addr = rp.address
                i = i + u32(1)

            room.winner = winner_addr
            self.rooms[room_code] = room

            # Update global stats for all players
            i = u32(0)
            while i < room.player_count:
                key = f"{room_code}:{i}"
                rp = self.room_players[key]
                default_stats = PlayerStats(u32(0), u32(0), u32(0), u32(0), u32(0))
                ps = self.stats.get(rp.address, default_stats)
                if rp.address == winner_addr:
                    ps.wins = ps.wins + u32(1)
                else:
                    ps.losses = ps.losses + u32(1)
                self.stats[rp.address] = ps
                i = i + u32(1)

            self.total_games = self.total_games + u32(1)
            return f"{round_result} Game over! Winner: {winner_addr.as_hex} with {best_score} points!"
        else:
            room.current_round = room.current_round + u32(1)
            self.rooms[room_code] = room
            return f"{round_result} Next: Round {room.current_round} of {room.total_rounds}."

    # ========================================================
    # VIEW METHODS: Read game state
    # ========================================================

    @gl.public.view
    def get_player_stats(self, player_address) -> str:
        # SDK may pass address as a hex string — convert to Address for TreeMap lookup
        if isinstance(player_address, str):
            player_address = Address(bytes.fromhex(player_address.replace('0x', '')))
        default = PlayerStats(u32(0), u32(0), u32(0), u32(0), u32(0))
        ps = self.stats.get(player_address, default)
        return json.dumps({
            "wins": int(ps.wins),
            "losses": int(ps.losses),
            "draws": int(ps.draws),
            "solo_wins": int(ps.solo_wins),
            "solo_losses": int(ps.solo_losses)
        })

    @gl.public.view
    def get_room_info(self, room_code: str) -> str:
        default_room = Room("", Address(bytes(20)), ROOM_FINISHED, u32(0), u32(0), u32(0), u32(0), Address(bytes(20)))
        room = self.rooms.get(room_code, default_room)
        if room.code == "":
            raise gl.vm.UserError("Room not found")

        info = {
            "code": room.code,
            "host": room.host.as_hex,
            "state": "waiting" if room.state == ROOM_WAITING else ("playing" if room.state == ROOM_PLAYING else "finished"),
            "player_count": int(room.player_count),
            "max_players": int(room.max_players),
            "current_round": int(room.current_round),
            "total_rounds": int(room.total_rounds)
        }
        if room.state == ROOM_FINISHED:
            info["winner"] = room.winner.as_hex
        return json.dumps(info)

    @gl.public.view
    def get_room_scores(self, room_code: str) -> str:
        default_room = Room("", Address(bytes(20)), ROOM_FINISHED, u32(0), u32(0), u32(0), u32(0), Address(bytes(20)))
        room = self.rooms.get(room_code, default_room)
        if room.code == "":
            raise gl.vm.UserError("Room not found")

        scores = []
        i = u32(0)
        while i < room.player_count:
            key = f"{room_code}:{i}"
            rp = self.room_players[key]
            scores.append({
                "address": rp.address.as_hex,
                "score": int(rp.score),
                "eliminated": bool(rp.eliminated),
                "has_moved": rp.move != u32(99)
            })
            i = i + u32(1)
        return json.dumps(scores)

    @gl.public.view
    def get_game_stats(self) -> str:
        return json.dumps({
            "total_games": int(self.total_games),
            "total_rooms": int(self.total_rooms)
        })
