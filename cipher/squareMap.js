// ═══════════════════════════════════════════════════════════════════════════
// Square → pixel coordinate map (white orientation, step = 73px default)
// Generated from: X = fileIndex * step, Y = (8 - rank) * step
// ═══════════════════════════════════════════════════════════════════════════

const SQUARE_MAP_DEFAULT = {
  a1:{x:0,y:511},   b1:{x:73,y:511},  c1:{x:146,y:511}, d1:{x:219,y:511},
  e1:{x:292,y:511}, f1:{x:365,y:511}, g1:{x:438,y:511}, h1:{x:511,y:511},
  a2:{x:0,y:438},   b2:{x:73,y:438},  c2:{x:146,y:438}, d2:{x:219,y:438},
  e2:{x:292,y:438}, f2:{x:365,y:438}, g2:{x:438,y:438}, h2:{x:511,y:438},
  a3:{x:0,y:365},   b3:{x:73,y:365},  c3:{x:146,y:365}, d3:{x:219,y:365},
  e3:{x:292,y:365}, f3:{x:365,y:365}, g3:{x:438,y:365}, h3:{x:511,y:365},
  a4:{x:0,y:292},   b4:{x:73,y:292},  c4:{x:146,y:292}, d4:{x:219,y:292},
  e4:{x:292,y:292}, f4:{x:365,y:292}, g4:{x:438,y:292}, h4:{x:511,y:292},
  a5:{x:0,y:219},   b5:{x:73,y:219},  c5:{x:146,y:219}, d5:{x:219,y:219},
  e5:{x:292,y:219}, f5:{x:365,y:219}, g5:{x:438,y:219}, h5:{x:511,y:219},
  a6:{x:0,y:146},   b6:{x:73,y:146},  c6:{x:146,y:146}, d6:{x:219,y:146},
  e6:{x:292,y:146}, f6:{x:365,y:146}, g6:{x:438,y:146}, h6:{x:511,y:146},
  a7:{x:0,y:73},    b7:{x:73,y:73},   c7:{x:146,y:73},  d7:{x:219,y:73},
  e7:{x:292,y:73},  f7:{x:365,y:73},  g7:{x:438,y:73},  h7:{x:511,y:73},
  a8:{x:0,y:0},     b8:{x:73,y:0},    c8:{x:146,y:0},   d8:{x:219,y:0},
  e8:{x:292,y:0},   f8:{x:365,y:0},   g8:{x:438,y:0},   h8:{x:511,y:0},
};

/**
 * Build a square→coords map dynamically from the live board size.
 * Falls back to SQUARE_MAP_DEFAULT if the board element isn't found/sized.
 * @returns {{ [square: string]: { x: number, y: number } }}
 */
function buildSquareMap() {
  const FILES = 'abcdefgh';
  const board = document.querySelector('cg-board');
  let step = 73; // default

  if (board) {
    const size = board.getBoundingClientRect().width;
    if (size > 0) step = size / 8;
  }

  const map = {};
  for (let fi = 0; fi < 8; fi++) {
    for (let rank = 1; rank <= 8; rank++) {
      const sq = FILES[fi] + rank;
      map[sq] = {
        x: Math.round(fi * step),
        y: Math.round((8 - rank) * step),
      };
    }
  }
  // Log every square one by one: a1 → h8
  for (let fi = 0; fi < 8; fi++) {
    for (let rank = 1; rank <= 8; rank++) {
      const sq = FILES[fi] + rank;
    }
  }

  return map;
}
