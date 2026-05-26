import { boardCellAt } from "./board.js";
import { isValidRailwayMove, isValidRoadStep } from "./movement.js";
import { homeInfoForSeat } from "./placement.js";
import { pieceAt, teamOf } from "./state.js";

/** Railway junction cells where pieces often get stuck (add 1 to HQ distance). */
const RAILWAY_TRAP_PENALTY = new Set([
	"7,5",
	"9,5",
	"7,11",
	"9,11",
	"5,7",
	"5,9",
	"11,7",
	"11,9"
]);

/** Enemy seats to target in order (2v2 bot advances one opponent at a time). */
const ENEMY_SEAT_ORDER = {
	N: ["W", "E"],
	S: ["W", "E"],
	E: ["N", "S"],
	W: ["N", "S"]
};

function hqCellsForSeat(board, seat) {
	const info = homeInfoForSeat(board, seat);
	if (!info) return [];
	if (info.orientation === "row") {
		return info.hqCols.map((c) => ({ r: info.hqRow, c }));
	}
	return info.hqRows.map((r) => ({ r, c: info.hqCol }));
}

/** Uncaptured enemy HQ cells in attack order; empty when both opponents are eliminated. */
export function enemyHqTargetsForSeat(room, seat) {
	if (room.gameMode !== "2v2") return [];
	const targets = [];
	for (const enemySeat of ENEMY_SEAT_ORDER[seat] ?? []) {
		if (room.eliminatedSeats?.has(enemySeat)) continue;
		targets.push(...hqCellsForSeat(room.board, enemySeat));
	}
	return targets;
}

function isEnemySeat(room, seat, other) {
	if (!other || other === seat) return false;
	if (room.gameMode === "2v2") return teamOf(room, seat) !== teamOf(room, other);
	return other !== seat;
}

/**
 * Legal play moves for a seat (same rules applyMove enforces, without mutating).
 * With biasToEnemyHq, prefers captures then cells closer to enemy HQ (2v2 smoke bot).
 */
export function findLegalPlayMoves(room, seat, { limit = 64, biasToEnemyHq = false } = {}) {
	const playerId = room.seatToPlayerId.get(seat);
	if (!playerId) return [];

	const primaryHq = biasToEnemyHq ? (enemyHqTargetsForSeat(room, seat)[0] ?? null) : null;
	const distToEnemy = (r, c) => {
		if (!primaryHq) return 0;
		const manhattan = Math.abs(primaryHq.r - r) + Math.abs(primaryHq.c - c);
		const trapPenalty = RAILWAY_TRAP_PENALTY.has(`${r},${c}`) ? 1 : 0;
		return manhattan + trapPenalty;
	};

	const moves = [];
	for (const piece of room.pieces.values()) {
		if (piece.ownerId !== playerId || !piece.pos || piece.alive === false) continue;
		if (piece.type === "flag" || piece.type === "mine") continue;

		const from = piece.pos;
		if (boardCellAt(room.board, from)?.type === "hq") continue;
		for (const cell of room.board.cells) {
			if (cell.type === "inactive" || cell.type === "railonly") continue;
			const to = { r: cell.r, c: cell.c };
			if (to.r === from.r && to.c === from.c) continue;
			if (cell.type === "mountain" && piece.type !== "engineer") continue;

			if (!isValidRoadStep(room, from, to) && !isValidRailwayMove(room, piece, from, to)) {
				continue;
			}

			const occupant = pieceAt(room, to);
			if (occupant) {
				const targetSeat = room.players.get(occupant.ownerId)?.seat;
				if (!isEnemySeat(room, seat, targetSeat)) continue;
				if (cell.type === "camp") continue;
			}

			const capture = Boolean(occupant);
			const score = biasToEnemyHq
				? (capture ? 1000 : 0) - distToEnemy(to.r, to.c)
				: capture
					? 1
					: 0;
			moves.push({ pieceId: piece.id, from, to, score, capture });
		}
	}

	if (biasToEnemyHq || moves.some((m) => m.capture)) {
		moves.sort((a, b) => b.score - a.score);
	}
	return moves.slice(0, limit).map(({ pieceId, to }) => ({ pieceId, to }));
}
