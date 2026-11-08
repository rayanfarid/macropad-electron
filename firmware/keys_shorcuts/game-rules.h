#pragma once

#include <stdint.h>

// Small, platform-independent Tic-Tac-Toe rules shared by firmware and tests.
inline uint8_t tttCellForSwitch(uint8_t switchNumber) {
  return (switchNumber >= 1 && switchNumber <= 9) ? (uint8_t)(switchNumber - 1) : 0xFF;
}

inline bool tttPlaceMark(char board[9], uint8_t cell, char mark) {
  if (cell >= 9 || (mark != 'X' && mark != 'O') || board[cell] != 0) return false;
  board[cell] = mark;
  return true;
}

inline char tttGetResult(const char board[9]) {
  static const uint8_t lines[8][3] = {
    {0,1,2}, {3,4,5}, {6,7,8}, {0,3,6},
    {1,4,7}, {2,5,8}, {0,4,8}, {2,4,6}
  };
  for (uint8_t i = 0; i < 8; ++i) {
    const char mark = board[lines[i][0]];
    if (mark && mark == board[lines[i][1]] && mark == board[lines[i][2]]) return mark;
  }
  for (uint8_t i = 0; i < 9; ++i) if (!board[i]) return 0;
  return 'D';
}

inline bool tttPlaySwitch(char board[9], uint8_t switchNumber, char* nextMark, char* result) {
  if (!nextMark || !result || *result) return false;
  const uint8_t cell = tttCellForSwitch(switchNumber);
  if (!tttPlaceMark(board, cell, *nextMark)) return false;
  *result = tttGetResult(board);
  if (!*result) *nextMark = (*nextMark == 'X') ? 'O' : 'X';
  return true;
}
