# Rock Paper Scissors Arena

A multiplayer Rock Paper Scissors game built as a GenLayer Intelligent Contract, deployed on Bradbury testnet.

## Features

- **Solo Mode** — Play against an AI opponent (seeded random for deterministic consensus)
- **Room Mode** — Create rooms with join codes, invite up to 20 players
- **Multi-Round** — Rooms support 1-10 rounds with point-based scoring
- **Leaderboard** — Track wins, losses, draws per player address

## How It Works

### Solo Play
Call `play_solo(move)` with your move:
- `0` = Rock
- `1` = Paper
- `2` = Scissors

The AI generates a move using seeded randomness (consensus-safe). You get instant results.

### Room Play (Multiplayer)
1. **Create** — Host calls `create_room("MYCODE", 5, 3)` (code, max players, rounds)
2. **Join** — Friends call `join_room("MYCODE")` with the same code
3. **Start** — Host calls `start_room("MYCODE")` when ready
4. **Play** — All players call `submit_move("MYCODE", move)` each round
5. **Resolve** — Host calls `resolve_round("MYCODE")` after everyone submits
6. **Repeat** — Steps 4-5 repeat for each round. Winner has most points!

### Scoring
- In each round, if only 2 of the 3 moves are present, standard RPS logic applies
- Winners of a round get 1 point
- If all 3 moves are present or all are the same = draw, no points
- Player with most points after all rounds wins

## Contract Methods

### Write Methods (transactions)
| Method | Params | Description |
|--------|--------|-------------|
| `play_solo` | `move: u32` | Play one round vs AI |
| `create_room` | `room_code: str, max_players: u32, total_rounds: u32` | Create a new room |
| `join_room` | `room_code: str` | Join an existing room |
| `start_room` | `room_code: str` | Host starts the game |
| `submit_move` | `room_code: str, move: u32` | Submit your move for current round |
| `resolve_round` | `room_code: str` | Host resolves the current round |

### View Methods (read-only)
| Method | Params | Description |
|--------|--------|-------------|
| `get_player_stats` | `player_address: str` | Get a player's win/loss record |
| `get_room_info` | `room_code: str` | Get room status and details |
| `get_room_scores` | `room_code: str` | Get all player scores in a room |
| `get_game_stats` | — | Get total games and rooms count |

## Deploy to Bradbury

```bash
# Install GenLayer CLI
pip install genlayer

# Set network
genlayer network set bradbury

# Create or import account
genlayer account create

# Get testnet tokens
# Visit https://faucet.genlayer.com

# Deploy
genlayer contracts deploy rps_arena.py
```

## Tech Stack

- **GenLayer SDK** — `gl.Contract`, `TreeMap`, `DynArray`, `@allow_storage`
- **Seeded Random** — Deterministic AI via `stdin` + SHA256 hashing
- **Bradbury Testnet** — GenLayer's public test network

## GenLayer Skills Reference

Built using patterns from [GenLayer Skills](https://skills.genlayer.com/) and [GenLayer Docs](https://docs.genlayer.com/).
