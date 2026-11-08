const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildGameCommand } = require("../serial-protocol");

const firmware = fs.readFileSync(path.join(__dirname, "../firmware/keys_shorcuts/keys_shorcuts.ino"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "../src/renderer.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");

test("desktop game commands use only the explicit firmware GAME protocol", () => {
  assert.equal(buildGameCommand({ action: "menu" }), "GAME START MENU");
  assert.equal(buildGameCommand({ action: "start", game: "snake" }), "GAME START SNAKE");
  assert.equal(buildGameCommand({ action: "start", game: "ttt" }), "GAME START TTT");
  assert.equal(buildGameCommand({ action: "start", game: "pong" }), "GAME START PONG");
  assert.equal(buildGameCommand({ action: "start", game: "2048" }), "GAME START 2048");
  assert.equal(buildGameCommand({ action: "start", game: "minesweeper" }), "GAME START MINESWEEPER");
  assert.equal(buildGameCommand({ action: "start", game: "memory" }), "GAME START MEMORY");
  assert.equal(buildGameCommand({ action: "start", game: "simon" }), "GAME START SIMON");
  assert.equal(buildGameCommand({ action: "start", game: "lightsout" }), "GAME START LIGHTS_OUT");
  assert.equal(buildGameCommand({ action: "start", game: "whack" }), "GAME START WHACK");
  assert.equal(buildGameCommand({ action: "exit" }), "GAME EXIT");
  assert.equal(buildGameCommand({ action: "status" }), "GAME STATUS");
  assert.throws(() => buildGameCommand({ action: "start", game: "arbitrary" }), /Unsupported/);
  assert.throws(() => buildGameCommand("GAME EXIT"), /invalid/);
});

test("firmware game mode intercepts encoder before normal consumer actions", () => {
  const encoder = firmware.slice(firmware.indexOf("void onEncoderShortPress()"), firmware.indexOf("void onEncoderLongPress()"));
  const rotation = firmware.slice(firmware.indexOf("void pollEncoderPosition()"), firmware.indexOf("// ---------- Commands"));
  assert.match(encoder, /if \(gameScreen != GAME_OFF\) \{ routeGameInput\(GAME_SELECT\); return; \}/);
  assert.match(rotation, /if \(gameScreen != GAME_OFF\)[\s\S]*?routeGameInput\(d > 0 \? GAME_RIGHT : GAME_LEFT\);[\s\S]*?return;/);
  assert.match(firmware, /enum GameInputEvent : uint8_t \{ GAME_LEFT, GAME_RIGHT, GAME_SELECT \}/);
  assert.match(firmware, /void routeGameInput\(uint8_t event\)/);
  assert.match(rotation, /for \(int32_t i = 0; i < n; i\+\+\) fireSlot\(slot\);/);
});

test("firmware games run locally and include all nine games", () => {
  assert.match(firmware, /if \(gameScreen != GAME_OFF\) \{[\s\S]*?drawGamesScreen\(\);[\s\S]*?return;/);
  assert.match(firmware, /void updateSnakeGame\(\)/);
  assert.doesNotMatch(firmware, /playTicTacToeComputer|tttComputerTurn/);
  assert.match(firmware, /void updatePongGame\(\)/);
  assert.match(firmware, /const int8_t serveDirection = pongBallX < 0 \? -2 : 2/);
  assert.match(firmware, /bool move2048\(\)/);
  assert.match(firmware, /void startMinesGame\(\)/);
  assert.match(firmware, /void startMemoryGame\(\)/);
  assert.match(firmware, /uint8_t deck\[8\] = \{1,1,2,2,3,3,4,4\}/);
  assert.match(firmware, /void startSimonGame\(\)/);
  assert.match(firmware, /void startLightsGame\(\)/);
  assert.match(firmware, /void startWhackGame\(\)/);
  assert.match(firmware, /void gameEncoderSelect\(\)/);
  assert.match(firmware, /const uint8_t GAME_COUNT = 9/);
  assert.match(firmware, /"SNAKE", "TIC TAC TOE", "PONG", "2048", "MINESWEEPER"[\s\S]*"WHACK-A-MOLE"/);
  assert.match(firmware, /GAME START MENU\|SNAKE\|TTT\|PONG\|2048\|MINESWEEPER\|MEMORY\|SIMON\|LIGHTS_OUT\|WHACK/);
  assert.match(firmware, /if \(key == 7\)[\s\S]*?if \(gameScreen == GAME_MENU\) exitGameMode\(\)/);
  assert.match(firmware, /for \(uint8_t row = 0; row < 3; \+\+row\)/);
});

test("Tic-Tac-Toe uses all nine switches as a two-player board, not game navigation", () => {
  assert.match(firmware, /gameScreen == GAME_TTT \|\| gameScreen == GAME_MINES/);
  assert.match(firmware, /if \(pressed\) gameSwitchPress\(key\)/);
  assert.match(firmware, /tttPlaySwitch\(tttBoard, key, &tttNextPlayer, &tttResult\)/);
  assert.match(firmware, /gameScreen == GAME_TTT \/\*|gameScreen == GAME_TTT && tttResult/);
  assert.match(firmware, /GAME_TTT is switch-driven; encoder rotation is deliberately ignored/);
  assert.match(firmware, /if \(gameScreen != GAME_OFF\) \{\s*for \(int32_t i = 0; i < n; i\+\+\) routeGameInput[\s\S]*?return;/);
  assert.match(firmware, /for \(int32_t i = 0; i < n; i\+\+\) fireSlot\(slot\)/);
});

test("shared TTT rules encode switch mapping, turn alternation, occupied rejection, eight wins and draw", () => {
  const rules = fs.readFileSync(path.join(__dirname, "../firmware/keys_shorcuts/game-rules.h"), "utf8");
  assert.match(rules, /switchNumber - 1/);
  assert.match(rules, /board\[cell\] != 0/);
  assert.match(rules, /\{0,1,2\}, \{3,4,5\}, \{6,7,8\}, \{0,3,6\}/);
  assert.match(rules, /\{1,4,7\}, \{2,5,8\}, \{0,4,8\}, \{2,4,6\}/);
  assert.match(rules, /return 'D'/);
  assert.match(rules, /\*nextMark = \(\*nextMark == 'X'\) \? 'O' : 'X'/);
});

test("renderer sends device commands and contains no desktop game loop", () => {
  assert.match(html, /Games run on the Macropad/);
  assert.match(renderer, /sendGameCommand\(payload\)/);
  assert.match(renderer, /GAME STATE/);
  assert.doesNotMatch(html, /games\/(?:snake|tic-tac-toe|game-manager)\.js/);
  assert.doesNotMatch(renderer, /requestAnimationFrame|setInterval\(/);
});
