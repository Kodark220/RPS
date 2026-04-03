# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
# Deploy script for RPS Arena on Bradbury testnet
#
# Prerequisites:
#   1. Install GenLayer CLI: pip install genlayer
#   2. Set network to Bradbury: genlayer network set bradbury
#   3. Import or create an account: genlayer account create
#   4. Get testnet tokens from faucet: https://faucet.genlayer.com
#
# Deploy command:
#   genlayer contracts deploy rps_arena.py
#
# After deploying, note your contract address!
#
# Interact via CLI:
#   genlayer contracts call <CONTRACT_ADDRESS> get_game_stats
#   genlayer contracts write <CONTRACT_ADDRESS> play_solo 0
#   genlayer contracts write <CONTRACT_ADDRESS> create_room "ABC123" 5 3
#   genlayer contracts write <CONTRACT_ADDRESS> join_room "ABC123"
#   genlayer contracts write <CONTRACT_ADDRESS> start_room "ABC123"
#   genlayer contracts write <CONTRACT_ADDRESS> submit_move "ABC123" 1
#   genlayer contracts write <CONTRACT_ADDRESS> resolve_round "ABC123"
