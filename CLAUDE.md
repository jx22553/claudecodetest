# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A single-file, browser-based Tic-Tac-Toe game. The entire application — markup, CSS, and JavaScript — lives in `index.html`. There is no build system, package manager, dependency, test suite, or backend.

## Running

Open `index.html` directly in any web browser (double-click, or `start index.html` on Windows). No server or install step is required.

## Architecture

Everything is in `index.html`, organized in three inline sections: `<style>` (theming via CSS custom properties on `:root`), the DOM skeleton, and a `<script>` holding all game logic. Key structure of the script:

- **State** is module-level: `board` (9-element array of `'X' | 'O' | null`), `current` player, `gameOver`, `vsComputer`, and a `scores` object. There is no framework — the UI is a direct function of this state.
- **`renderBoard()`** rebuilds all nine cell buttons from `board` on every change (full re-render, not incremental DOM diffing). Any change to game state must be followed by a `renderBoard()` call to stay in sync.
- **`WIN_LINES`** (the 8 winning triplets) drives both win detection (`checkWinner`) and the computer AI.
- **Computer AI** (`bestMove`) is rule-based, not minimax: win-if-possible → block opponent → center → random corner → random cell. It reuses `WIN_LINES` via `findCompletingMove`. The CPU plays as `'O'` and moves on a `setTimeout` delay after the human's move.
- **Two modes** (2-player vs. computer) are toggled by `setMode()`, which also resets scores and the board.
