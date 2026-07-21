// server/scenarios/hardcore-logic.mjs
//
// 【自动生成 —— 勿手改】由 scripts/hardcore-logic-import.mjs 从 HuggingFace 生成。
// 生成时间：2026-06-25T05:53:09.718Z
// 来源：xhWu-fd/HardcoreLogic（HardcoreLogic 长尾逻辑谜题；论文 arXiv:2510.12563 / github.com/ljcleo/hardcore-logic）。
// 三档（HF config）即三档难度：baseline 原版 / hardcore 长尾变体硬题 / unsolvable 无解题（须答 solvable:false）。
// 覆盖游戏：二进制/扫雷/数独/卡库拉苏/数墙/摩天楼/寻路/密码算式/汉诺塔。
// 判分：scorer=structured（scoreStructuredMatch，JSON 拍平逐叶深比对；expected 为 {solvable,solution} 整体对象）。不引入 LLM 裁判。
// 用途：长尾逻辑谜题客观探针，主攻档位降级判别（声称高档却在长尾变体/无解题上崩）。默认关闭，
//      由 设置→场景测试题库「加入 HardcoreLogic」(settings.enableHardcoreLogic) 开启（见 server/scenarios/index.mjs）。
// 许可：导入时数据集卡未声明许可（上游代码仓库 MIT）；仅内置少量样题作研究评测，许可以上游为准。
// 刷新：重跑 scripts/hardcore-logic-import.mjs（--per-config 调量 / --probes 调采样广度）。

export const HARDCORE_LOGIC_SCENARIOS = [
  {
    "id": "hardcore-logic-base-binario-1",
    "name": "HardcoreLogic 二进制·原版 #1",
    "category": "hardcore-logic",
    "game": "Binario",
    "config": "baseline",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Puzzle to Solve\n\nA 4x4 binario puzzle is a cell grid with 4 rows and 4 columns.\nEach cell can either be `0` or `1`.\nThe goal is to fill all empty cells (denoted as `.`) with `0` or `1`.\nEach row must have the same number of `0`s and `1`s.\nEach column must have the same number of `0`s and `1`s.\nFurthermore, no more than two identical digits are adjacent.\n\n## Puzzle to Solve\n0 0 1 .\n0 0 . .\n1 1 0 0\n1 1 0 0\n\n# Instruction\n\nNow please solve the above star battle puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[_, _, _, _],\n[_, _, _, _],\n[_, _, _, _],\n[_, _, _, _]\n]\n}\n\nwhere each `_` represents the final element in the corresponding cell.\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": true,
      "solution": [
        [
          0,
          0,
          1,
          1
        ],
        [
          0,
          0,
          1,
          1
        ],
        [
          1,
          1,
          0,
          0
        ],
        [
          1,
          1,
          0,
          0
        ]
      ]
    },
    "source": "xhWu-fd/HardcoreLogic · baseline · enigmata--4x4-00"
  },
  {
    "id": "hardcore-logic-base-minesweeper-2",
    "name": "HardcoreLogic 扫雷·原版 #2",
    "category": "hardcore-logic",
    "game": "Minesweeper",
    "config": "baseline",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Puzzle to Solve\n\nA 9x9 minesweeper puzzle is a cell grid with 9 rows and 9 columns.\nEach cell has either one mine (mine cell) or no mine (safe cell).\nSome safe cells are opened beforehand, showing the number of\nmine cells in their 8-adjacent cells.\nThe goal is to find out all closed cells that must be mine cells.\nThe puzzle is unsolvable if and only if the current numbers lead to a contradiction.\n\n## Puzzle to Solve\n. 1 . . . . . . 0\n. . . 0 0 . 0 . 0\n. 2 . . . . . . .\n. 2 . . . 0 . . .\n. . . . 1 1 . . .\n. . . . 1 . 1 . .\n1 . 1 . . . 2 1 .\n2 . . . . 0 1 . .\n. . . 1 . 0 1 1 1\n\n# Instruction\n\nNow please solve the above minesweeper puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _]\n]\n}\n\nwhere each `_` represents whether the corresponding cell\n**must be a mine cell** (`true`) or safe/undetermined (`false`).\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": true,
      "solution": [
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          true,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          true,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ]
      ]
    },
    "source": "xhWu-fd/HardcoreLogic · baseline · enigmata--easy-00"
  },
  {
    "id": "hardcore-logic-base-sudoku-3",
    "name": "HardcoreLogic 数独·原版 #3",
    "category": "hardcore-logic",
    "game": "Sudoku",
    "config": "baseline",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Puzzle to Solve\n\nA(n) 9x9 sudoku puzzle is a cell grid with 9 rows and 9 columns.\nThe grid is divided into 9 zones, each with 9 cells, outlined with `@`.\nEach cell contains exactly one of the 9 candidate elements: `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`.\nThe goal is to fill all empty cells (denoted as `.`) with one of these elements.\nEach candidate element must appear exactly once in every row.\nEach candidate element must appear exactly once in every column.\nEach candidate element must appear exactly once in every zone.\n\n## Puzzle to Solve\n   a  b  c  d  e  f  g  h  i\n @@@@@@@@@@@@@@@@@@@@@@@@@@@@\na@ .  .  6@ 9  .  5@ 8  4  2@\n @        @        @        @\nb@ 5  1  9@ 2  4  8@ 3  7  .@\n @        @        @        @\nc@ 8  .  2@ .  7  3@ 5  .  .@\n @@@@@@@@@@@@@@@@@@@@@@@@@@@@\nd@ 2  3  7@ .  5  .@ 9  8  4@\n @        @        @        @\ne@ .  5  .@ 4  .  9@ 2  3  7@\n @        @        @        @\nf@ 9  .  4@ .  3  .@ 6  5  .@\n @@@@@@@@@@@@@@@@@@@@@@@@@@@@\ng@ 7  6  5@ 8  9  1@ 4  2  3@\n @        @        @        @\nh@ .  9  8@ 3  2  4@ 7  .  5@\n @        @        @        @\ni@ 4  2  .@ 5  6  .@ 1  9  .@\n @@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\n# Instruction\n\nNow please solve the above sudoku puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"],\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"],\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"],\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"],\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"],\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"],\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"],\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"],\n[\"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\", \"_\"]\n]\n}\n\nwhere each `_` represents the final element in the corresponding cell.\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": true,
      "solution": [
        [
          "3",
          "7",
          "6",
          "9",
          "1",
          "5",
          "8",
          "4",
          "2"
        ],
        [
          "5",
          "1",
          "9",
          "2",
          "4",
          "8",
          "3",
          "7",
          "6"
        ],
        [
          "8",
          "4",
          "2",
          "6",
          "7",
          "3",
          "5",
          "1",
          "9"
        ],
        [
          "2",
          "3",
          "7",
          "1",
          "5",
          "6",
          "9",
          "8",
          "4"
        ],
        [
          "6",
          "5",
          "1",
          "4",
          "8",
          "9",
          "2",
          "3",
          "7"
        ],
        [
          "9",
          "8",
          "4",
          "7",
          "3",
          "2",
          "6",
          "5",
          "1"
        ],
        [
          "7",
          "6",
          "5",
          "8",
          "9",
          "1",
          "4",
          "2",
          "3"
        ],
        [
          "1",
          "9",
          "8",
          "3",
          "2",
          "4",
          "7",
          "6",
          "5"
        ],
        [
          "4",
          "2",
          "3",
          "5",
          "6",
          "7",
          "1",
          "9",
          "8"
        ]
      ]
    },
    "source": "xhWu-fd/HardcoreLogic · baseline · enigmata-9x9--medium-26"
  },
  {
    "id": "hardcore-logic-base-kakurasu-4",
    "name": "HardcoreLogic 卡库拉苏·原版 #4",
    "category": "hardcore-logic",
    "game": "Kakurasu",
    "config": "baseline",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Example Puzzle\n\nA 4x4 kakurasu puzzle is a cell grid with 4 rows and 4 columns.\nRows are numbered 1 to 4 from top to bottom, and columns numbered 1 to 4 from left to right.\nThe goal is to mark cells as `O` to satisfy the following column and row constraints.\nOn top of the puzzle, a row of 4 numbers give the **column** constraints --- the row index sum of\nall cells **marked as `O`** in each column; a `-1` indicates that the column has no constraint.\nAt the beginning of each row, a number gives the **row** constraint --- the column index sum of\nall cells **marked as `O`** in the row; a `-1` indicates that the row has no constraint.\nThe initial grid consists of `.` and `X` cells, and only `.` cells can be marked as `O`;\n`X` cells **cannot** be marked as `O`.\n\n## Example Puzzle\n    1  3  2  5\n 5| .  .  .  .\n 3| .  .  .  .\n 2| .  .  .  .\n 4| .  .  .  .\n\n## Answer to the Example Puzzle\n[\n[true, false, false, true],\n[false, false, true, false],\n[false, true, false, false],\n[false, false, false, true]\n]\n\n### Explanation\nIn the first row, cells at columns 1 and 4 are marked as `O`,\nso the column index sum is 5, matching the row hint number.\nIn the second column, only the cell at row 3 is marked as `O`,\nso the row index sum is 3, matching the column hint number.\n\n# Puzzle to Solve\n\nA 6x6 kakurasu puzzle is a cell grid with 6 rows and 6 columns.\nRows are numbered 1 to 6, and columns numbered 1 to 6.\nThe goal is to mark cells to satisfy the following column and row constraints.\nOn top of the puzzle, a row of 6 numbers give the **column** constraints --- the row index sum of\nall cells **marked as `O`** in each column; a `-1` indicates that the column has no constraint.\nAt the beginning of each row, a number gives the **row** constraint --- the column index sum of\nall cells **marked as `O`** in the row; a `-1` indicates that the row has no constraint.\nThe initial grid consists of `.` and `X` cells, and only `.` cells can be marked as `O`;\n`X` cells **cannot** be marked as `O`.\n\n## Puzzle to Solve\n    3  0  7  8  6  7\n 3| .  .  .  .  .  .\n 3| .  .  .  .  .  .\n11| .  .  .  .  .  .\n 9| .  .  .  .  .  .\n 4| .  .  .  .  .  .\n 5| .  .  .  .  .  .\n\n# Instruction\n\nNow please solve the above kakurasu puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _]\n]\n}\n\nwhere each `_` represents whether the corresponding cell is\n**marked as `O`** (`true`) or not (`false`).\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": true,
      "solution": [
        [
          false,
          false,
          true,
          false,
          false,
          false
        ],
        [
          false,
          false,
          true,
          false,
          false,
          false
        ],
        [
          true,
          false,
          false,
          true,
          false,
          true
        ],
        [
          false,
          false,
          true,
          false,
          false,
          true
        ],
        [
          false,
          false,
          false,
          true,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          true,
          false
        ]
      ]
    },
    "source": "xhWu-fd/HardcoreLogic · baseline · enigmata--6x6-04"
  },
  {
    "id": "hardcore-logic-hard-hitori-5",
    "name": "HardcoreLogic 数墙·长尾 #5",
    "category": "hardcore-logic",
    "game": "Hitori",
    "config": "hardcore",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Example Puzzle\n\nA 3x3 hitori puzzle is a cell grid with 3 rows and 3 columns.\nThe goal is to erase certain cells so that the cells left in each row and in each column are unique.\nErased cells cannot be 4-adjacent, and **all** non-erased cells must be 4-connected.\nA braced cell (`{x}`) cannot be erased, and no more than 3 of its 8-adjacent cells can be erased.\n\n## Example Puzzle\n 1   1   3\n 1   2   3\n 2   3   3\n\n## Answer to the Example Puzzle\n[\n[true, false, true],\n[false, false, false],\n[false, false, true],\n]\n\n# Puzzle to Solve\n\nA 6x6 hitori puzzle is a cell grid with 6 rows and 6 columns.\nThe goal is to erase certain cells so that the cells left in each row and in each column are unique.\nErased cells cannot be 4-adjacent, and **all** non-erased cells must be 4-connected.\nA braced cell (`{x}`) cannot be erased, and no more than 3 of its 8-adjacent cells can be erased.\nWARNING: The puzzle is encrypted into letters!\nIn row i (from 1 to 6), a cell with number k now becomes `'A' + (i + k - 2) % 6`.\nFor example, in row 1 `1` becomes `A`, but in row 2 `1` becomes `B` and `6` becomes `A`.\nDecrypt the puzzle back to numbers before solving it.\n\n\n## Puzzle to Solve\n D   D   B   F   C   E \n C   B   D   F   D   E \n B   B   A   D   F   E \n D   F   C   A   C   E \n A   F   D   F   C   A \n E   C   B   A   F   D \n\n# Instruction\n\nNow please solve the above hitori puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _]\n]\n}\n\nwhere each `_` represents whether the corresponding cell is **erased** (`true`) or not (`false`).\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": true,
      "solution": [
        [
          true,
          false,
          false,
          false,
          false,
          true
        ],
        [
          false,
          false,
          true,
          false,
          true,
          false
        ],
        [
          true,
          false,
          false,
          true,
          false,
          false
        ],
        [
          false,
          false,
          true,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          true,
          false,
          true
        ],
        [
          false,
          true,
          false,
          false,
          false,
          false
        ]
      ]
    },
    "source": "xhWu-fd/HardcoreLogic · hardcore · gen-05--6x6-14"
  },
  {
    "id": "hardcore-logic-hard-skyscraper-6",
    "name": "HardcoreLogic 摩天楼·长尾 #6",
    "category": "hardcore-logic",
    "game": "Skyscraper",
    "config": "hardcore",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Example Puzzle\n\nA 4x4 skyscraper puzzle is a cell grid with 4 rows and 4 columns.\nEach cell contains exactly one of the numbers 1 to 4, representing the height of the cell.\nEach number must appear exactly once in every row and every column.\nLooking from a side, a cell in the front blocks **all** cells **behind** it that are **not taller**.\nThe hint of a row/column/diagonal looking from a side is the height sum of cells\nin the row/column/diagonal that are not blocked; a number of `-1` means no constraint.\nOn top of the puzzle, there is a row of 6 numbers:\nthe first number is the hint of the main diagonal looking from top left;\nthe next 4 numbers are the hints of the columns looking from the top;\nthe last number is the hint of the sub diagonal looking from top right.\nThen, at the beginning of each grid row is the hint of that row looking from the left;\nat the end of that row is the hint of that row looking from the right.\nFinally, below the puzzle, there is a row of 6 numbers:\nthe first number is the hint of the sub diagonal looking from bottom left;\nthe next 4 numbers are the hints of the columns looking from the bottom;\nthe last number is the hint of the main diagonal looking from bottom right.\n\n## Example Puzzle\n 7| 7  4  5  9| 6\n 7| .  .  .  .| 6\n 9| .  .  .  .| 5\n 4| .  .  .  .| 7\n10| .  .  .  .| 4\n 5| 5  9  7  4| 4\n\n## Answer to the Example Puzzle\n[\n[3, 4, 1, 2],\n[2, 3, 4, 1],\n[4, 1, 2, 3],\n[1, 2, 3, 4]\n]\n\n### Explanation\nLooking at the second row from the left, we can see 2, 3 and 4, matching the hint number `9=2+3+4` on its left side.\nFrom the right we can see 1 and 4, matching the hint number `5=1+4` on its right side.\nLooking at the second column from the top, we can only see 4, matching the hint number 4 at its top.\nFrom the bottom we can see 2, 3 and 4, matching the hint number `9=2+3+4` at its bottom.\nLooking at the main diagonal from top left, we can see 3 and 4 (the second 3 is blocked), matching the hint number `7=3+4` at its top left.\nFrom bottom right, we can only see 4, matching the hint number 4 at its bottom right.\n\n# Puzzle to Solve\n\nA 5x5 skyscraper puzzle is a cell grid with 5 rows and 5 columns.\nEach cell contains exactly one of the numbers 1 to 5, representing the \"height\" of the cell.\nEach number must appear exactly once in every row and every column.\nLooking from a side, a cell in the front blocks **all** cells **behind** it that are **not taller**.\nThe hint of a row/column/diagonal looking from a side is the height sum of cells\nin the row/column/diagonal that are not blocked; a number of `-1` means no constraint.\nOn top of the puzzle, there is a row of 7 numbers:\nthe first number is the hint of the main diagonal looking from top left;\nthe next 5 numbers are the hints of the columns looking from the top;\nthe last number is the hint of the sub diagonal looking from top right.\nThen, at the beginning of each grid row is the hint of that row looking from the left;\nat the end of that row is the hint of that row looking from the right.\nFinally, below the puzzle, there is a row of 7 numbers:\nthe first number is the hint of the sub diagonal looking from bottom left;\nthe next 5 numbers are the hints of the columns looking from the bottom;\nthe last number is the hint of the main diagonal looking from bottom right.\n\n## Puzzle to Solve\n-1|-1  5 -1 14  8|-1\n 6| .  .  .  .  .|12\n-1| .  .  .  .  .|-1\n14| .  .  .  .  .| 5\n12| .  .  .  .  .| 6\n 5| .  .  .  .  .| 9\n-1|-1 -1 -1  6  9|-1\n\n# Instruction\n\nNow please solve the above skyscraper puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[_, _, _, _, _],\n[_, _, _, _, _],\n[_, _, _, _, _],\n[_, _, _, _, _],\n[_, _, _, _, _]\n]\n}\n\nwhere each `_` represents the final number in the corresponding cell.\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": true,
      "solution": [
        [
          1,
          5,
          4,
          2,
          3
        ],
        [
          4,
          1,
          5,
          3,
          2
        ],
        [
          2,
          3,
          1,
          4,
          5
        ],
        [
          3,
          4,
          2,
          5,
          1
        ],
        [
          5,
          2,
          3,
          1,
          4
        ]
      ]
    },
    "source": "xhWu-fd/HardcoreLogic · hardcore · gen-03-sum--5x5-029"
  },
  {
    "id": "hardcore-logic-hard-binario-7",
    "name": "HardcoreLogic 二进制·长尾 #7",
    "category": "hardcore-logic",
    "game": "Binario",
    "config": "hardcore",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Puzzle to Solve\n\nA 6x6 binario puzzle is a cell grid with 6 rows and 6 columns.\nEach cell can either be `0` or `1`.\nThe goal is to fill all empty cells (denoted as `.`) with `0` or `1`.\nEach row must have the same number of `0`s and `1`s.\nEach column must have the same number of `0`s and `1`s.\nFurthermore, no more than two identical digits are adjacent.\n\n## Puzzle to Solve\n. . . 1 1 .\n0 . . . . .\n. . . . . .\n0 . . 0 0 .\n0 . . 0 . .\n. . . . 1 .\n\n# Instruction\n\nNow please solve the above star battle puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _]\n]\n}\n\nwhere each `_` represents the final element in the corresponding cell.\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": true,
      "solution": [
        [
          1,
          0,
          0,
          1,
          1,
          0
        ],
        [
          0,
          1,
          1,
          0,
          0,
          1
        ],
        [
          1,
          0,
          0,
          1,
          1,
          0
        ],
        [
          0,
          1,
          1,
          0,
          0,
          1
        ],
        [
          0,
          1,
          1,
          0,
          0,
          1
        ],
        [
          1,
          0,
          0,
          1,
          1,
          0
        ]
      ]
    },
    "source": "xhWu-fd/HardcoreLogic · hardcore · gen-01--6x6-851"
  },
  {
    "id": "hardcore-logic-hard-minesweeper-8",
    "name": "HardcoreLogic 扫雷·长尾 #8",
    "category": "hardcore-logic",
    "game": "Minesweeper",
    "config": "hardcore",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Puzzle to Solve\n\nA 9x9 minesweeper puzzle is a cell grid with 9 rows and 9 columns.\nEach cell has either one mine (mine cell) or no mine (safe cell).\nSome safe cells are opened beforehand, showing the number of\nmine cells in their 8-adjacent cells.\nThe goal is to find out all closed cells that must be mine cells.\nThe puzzle is unsolvable if and only if the current numbers lead to a contradiction.\nEXTRA: The puzzle is encrypted into letters, where Z represents 0 and A-H represents 1-8.\n\n## Puzzle to Solve\n. . . . D . . . .\n. . . . . . . . .\n. . C C . . C A .\n. C B A . C . . .\n. C . . Z . . . .\n. . . . Z . . . .\n. . . . . . . . .\n. D . . A . . . .\n. . . . . . A . A\n\n# Instruction\n\nNow please solve the above minesweeper puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _],\n[_, _, _, _, _, _, _, _, _]\n]\n}\n\nwhere each `_` represents whether the corresponding cell\n**must be a mine cell** (`true`) or safe/undetermined (`false`).\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": true,
      "solution": [
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          true,
          true,
          true,
          true,
          false,
          false,
          false
        ],
        [
          false,
          true,
          false,
          false,
          false,
          true,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          true,
          false,
          false
        ],
        [
          false,
          false,
          true,
          false,
          false,
          false,
          true,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false
        ]
      ]
    },
    "source": "xhWu-fd/HardcoreLogic · hardcore · gen-03-letter--medium-48"
  },
  {
    "id": "hardcore-logic-unsolv-navigation-9",
    "name": "HardcoreLogic 寻路·无解 #9",
    "category": "hardcore-logic",
    "game": "Navigation",
    "config": "unsolvable",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Puzzle to Solve\n\nThere is a city with various landmarks.\nThe start point is store O.\nThe landmarks include: store O, school M, stadium P, school C, bank E, house H, school A.\nThere is a road which is 500 meters long from bank E to house H.\nThere is a road which is 200 meters long from bank E to stadium P.\nThere is a road which is 400 meters long from store O to house H.\nAll roads are one-way.\n\n## Query:\nFrom the start point, how to reach the nearest school in the shortest way?\n\n# Instruction\n\nNow please solve the above puzzle.\nIf there is no path, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\"_\", ...]\n}\n\nwhere each `\"_\"` represents a point on the path (an uppercase letter),\nincluding the start point and the end point.\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": false,
      "solution": null
    },
    "source": "xhWu-fd/HardcoreLogic · unsolvable · unsolvable--medium-012"
  },
  {
    "id": "hardcore-logic-unsolv-crypto-10",
    "name": "HardcoreLogic 密码算式·无解 #10",
    "category": "hardcore-logic",
    "game": "Crypto",
    "config": "unsolvable",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Puzzle to Solve\n\nAn uppercase ASCII text is encrypted into a cipher.\nThe goal is to recover the plain text, which may or may not have semantic meanings.\nA list of candidate encryption methods may be provided, one method per line,\nin which case the encryption is done by applying each method once sequentially\n, but NOT necessarily in the given order.\nSample plain text-cipher pairs that use the same encryption procedure may also be given as a hint.\nWhen \"|\" appears in the cipher, the encryption is segmented,\nwhere each encryption method consist of multiple sub-methods concatenated with \"+\" in one line,\neach applied to the corresponding cipher segment separated by \"|\".\n\n## Cipher to Solve\n\nCandidate methods:\n- columnar_transposition\n- rail_fence\n\nEncryption sample:\n- XVLTNVVCT -> LVTVNCXTV\n- TSOQOCJQUXQQCECTYHOV -> TOOJUQCCYOSQCQXQETHV\n\nCipher: KEKXCTLEBLQLLDZVEZBU\n\n# Instruction\n\nNow please recover the above cipher.\nIf the cipher cannot be recovered, e.g. there is a contradiction in the clues,\noutput `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": ['_','_',...]\n}\n\nwhere `\"_\"` represents the plain text string in uppercase.\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": false,
      "solution": null
    },
    "source": "xhWu-fd/HardcoreLogic · unsolvable · unsolvable--all-693"
  },
  {
    "id": "hardcore-logic-unsolv-hanoi-11",
    "name": "HardcoreLogic 汉诺塔·无解 #11",
    "category": "hardcore-logic",
    "game": "Hanoi",
    "config": "unsolvable",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Example Puzzle\n\nA 3x3 hanoi puzzle has 3 pegs and 3 disks.\nThe disks, in the order of size, are: (smallest) `1`, `2`, `3` (largest).\nThe goal is to transform the start state to the goal state in minimum number of steps.\nEach step moves a disk on top of a peg to another peg that is either empty,\nor whose current top disk is larger than the moved disk.\nFurthermore, the target peg must be to the right of the source peg.\n\n## Example Puzzle\nStart (bottom -> top):\nA | 2 1\nB |\nC | 3\nGoal (bottom -> top):\nA |\nB |\nC | 3 2 1\n\n## Answer to the Example Puzzle\n[\n[\"A\", \"B\"], [\"A\", \"C\"], [\"B\", \"C\"]\n]\n\n### Explanation\nThe first step moves the top disk of peg A (`1`) to peg B,\nwhich is valid because peg B is empty. The new state is:\nA | 2\nB | 1\nC | 3\nThe second step moves the top disk of peg A (`2`) to peg C,\nwhich is valid because disk `2` is smaller than disk `3`. The new state is:\nA |\nB | 1\nC | 3 2\nThe second step moves the top disk of peg B (`1`) to peg C,\nwhich is valid because disk `1` is smaller than disk `2`. The new state is:\nA |\nB |\nC | 3 2 1\nwhich is the goal state.\n\n# Puzzle to Solve\n\nA 3x3 hanoi puzzle has 3 pegs and 3 disks.\nThe disks, in the order of size, are: (smallest) `1`, `2`, `3` (largest).\nThe goal is to transform the start state to the goal state in minimum number of steps.\nEach step moves a disk on top of a peg to another peg that is either empty,\nor whose current top disk is larger than the moved disk.\nFurthermore, the target peg must be to the right of the source peg.\n\n## Puzzle to Solve\nStart (bottom -> top):\nA | 3 2 1\nB |\nC |\nGoal (bottom -> top):\nA |\nB |\nC | 3 2 1\n\n# Instruction\n\nNow please solve the above hanoi puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[\"_\", \"_\"], ...\n]\n}\n\nwhere each `[\"_\", \"_\"]` pair represents the source peg and the target peg of a disk-moving step.\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": false,
      "solution": null
    },
    "source": "xhWu-fd/HardcoreLogic · unsolvable · unsolvable-ri--small-007"
  },
  {
    "id": "hardcore-logic-unsolv-binario-12",
    "name": "HardcoreLogic 二进制·无解 #12",
    "category": "hardcore-logic",
    "game": "Binario",
    "config": "unsolvable",
    "difficulty": "hard",
    "maxTokens": 8192,
    "prompt": "# Puzzle to Solve\n\nA 6x6 binario puzzle is a cell grid with 6 rows and 6 columns.\nEach cell can either be `0` or `1`.\nThe goal is to fill all empty cells (denoted as `.`) with `0` or `1`.\nEach row must have the same number of `0`s and `1`s.\nEach column must have the same number of `0`s and `1`s.\nFurthermore, no more than two identical digits are adjacent.\n\n## Puzzle to Solve\n0 . . . . 0\n0 . . 0 . 0\n. . 1 . . .\n0 . . . . 0\n. . . 1 . .\n. . . 1 . .\n\n# Instruction\n\nNow please solve the above star battle puzzle.\nIf the puzzle is unsolvable, output `null` as the solution in the following json format:\n\n{\n\"solvable\": false,\n\"solution\": null\n}\n\nOtherwise, present your solution in the following json format:\n\n{\n\"solvable\": true,\n\"solution\": [\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _],\n[_, _, _, _, _, _]\n]\n}\n\nwhere each `_` represents the final element in the corresponding cell.\n\n---\nKeep your reasoning brief (a few sentences at most) so your output is not cut off, then output ONLY the JSON object described above as the very last thing you output.",
    "scorer": "structured",
    "expected": {
      "solvable": false,
      "solution": null
    },
    "source": "xhWu-fd/HardcoreLogic · unsolvable · unsolvable--6x6-063"
  }
];
