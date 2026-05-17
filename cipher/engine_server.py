"""
ChessMod – engine_server.py
Runs Fairy-Stockfish and exposes it over a local WebSocket.
The browser extension connects to ws://localhost:8765.

Install deps:  pip install websockets
"""

import asyncio
import websockets
import subprocess
import json
import os
import sys

# ── Config ────────────────────────────────────────────────────────────────────
STOCKFISH_PATH   = r'C:\Users\algorithm\Downloads\fairy-stockfish-largeboard_x86-64-modern.exe'
HOST             = 'localhost'
PORT             = 8765
DEFAULT_MOVETIME = 100   # ms – raise for stronger play

# ── Castling translation (Lichess Chess960 → standard UCI) ───────────────────
# Lichess sends king-to-rook square; Fairy-Stockfish expects king-to-dest square
CASTLE_MAP = {
    'e1h1': 'e1g1',   # white kingside
    'e1a1': 'e1c1',   # white queenside
    'e8h8': 'e8g8',   # black kingside
    'e8a8': 'e8c8',   # black queenside
}

def translate_moves(moves: list) -> list:
    """Convert any Lichess castling notation to standard UCI before sending to engine."""
    return [CASTLE_MAP.get(m, m) for m in moves]

# ── Startup file detection ────────────────────────────────────────────────────
print(f'[Engine] Checking for Stockfish at: {STOCKFISH_PATH}')
if not os.path.isfile(STOCKFISH_PATH):
    print(f'[Engine] ERROR: File not found — {STOCKFISH_PATH}')
    print(f'[Engine] Place fairy-stockfish-largeboard_x86-64-modern.exe at that path and retry.')
    sys.exit(1)
print(f'[Engine] ✓ Stockfish detected: {os.path.basename(STOCKFISH_PATH)}  ({os.path.getsize(STOCKFISH_PATH):,} bytes)')

# ── NNUE file detection ───────────────────────────────────────────────────────
NNUE_FILE = 'nn-46832cfbead3.nnue'
engine_dir = os.path.dirname(STOCKFISH_PATH)
nnue_path  = os.path.join(engine_dir, NNUE_FILE)
if not os.path.isfile(nnue_path):
    print(f'[Engine] WARNING: NNUE file not found at {nnue_path}')
    print(f'[Engine] Place {NNUE_FILE} in the same folder as the executable.')
    print(f'[Engine] Download from: https://tests.stockfishchess.org/api/nn/{NNUE_FILE}')
else:
    print(f'[Engine] ✓ NNUE file detected: {NNUE_FILE}')


# ══════════════════════════════════════════════════════════════════════════════
# Stockfish wrapper
# ══════════════════════════════════════════════════════════════════════════════

class Engine:
    def __init__(self):
        self.variant  = 'standard'
        self.nnue     = NNUE_FILE
        self.proc     = None
        self._start()

    def _start(self):
        """Launch the Stockfish process."""
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        self.proc = subprocess.Popen(
            [STOCKFISH_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            creationflags=flags,
            cwd=os.path.dirname(STOCKFISH_PATH),  # run from engine dir so NNUE is found
        )
        self._configure()

    def is_alive(self):
        return self.proc is not None and self.proc.poll() is None

    def restart(self):
        """Kill and relaunch the engine."""
        print('[Engine] Restarting...')
        try:
            if self.proc:
                self.proc.kill()
                self.proc.wait(timeout=3)
        except Exception:
            pass
        self._start()

    # ── UCI helpers ───────────────────────────────────────────────────────────
    def _send(self, cmd: str):
        if not self.is_alive():
            err = self.proc.stderr.read() if self.proc else ''
            raise RuntimeError(f'Engine process is dead. stderr: {err.strip() or "(empty)"}')
        self.proc.stdin.write(cmd + '\n')
        self.proc.stdin.flush()

    def _read(self) -> str:
        if not self.is_alive():
            err = self.proc.stderr.read() if self.proc else ''
            raise RuntimeError(f'Engine process is dead. stderr: {err.strip() or "(empty)"}')
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read() if self.proc else ''
            raise RuntimeError(f'Engine stdout closed unexpectedly. stderr: {err.strip() or "(empty)"}')
        return line.strip()

    def _await_token(self, token: str):
        while True:
            line = self._read()
            if line == token:
                return

    # ── Setup ─────────────────────────────────────────────────────────────────
    def _configure(self):
        self._send('uci')
        self._await_token('uciok')
        self._apply_options()
        self._send('isready')
        self._await_token('readyok')
        print(f'[Engine] ready  variant={self.variant}')

    def _apply_options(self):
        self._send('setoption name Use NNUE value true')
        self._send(f'setoption name EvalFile value {self.nnue}')
        self._send(f'setoption name UCI_Variant value {self.variant}')
        self._send('setoption name Threads value 2')

    def reconfigure(self, variant: str, nnue: str):
        if variant == self.variant and nnue == self.nnue:
            return
        self.variant = variant
        self.nnue    = nnue
        self._apply_options()
        self._send('isready')
        self._await_token('readyok')
        print(f'[Engine] reconfigured → {variant}')

    # ── Analysis ──────────────────────────────────────────────────────────────
    def best_move(self, moves: list, movetime: int = DEFAULT_MOVETIME):
        """Return (from_sq, to_sq) for the best move given the move history."""
        if not self.is_alive():
            print('[Engine] Process was dead — restarting before analysis.')
            self.restart()

        translated = translate_moves(moves)

        # Log any castling translations for debugging
        for orig, conv in zip(moves, translated):
            if orig != conv:
                print(f'[Castling] {orig} → {conv}')

        moves_str = ' '.join(translated) if translated else ''
        self._send(f'position startpos moves {moves_str}')
        self._send(f'go movetime {movetime}')

        while True:
            line = self._read()
            if line.startswith('bestmove'):
                parts = line.split()
                move  = parts[1] if len(parts) > 1 else '0000'
                return move[:2], move[2:4]   # (from, to)

    def close(self):
        try:
            if self.is_alive():
                self._send('quit')
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# WebSocket server
# ══════════════════════════════════════════════════════════════════════════════

engine = Engine()


async def handler(websocket):
    client = websocket.remote_address
    print(f'[Server] client connected  {client}')

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            kind = msg.get('type')

            # ── Configure variant ─────────────────────────────────────────
            if kind == 'configure':
                engine.reconfigure(
                    msg.get('variant', engine.variant),
                    msg.get('nnue',    engine.nnue),
                )

            # ── Analyse position ──────────────────────────────────────────
            elif kind == 'analyze':
                variant  = msg.get('variant', engine.variant)
                nnue     = msg.get('nnue',    engine.nnue)
                engine.reconfigure(variant, nnue)

                moves    = msg.get('moves', [])
                movetime = msg.get('movetime', DEFAULT_MOVETIME)

                try:
                    loop = asyncio.get_running_loop()
                    frm, to = await loop.run_in_executor(
                        None, engine.best_move, moves, movetime
                    )
                    await websocket.send(json.dumps({
                        'type': 'bestmove',
                        'from': frm,
                        'to':   to,
                        'move': frm + to,
                    }))
                except RuntimeError as e:
                    print(f'[Engine] ERROR during analysis: {e}')
                    await websocket.send(json.dumps({'type': 'error', 'message': str(e)}))

    except websockets.ConnectionClosedOK:
        pass
    except websockets.ConnectionClosedError:
        pass
    finally:
        print(f'[Server] client disconnected  {client}')


async def main():
    print(f'[Server] listening on ws://{HOST}:{PORT}')
    async with websockets.serve(handler, HOST, PORT):
        await asyncio.Future()   # run forever


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        engine.close()
        print('[Server] stopped')
