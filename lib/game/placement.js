import { boardCellAt } from "./board.js";

export function homeInfoForSeat(board, seat) {
	switch (seat) {
		case "N":
			return {
				minR: 0,  maxR: 5,  minC: 6,  maxC: 10,
				orientation: "row",
				frontRow: 5,
				mineRows: [0, 1],
				hqRow: 0, hqCols: [7, 9]
			};
		case "S":
			return {
				minR: 11, maxR: 16, minC: 6,  maxC: 10,
				orientation: "row",
				frontRow: 11,
				mineRows: [15, 16],
				hqRow: 16, hqCols: [7, 9]
			};
		case "W":
			return {
				minR: 6,  maxR: 10, minC: 0,  maxC: 5,
				orientation: "col",
				frontCol: 5,
				mineCols: [0, 1],
				hqCol: 0, hqRows: [7, 9]
			};
		case "E":
			return {
				minR: 6,  maxR: 10, minC: 11, maxC: 16,
				orientation: "col",
				frontCol: 11,
				mineCols: [15, 16],
				hqCol: 16, hqRows: [7, 9]
			};
		default:
			return null;
	}
}

export function isHQCell(board, seat, pos) {
	const info = homeInfoForSeat(board, seat);
	if (!info) return false;
	const cell = boardCellAt(board, pos);
	if (!cell || cell.type !== "hq") return false;
	if (info.orientation === "row") {
		return pos.r === info.hqRow && info.hqCols.includes(pos.c);
	}
	return pos.c === info.hqCol && info.hqRows.includes(pos.r);
}

export function validatePlacement(room, piece, player) {
	if (!player.seat) return false;
	const pos = piece.pos;
	if (!pos) return true;
	const info = homeInfoForSeat(room.board, player.seat);
	if (!info) return false;

	if (pos.r < info.minR || pos.r > info.maxR || pos.c < info.minC || pos.c > info.maxC) return false;

	const cell = boardCellAt(room.board, pos);
	if (!cell || cell.type === "inactive") return false;

	if (cell.type === "camp") return false;

	if (info.orientation === "row") {
		if (piece.type === "bomb" && pos.r === info.frontRow) return false;
		if (piece.type === "mine" && !info.mineRows.includes(pos.r)) return false;
	} else {
		if (piece.type === "bomb" && pos.c === info.frontCol) return false;
		if (piece.type === "mine" && !info.mineCols.includes(pos.c)) return false;
	}

	if (piece.type === "flag") {
		if (!isHQCell(room.board, player.seat, pos)) return false;
	}
	return true;
}
